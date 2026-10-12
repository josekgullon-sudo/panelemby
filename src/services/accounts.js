// Lógica de negocio: altas, renovaciones y créditos.
// Regla de oro: cualquier operación que toque créditos + BD va en una
// transacción SQLite. Las llamadas externas van antes. Si la BD falla tras
// crear algo fuera, se compensa. Si un servicio posterior falla (XUI creado
// y Max Player no), la fila se guarda con el id que sí existe y un error
// para poder reintentar sin volver a cobrar.

const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db/database');
const secret = require('./secret');

const integrations = { emby: null, xui: null, maxplayer: null };

function E() {
  return integrations.emby || require('./emby');
}
function X() {
  return integrations.xui || require('./xui');
}
function M() {
  return integrations.maxplayer || require('./maxplayer');
}

function setIntegrations(next) {
  if (!next) return;
  if (Object.prototype.hasOwnProperty.call(next, 'emby')) integrations.emby = next.emby;
  if (Object.prototype.hasOwnProperty.call(next, 'xui')) integrations.xui = next.xui;
  if (Object.prototype.hasOwnProperty.call(next, 'maxplayer')) integrations.maxplayer = next.maxplayer;
}

class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
  }
}

function isUserFacingError(err) {
  return !!err && ['BusinessError', 'EmbyError', 'XuiError', 'MaxPlayerError'].includes(err.name);
}

// --- Fechas (se guardan como ISO UTC 'YYYY-MM-DD HH:MM:SS', igual que datetime('now')) ---

function toSqlDate(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function parseSqlDate(text) {
  return new Date(text.replace(' ', 'T') + 'Z');
}

function daysLeft(expiresAt) {
  const ms = parseSqlDate(expiresAt).getTime() - Date.now();
  return Math.ceil(ms / (24 * 3600 * 1000));
}

function unixSeconds(sqlDate) {
  return Math.floor(parseSqlDate(sqlDate).getTime() / 1000);
}

// Duración legible: los planes guardan días (pueden ser fracciones para demos por horas).
function formatDuration(days) {
  if (days < 1) {
    const h = Math.round(days * 24);
    return `${h} hora${h === 1 ? '' : 's'}`;
  }
  if (days % 30 === 0 && days >= 60) return `${days / 30} meses`;
  const d = Math.round(days * 10) / 10;
  return `${d} día${d === 1 ? '' : 's'}`;
}

// --- Créditos ---

// Descuenta créditos de un reseller y registra el movimiento. SIEMPRE dentro de una transacción.
function deductCredits(resellerId, amount, reason, accountId, performedBy) {
  const result = db
    .prepare('UPDATE panel_users SET credits = credits - ? WHERE id = ? AND credits >= ?')
    .run(amount, resellerId, amount);
  if (result.changes === 0) {
    throw new BusinessError('Créditos insuficientes');
  }
  const { credits } = db.prepare('SELECT credits FROM panel_users WHERE id = ?').get(resellerId);
  db.prepare(
    `INSERT INTO credit_transactions (reseller_id, amount, balance_after, reason, account_id, performed_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(resellerId, -amount, credits, reason, accountId, performedBy);
}

// Recarga (o ajuste negativo) de créditos por parte del admin.
const addCredits = db.transaction((resellerId, amount, adminId) => {
  const reseller = db
    .prepare("SELECT * FROM panel_users WHERE id = ? AND role = 'reseller'")
    .get(resellerId);
  if (!reseller) throw new BusinessError('Reseller no encontrado');
  if (amount < 0 && reseller.credits + amount < 0) {
    throw new BusinessError('El ajuste dejaría el saldo en negativo');
  }
  db.prepare('UPDATE panel_users SET credits = credits + ? WHERE id = ?').run(amount, resellerId);
  db.prepare(
    `INSERT INTO credit_transactions (reseller_id, amount, balance_after, reason, account_id, performed_by)
     VALUES (?, ?, ?, ?, NULL, ?)`
  ).run(resellerId, amount, reseller.credits + amount, amount >= 0 ? 'recharge' : 'adjustment', adminId);
});

// --- Caducidad: qué se aplica en la Policy de Emby según el modo ---
// disable  -> la cuenta no puede iniciar sesión
// vitrina  -> puede entrar, pero solo ve la biblioteca-cartel (config.expiryLibrary)

let showcaseLibraryIdCache = null;

async function showcaseLibraryId() {
  if (showcaseLibraryIdCache) return showcaseLibraryIdCache;
  const raw = await E().getVirtualFolders();
  const libs = Array.isArray(raw) ? raw : raw.Items || [];
  const lib = libs.find((l) => l.Name === config.expiryLibrary);
  if (!lib) {
    throw new BusinessError(
      `No existe en Emby ninguna biblioteca llamada "${config.expiryLibrary}" (revisa EXPIRY_LIBRARY en el .env)`
    );
  }
  // Emby filtra las vistas por el Guid de la biblioteca, no por el ItemId numérico.
  showcaseLibraryIdCache = lib.Guid || lib.ItemId || lib.Id;
  return showcaseLibraryIdCache;
}

async function expiredPolicyPatch() {
  if (config.expiryMode !== 'vitrina') return { IsDisabled: true };
  return { EnableAllFolders: false, EnabledFolders: [await showcaseLibraryId()] };
}

// En modo vitrina, los clientes activos ven todas las bibliotecas EXCEPTO el
// cartel de caducados (si no, les saldría "CUENTA CADUCADA" estando al día).
async function activeLibrariesPatch() {
  if (config.expiryMode !== 'vitrina') return {};
  const raw = await E().getVirtualFolders();
  const libs = Array.isArray(raw) ? raw : raw.Items || [];
  const ids = libs.filter((l) => l.Name !== config.expiryLibrary).map((l) => l.Guid || l.ItemId || l.Id);
  return { EnableAllFolders: false, EnabledFolders: ids };
}

async function restoredPolicyPatch() {
  if (config.expiryMode !== 'vitrina') return { IsDisabled: false };
  return { IsDisabled: false, ...(await activeLibrariesPatch()) };
}

// --- Dispositivos de una cuenta (solo Emby) ---

async function listDevices(embyUserId) {
  const [rawDevices, rawSessions] = await Promise.all([
    E().getDevices(),
    E().getSessions().catch(() => []),
  ]);
  const devices = (Array.isArray(rawDevices) ? rawDevices : rawDevices.Items || []).filter(
    (d) => d.LastUserId === embyUserId
  );
  const sessions = Array.isArray(rawSessions) ? rawSessions : rawSessions.Items || [];

  return devices
    .map((d) => {
      const session = sessions.find((s) => s.DeviceId === d.Id && s.UserId === embyUserId);
      return {
        id: d.Id,
        name: d.Name || 'Dispositivo',
        app: [d.AppName, d.AppVersion].filter(Boolean).join(' '),
        ip: (session && session.RemoteEndPoint) || d.IpAddress || '',
        lastActivity: d.DateLastActivity ? d.DateLastActivity.slice(0, 16).replace('T', ' ') : '',
        online: !!session,
        playing: session && session.NowPlayingItem ? session.NowPlayingItem.Name : null,
      };
    })
    .sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
}

async function removeDevice({ account, deviceId }) {
  const devices = await listDevices(account.emby_user_id);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) throw new BusinessError('Ese dispositivo no pertenece a esta cuenta');
  await E().deleteDevice(deviceId);
  return device;
}

// --- Servicios, paquetes y precio ---

function parseServices(body) {
  const emby = body.service_emby === '1' || body.service_emby === 'on' || body.service_emby === true;
  const xui = body.service_xui === '1' || body.service_xui === 'on' || body.service_xui === true;
  const playerKind = body.player_kind === 'maxplayer' ? 'maxplayer' : 'totalflix';
  return {
    emby,
    xui,
    playerKind: xui ? playerKind : null,
    packageId: String(body.xui_package_id || '').trim(),
  };
}

function xuiCredit(plan, packageRow) {
  if (packageRow && packageRow.credit_cost != null) return packageRow.credit_cost;
  return plan.xui_credit_cost || 0;
}

// Emby usa credit_cost (como hasta ahora). XUI suma el precio del paquete si
// el admin lo fijó, y si no el del plan. Max Player es un extra del plan.
function quoteCost({ plan, packageRow, emby, xui, maxplayer }) {
  const parts = [];
  let cost = 0;
  if (emby) {
    cost += plan.credit_cost;
    parts.push({ key: 'emby', label: 'Emby', amount: plan.credit_cost });
  }
  if (xui) {
    const amount = xuiCredit(plan, packageRow);
    cost += amount;
    parts.push({ key: 'xui', label: 'XUI', amount });
  }
  if (maxplayer) {
    const amount = plan.maxplayer_credit_cost || 0;
    cost += amount;
    parts.push({ key: 'maxplayer', label: 'Max Player', amount });
  }
  return { cost, parts };
}

function costForAccount(plan, account) {
  const packageRow = account.xui_package_id
    ? db.prepare('SELECT credit_cost FROM xui_packages WHERE id = ?').get(String(account.xui_package_id))
    : null;
  return quoteCost({
    plan,
    packageRow,
    emby: !!account.emby_user_id,
    xui: !!account.xui_line_id,
    maxplayer: !!account.maxplayer_user_id,
  });
}

function cachedXuiPackages() {
  return db.prepare('SELECT * FROM xui_packages WHERE is_listed = 1 ORDER BY package_name COLLATE NOCASE').all();
}

async function refreshXuiPackages() {
  const remote = await X().getPackages();
  const hide = db.prepare('UPDATE xui_packages SET is_listed = 0');
  const upsert = db.prepare(
    `INSERT INTO xui_packages (
       id, package_name, is_trial, is_official, trial_duration, official_duration,
       max_connections, bouquets, is_listed, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       package_name = excluded.package_name,
       is_trial = excluded.is_trial,
       is_official = excluded.is_official,
       trial_duration = excluded.trial_duration,
       official_duration = excluded.official_duration,
       max_connections = excluded.max_connections,
       bouquets = excluded.bouquets,
       is_listed = 1,
       updated_at = datetime('now')`
  );
  db.transaction(() => {
    hide.run();
    for (const pack of remote) {
      upsert.run(
        pack.id,
        pack.package_name,
        pack.is_trial ? 1 : 0,
        pack.is_official ? 1 : 0,
        pack.trial_duration,
        pack.official_duration,
        pack.max_connections,
        JSON.stringify(pack.bouquets || [])
      );
    }
  })();
  return cachedXuiPackages();
}

async function packagesForForm() {
  const xuiConfigured = X().isConfigured();
  const maxplayerConfigured = M().isConfigured();
  if (!xuiConfigured) {
    return { packages: cachedXuiPackages(), notice: null, xuiConfigured, maxplayerConfigured };
  }
  try {
    const packages = await refreshXuiPackages();
    return { packages, notice: null, xuiConfigured, maxplayerConfigured };
  } catch (err) {
    const packages = cachedXuiPackages();
    const notice = packages.length
      ? 'No se pudo actualizar la lista de paquetes XUI. Se muestra la última copia guardada.'
      : `No se pudieron cargar los paquetes XUI: ${err.message}`;
    return { packages, notice, xuiConfigured, maxplayerConfigured };
  }
}

function setPackageCost(packageId, creditCost) {
  const row = db.prepare('SELECT id FROM xui_packages WHERE id = ?').get(String(packageId));
  if (!row) throw new BusinessError('Paquete no encontrado. Actualiza la lista desde XUI.');
  db.prepare('UPDATE xui_packages SET credit_cost = ? WHERE id = ?').run(creditCost, String(packageId));
}

function parseBouquets(text) {
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

async function loadPackage(packageId) {
  const id = String(packageId || '').trim();
  if (!id) throw new BusinessError('Elige un paquete de XUI');
  let row = db.prepare('SELECT * FROM xui_packages WHERE id = ?').get(id);
  if (!row && X().isConfigured()) {
    await refreshXuiPackages().catch(() => {});
    row = db.prepare('SELECT * FROM xui_packages WHERE id = ?').get(id);
  }
  if (!row) throw new BusinessError('Paquete XUI no válido');
  return row;
}

function lineConnections(plan, packageRow) {
  if (packageRow && packageRow.max_connections) return packageRow.max_connections;
  return plan.screens || 1;
}

function xuiEditFields(account, extra) {
  const fields = Object.assign({}, extra);
  // Un array vacío en edit_line puede borrar los bouquets del panel XUI.
  if (account.xui_bouquets && account.xui_bouquets !== '[]') {
    fields.bouquets_selected = account.xui_bouquets;
  }
  return fields;
}

function loadOwned(accountId, actor) {
  const account = db.prepare("SELECT * FROM emby_accounts WHERE id = ? AND status != 'deleted'").get(accountId);
  if (!account) throw new BusinessError('Cuenta no encontrada');
  if (actor && actor.role === 'reseller' && account.owner_id !== actor.id) {
    throw new BusinessError('Esa cuenta no es tuya');
  }
  return account;
}

function needsWork(account) {
  if (account.provision_error) return true;
  if (account.has_emby && !account.emby_user_id) return true;
  if (account.player_kind && !account.xui_line_id) return true;
  if (account.player_kind === 'maxplayer' && (!account.maxplayer_user_id || !account.maxplayer_list_ok)) return true;
  return false;
}

function xuiPlaylistUrl(username, password) {
  if (!config.xuiPublicUrl || !username || !password) return null;
  const base = config.xuiPublicUrl.replace(/\/+$/, '');
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  return `${base}/get.php?username=${user}&password=${pass}&type=m3u_plus&output=ts`;
}

function buildWelcomeMessage(card) {
  const lines = ['🎬 ¡Bienvenido a Totalflix!', ''];
  if (card.hasEmby) {
    lines.push('📺 Emby');
    lines.push(`Servidor: ${config.embyPublicUrl}`);
    lines.push('Puerto: dejar vacío');
    lines.push(`Usuario: ${card.username}`);
    lines.push(`Contraseña: ${card.password || 'la que ya tienes'}`);
    if (card.screens) lines.push(`Pantallas: ${card.screens}`);
    lines.push('');
  }
  if (card.hasXui && card.playerKind !== 'maxplayer') {
    lines.push('📡 TotalFlix');
    if (card.xuiPublicUrl) lines.push(`Servidor: ${card.xuiPublicUrl}`);
    else lines.push('Servidor: te lo confirma tu proveedor');
    lines.push(`Usuario: ${card.username}`);
    lines.push(`Contraseña: ${card.password || 'la que ya tienes'}`);
    if (card.m3u) lines.push(`Lista M3U: ${card.m3u}`);
    lines.push('');
  }
  if (card.hasMaxPlayer) {
    lines.push('📱 Max Player');
    lines.push(`Usuario: ${card.username}`);
    lines.push(`Contraseña: ${card.password || 'la que ya tienes'}`);
    lines.push('Abre la app Max Player e inicia sesión: la lista ya está cargada.');
    lines.push('');
  } else if (card.playerKind === 'maxplayer') {
    lines.push('📱 Max Player: todavía no está creado. Reintenta en el panel antes de enviar estos datos.');
    lines.push('');
  }
  if (card.plan) lines.push(`📦 Plan: ${card.plan}`);
  if (card.packageName && card.hasXui) lines.push(`📦 Paquete: ${card.packageName}`);
  lines.push(`📅 Vence: ${String(card.expiresAt).slice(0, 10)}`);
  return lines.join('\n').trim();
}

function connectionCard(accountId, actor) {
  const account = db
    .prepare(
      `SELECT a.*, p.name AS plan_name, p.screens AS plan_screens
       FROM emby_accounts a LEFT JOIN plans p ON p.id = a.plan_id
       WHERE a.id = ? AND a.status != 'deleted'`
    )
    .get(accountId);
  if (!account) throw new BusinessError('Cuenta no encontrada');
  if (actor && actor.role === 'reseller' && account.owner_id !== actor.id) {
    throw new BusinessError('Esa cuenta no es tuya');
  }
  const password = account.password_enc ? secret.decrypt(account.password_enc) : null;
  const card = {
    mode: 'resend',
    username: account.username,
    password,
    plan: account.plan_name,
    screens: account.plan_screens,
    expiresAt: account.expires_at,
    hasEmby: !!account.emby_user_id,
    hasXui: !!account.xui_line_id,
    hasMaxPlayer: !!account.maxplayer_user_id,
    playerKind: account.player_kind,
    packageName: account.xui_package_name,
    xuiPublicUrl: config.xuiPublicUrl || '',
    m3u: xuiPlaylistUrl(account.username, password),
    provisionError: account.provision_error,
  };
  card.message = buildWelcomeMessage(card);
  return card;
}

function connectionData(accountId, actor) {
  return connectionCard(accountId, actor);
}

async function compensate(made) {
  if (made.mpId) await M().deleteUser(made.mpId).catch(() => {});
  if (made.xuiId) await X().deleteLine(made.xuiId).catch(() => {});
  if (made.embyId) await E().deleteUser(made.embyId).catch(() => {});
}

function partialMessage(made, want, err) {
  const done = [];
  const pending = [];
  if (made.embyId) done.push('Emby');
  else if (want.emby) pending.push('Emby');
  if (made.xuiId) done.push('XUI');
  else if (want.xui) pending.push('XUI');
  if (made.mpId) done.push('Max Player');
  else if (want.playerKind === 'maxplayer') pending.push('Max Player');
  return (
    `Cuenta guardada a medias: se creó ${done.join(' y ') || 'parte'}, ` +
    `pero falló ${pending.join(' y ') || 'un servicio'} (${err.message}). ` +
    'Los créditos de esta alta ya se descontaron. Pulsa Reintentar: no se vuelve a cobrar.'
  );
}

// Alta. services omitido = solo Emby, el comportamiento de siempre.
async function createAccount({ username, password, planId, owner, notes, services }) {
  username = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new BusinessError('Usuario inválido: 3-32 caracteres, solo letras, números, punto, guion y guion bajo');
  }
  if (!password || password.length < 4) {
    throw new BusinessError('La contraseña debe tener al menos 4 caracteres');
  }
  const want = services
    ? {
        emby: !!services.emby,
        xui: !!services.xui,
        playerKind: services.xui ? (services.playerKind === 'maxplayer' ? 'maxplayer' : 'totalflix') : null,
        packageId: services.packageId || '',
      }
    : { emby: true, xui: false, playerKind: null, packageId: '' };
  if (!want.emby && !want.xui) throw new BusinessError('Activa Emby, XUI o los dos');
  if (want.playerKind === 'maxplayer' && !M().isConfigured()) {
    throw new BusinessError('Max Player no está configurado. Revisa MAXPLAYER_API_KEY y MAXPLAYER_DOMAIN_ID.');
  }
  if (want.xui && !X().isConfigured()) {
    throw new BusinessError('XUI no está configurado. Revisa XUI_API_URL y XUI_API_KEY.');
  }

  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
  if (!plan) throw new BusinessError('Plan no válido');
  const taken = db.prepare('SELECT 1 FROM emby_accounts WHERE username = ?').get(username);
  if (taken) throw new BusinessError('Ese nombre de usuario ya existe en el panel');

  const packageRow = want.xui ? await loadPackage(want.packageId) : null;
  const quoted = quoteCost({
    plan,
    packageRow,
    emby: want.emby,
    xui: want.xui,
    maxplayer: want.playerKind === 'maxplayer',
  });
  if (owner.role === 'reseller' && owner.credits < quoted.cost) {
    throw new BusinessError(`Créditos insuficientes: esta alta cuesta ${quoted.cost} y tienes ${owner.credits}`);
  }

  const expiresAtDate = new Date(Date.now() + plan.duration_days * 24 * 3600 * 1000);
  const expiresAt = toSqlDate(expiresAtDate);
  const made = { embyId: null, xuiId: null, mpId: null, listOk: 0 };

  try {
    if (want.emby) {
      const embyUser = await E().createUser(username, password);
      made.embyId = embyUser.Id;
      try {
        const patch = { SimultaneousStreamLimit: plan.screens || 1, ...(await activeLibrariesPatch()) };
        await E().updatePolicy(embyUser.Id, patch);
      } catch (err) {
        await E().deleteUser(embyUser.Id).catch(() => {});
        made.embyId = null;
        throw err;
      }
    }
    if (want.xui) {
      const line = await X().createLine({
        username,
        password,
        expDate: Math.floor(expiresAtDate.getTime() / 1000),
        maxConnections: lineConnections(plan, packageRow),
        packageId: packageRow.id,
        isTrial: !!packageRow.is_trial,
        bouquets: parseBouquets(packageRow.bouquets),
      });
      made.xuiId = line.id;
    }
    if (want.playerKind === 'maxplayer') {
      const created = await M().provisionUser({
        username,
        password,
        iptvUser: username,
        iptvPass: password,
        domainId: config.maxplayerDomainId,
      });
      made.mpId = created.userId;
      made.listOk = 1;
    }
  } catch (err) {
    if (!made.embyId && !made.xuiId && !made.mpId) throw err;
    const message = partialMessage(made, want, err);
    console.error(`[provision] ${username}: ${message}`);
    try {
      const id = persistNewAccount({
        username,
        password,
        owner,
        plan,
        notes,
        expiresAt,
        want,
        packageRow,
        made,
        cost: quoted.cost,
        provisionError: message,
      });
      return { id, expiresAt, plan, provisionError: message, cost: quoted.cost };
    } catch (saveErr) {
      await compensate(made);
      throw saveErr;
    }
  }

  try {
    const id = persistNewAccount({
      username,
      password,
      owner,
      plan,
      notes,
      expiresAt,
      want,
      packageRow,
      made,
      cost: quoted.cost,
      provisionError: null,
    });
    return { id, expiresAt, plan, provisionError: null, cost: quoted.cost };
  } catch (err) {
    await compensate(made);
    throw err;
  }
}

function persistNewAccount({ username, password, owner, plan, notes, expiresAt, want, packageRow, made, cost, provisionError }) {
  const passwordHash = bcrypt.hashSync(password, 10);
  const bouquets = packageRow ? packageRow.bouquets || null : null;
  const insertTx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO emby_accounts (
           emby_user_id, username, password_hash, password_enc, owner_id, plan_id, expires_at, status, notes,
           has_emby, xui_line_id, xui_package_id, xui_package_name, xui_bouquets, player_kind,
           maxplayer_user_id, maxplayer_list_ok, provision_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        made.embyId,
        username,
        passwordHash,
        secret.encrypt(password),
        owner.id,
        plan.id,
        expiresAt,
        notes || null,
        want.emby ? 1 : 0,
        made.xuiId,
        packageRow ? packageRow.id : null,
        packageRow ? packageRow.package_name : null,
        bouquets,
        want.playerKind,
        made.mpId,
        made.listOk ? 1 : 0,
        provisionError
      );
    if (owner.role === 'reseller') {
      deductCredits(owner.id, cost, 'create_account', info.lastInsertRowid, owner.id);
    }
    return info.lastInsertRowid;
  });
  return insertTx();
}

async function pushPassword(account, password) {
  const errors = [];
  if (account.emby_user_id) {
    try {
      await E().setPassword(account.emby_user_id, password);
    } catch (err) {
      errors.push(`Emby: ${err.message}`);
    }
  }
  if (account.xui_line_id) {
    try {
      await X().editLine(account.xui_line_id, xuiEditFields(account, { password }));
    } catch (err) {
      errors.push(`XUI: ${err.message}`);
    }
  }
  if (account.maxplayer_user_id) {
    try {
      await M().changePassword(account.maxplayer_user_id, password);
      await M().attachPlaylist(account.maxplayer_user_id, {
        domainId: config.maxplayerDomainId,
        iptvUsername: account.username,
        iptvPassword: password,
      });
    } catch (err) {
      errors.push(`Max Player: ${err.message}`);
    }
  }
  return errors;
}

function saveProgress(accountId, fields) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  params.push(accountId);
  db.prepare(`UPDATE emby_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// Reintenta lo que quedó a medias y vuelve a empujar la contraseña guardada.
// No descuenta créditos.
async function retryProvision({ accountId, actor }) {
  let account = loadOwned(accountId, actor);
  if (!needsWork(account)) throw new BusinessError('Esta cuenta no tiene nada pendiente');
  const password = account.password_enc ? secret.decrypt(account.password_enc) : null;
  const missing =
    (account.has_emby && !account.emby_user_id) ||
    (account.player_kind && !account.xui_line_id) ||
    (account.player_kind === 'maxplayer' && !account.maxplayer_user_id);
  if (missing && !password) {
    throw new BusinessError('No hay contraseña guardada para reintentar. Pon una nueva: a partir de ahí se puede sincronizar.');
  }

  const plan = account.plan_id ? db.prepare('SELECT * FROM plans WHERE id = ?').get(account.plan_id) : null;
  const errors = [];

  if (account.has_emby && !account.emby_user_id) {
    try {
      const user = await E().createUser(account.username, password);
      const patch = { SimultaneousStreamLimit: (plan && plan.screens) || 1, ...(await activeLibrariesPatch()) };
      if (account.status === 'expired') Object.assign(patch, await expiredPolicyPatch());
      await E().updatePolicy(user.Id, patch);
      saveProgress(account.id, { emby_user_id: user.Id, has_emby: 1 });
      account = loadOwned(account.id, actor);
    } catch (err) {
      errors.push(`Emby: ${err.message}`);
    }
  }

  if (account.player_kind && !account.xui_line_id) {
    try {
      const packageRow = await loadPackage(account.xui_package_id);
      const line = await X().createLine({
        username: account.username,
        password,
        expDate: unixSeconds(account.expires_at),
        maxConnections: lineConnections(plan || { screens: 1 }, packageRow),
        packageId: packageRow.id,
        isTrial: !!packageRow.is_trial,
        bouquets: parseBouquets(packageRow.bouquets),
      });
      saveProgress(account.id, {
        xui_line_id: line.id,
        xui_package_id: packageRow.id,
        xui_package_name: packageRow.package_name,
        xui_bouquets: packageRow.bouquets || null,
      });
      if (account.status === 'expired') await X().disableLine(line.id);
      account = loadOwned(account.id, actor);
    } catch (err) {
      errors.push(`XUI: ${err.message}`);
    }
  }

  if (account.player_kind === 'maxplayer' && account.xui_line_id && !account.maxplayer_user_id) {
    try {
      const created = await M().provisionUser({
        username: account.username,
        password,
        iptvUser: account.username,
        iptvPass: password,
        domainId: config.maxplayerDomainId,
      });
      saveProgress(account.id, { maxplayer_user_id: created.userId, maxplayer_list_ok: 1 });
      account = loadOwned(account.id, actor);
    } catch (err) {
      errors.push(`Max Player: ${err.message}`);
    }
  } else if (account.maxplayer_user_id && !account.maxplayer_list_ok && password) {
    try {
      await M().attachPlaylist(account.maxplayer_user_id, {
        domainId: config.maxplayerDomainId,
        iptvUsername: account.username,
        iptvPassword: password,
      });
      saveProgress(account.id, { maxplayer_list_ok: 1 });
      account = loadOwned(account.id, actor);
    } catch (err) {
      errors.push(`Lista Max Player: ${err.message}`);
    }
  }

  if (password) {
    const pwErrors = await pushPassword(account, password);
    errors.push(...pwErrors);
    if (!pwErrors.length && account.maxplayer_user_id) {
      saveProgress(account.id, { maxplayer_list_ok: 1 });
      account = loadOwned(account.id, actor);
    }
  }

  const pending = errors.length
    ? `Sigue pendiente: ${errors.join(' · ')}. Pulsa Reintentar; no se vuelve a cobrar.`
    : null;
  saveProgress(account.id, { provision_error: pending });
  if (pending) console.error(`[provision] ${account.username}: ${pending}`);
  return { provisionError: pending };
}

// Renovación: extiende la caducidad desde max(ahora, caducidad actual)
// y aplica la fecha en cada sistema donde la cuenta ya existe.
async function renewAccount({ accountId, planId, actor }) {
  const account = loadOwned(accountId, actor);
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
  if (!plan) throw new BusinessError('Plan no válido');
  const quoted = costForAccount(plan, account);
  if (actor.role === 'reseller' && actor.credits < quoted.cost) {
    throw new BusinessError(`Créditos insuficientes: el plan cuesta ${quoted.cost} y tienes ${actor.credits}`);
  }

  const base = Math.max(Date.now(), parseSqlDate(account.expires_at).getTime());
  const newExpiry = toSqlDate(new Date(base + plan.duration_days * 24 * 3600 * 1000));
  await renewRemotes(account, plan, newExpiry);

  const renewTx = db.transaction(() => {
    db.prepare("UPDATE emby_accounts SET expires_at = ?, status = 'active', plan_id = ? WHERE id = ?").run(
      newExpiry,
      plan.id,
      account.id
    );
    if (actor.role === 'reseller') {
      deductCredits(actor.id, quoted.cost, 'renew', account.id, actor.id);
    }
  });
  renewTx();
  return newExpiry;
}

async function renewRemotes(account, plan, newExpiry) {
  const errors = [];
  if (account.emby_user_id) {
    try {
      const policyPatch = { SimultaneousStreamLimit: plan.screens || 1 };
      if (account.status === 'expired') Object.assign(policyPatch, await restoredPolicyPatch());
      await E().updatePolicy(account.emby_user_id, policyPatch);
    } catch (err) {
      errors.push(`Emby: ${err.message}`);
    }
  }
  if (account.xui_line_id) {
    try {
      const packageRow = account.xui_package_id
        ? db.prepare('SELECT max_connections FROM xui_packages WHERE id = ?').get(String(account.xui_package_id))
        : null;
      const fields = { exp_date: unixSeconds(newExpiry) };
      if (!packageRow || !packageRow.max_connections) fields.max_connections = plan.screens || 1;
      await X().editLine(account.xui_line_id, xuiEditFields(account, fields));
      await X().enableLine(account.xui_line_id);
    } catch (err) {
      errors.push(`XUI: ${err.message}`);
    }
  }
  if (account.maxplayer_user_id) {
    const password = account.password_enc ? secret.decrypt(account.password_enc) : null;
    if (password && config.maxplayerDomainId) {
      try {
        await M().attachPlaylist(account.maxplayer_user_id, {
          domainId: config.maxplayerDomainId,
          iptvUsername: account.username,
          iptvPassword: password,
        });
      } catch (err) {
        errors.push(`Max Player: ${err.message}`);
      }
    }
  }
  if (errors.length) {
    throw new BusinessError(
      `No se pudo renovar en todos los servicios: ${errors.join(' · ')}. No se han cobrado créditos ni se ha cambiado la fecha.`
    );
  }
}

async function changePassword({ accountId, newPassword, actor }) {
  const account = loadOwned(accountId, actor);
  if (!newPassword || newPassword.length < 4) {
    throw new BusinessError('La contraseña debe tener al menos 4 caracteres');
  }
  const targets = [account.emby_user_id, account.xui_line_id, account.maxplayer_user_id].filter(Boolean).length;
  const errors = await pushPassword(account, newPassword);
  if (errors.length === 0) {
    db.prepare('UPDATE emby_accounts SET password_hash = ?, password_enc = ?, provision_error = ? WHERE id = ?').run(
      bcrypt.hashSync(newPassword, 10),
      secret.encrypt(newPassword),
      needsWork(Object.assign({}, account, { provision_error: null })) ? account.provision_error : null,
      account.id
    );
    return;
  }
  if (targets === 0 || errors.length < targets) {
    const message = `La contraseña no llegó a todos los servicios: ${errors.join(' · ')}. Pulsa Reintentar.`;
    db.prepare('UPDATE emby_accounts SET password_hash = ?, password_enc = ?, provision_error = ? WHERE id = ?').run(
      bcrypt.hashSync(newPassword, 10),
      secret.encrypt(newPassword),
      message,
      account.id
    );
    throw new BusinessError(message);
  }
  throw new BusinessError(`No se pudo cambiar la contraseña: ${errors.join(' · ')}`);
}

// Cambia el plan SIN tocar la fecha. El reseller solo entre planes de la misma
// duración, cobrando o abonando la diferencia de los servicios que ya existen.
async function changePlan({ accountId, planId, actor }) {
  const account = loadOwned(accountId, actor);
  const newPlan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
  if (!newPlan) throw new BusinessError('Plan no válido');
  if (newPlan.id === account.plan_id) throw new BusinessError('La cuenta ya tiene ese plan');

  let diff = 0;
  if (actor.role === 'reseller') {
    const oldPlan = account.plan_id ? db.prepare('SELECT * FROM plans WHERE id = ?').get(account.plan_id) : null;
    if (!oldPlan || oldPlan.duration_days !== newPlan.duration_days) {
      throw new BusinessError('Solo puedes cambiar entre planes de la misma duración; para ampliar tiempo usa Renovar');
    }
    diff = costForAccount(newPlan, account).cost - costForAccount(oldPlan, account).cost;
    if (diff > 0 && actor.credits < diff) {
      throw new BusinessError(`Créditos insuficientes: el cambio cuesta ${diff} y tienes ${actor.credits}`);
    }
  }

  if (account.xui_line_id) {
    const packageRow = account.xui_package_id
      ? db.prepare('SELECT max_connections FROM xui_packages WHERE id = ?').get(String(account.xui_package_id))
      : null;
    if (!packageRow || !packageRow.max_connections) {
      await X().editLine(
        account.xui_line_id,
        xuiEditFields(account, { max_connections: newPlan.screens || 1 })
      );
    }
  }
  if (account.emby_user_id) {
    await E().setStreamLimit(account.emby_user_id, newPlan.screens || 1);
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE emby_accounts SET plan_id = ? WHERE id = ?').run(newPlan.id, account.id);
    if (actor.role === 'reseller' && diff !== 0) {
      const r = db
        .prepare('UPDATE panel_users SET credits = credits - ? WHERE id = ? AND (? <= 0 OR credits >= ?)')
        .run(diff, actor.id, diff, diff);
      if (r.changes === 0) throw new BusinessError('Créditos insuficientes');
      const { credits } = db.prepare('SELECT credits FROM panel_users WHERE id = ?').get(actor.id);
      db.prepare(
        `INSERT INTO credit_transactions (reseller_id, amount, balance_after, reason, account_id, performed_by)
         VALUES (?, ?, ?, 'adjustment', ?, ?)`
      ).run(actor.id, -diff, credits, account.id, actor.id);
    }
  });
  tx();
  return { newPlan, diff };
}

function markDeleted(accountId) {
  db.prepare(
    "UPDATE emby_accounts SET status = 'deleted', username = username || '#del' || id WHERE id = ?"
  ).run(accountId);
}

async function clearRemote(account, { id, label, run, clearSql }) {
  if (!id) return null;
  try {
    await run();
    db.prepare(clearSql).run(account.id);
    return null;
  } catch (err) {
    if (err.status === 404) {
      db.prepare(clearSql).run(account.id);
      return null;
    }
    return `${label}: ${err.message}`;
  }
}

// Borra en cada sistema donde haya id. Lo que ya se borró se olvida en la fila
// para que un segundo intento no dependa de un 404.
async function deleteEverywhere(account) {
  const errors = [];
  const steps = [
    {
      id: account.maxplayer_user_id,
      label: 'Max Player',
      run: () => M().deleteUser(account.maxplayer_user_id),
      clearSql: 'UPDATE emby_accounts SET maxplayer_user_id = NULL, maxplayer_list_ok = 0 WHERE id = ?',
    },
    {
      id: account.xui_line_id,
      label: 'XUI',
      run: () => X().deleteLine(account.xui_line_id),
      clearSql: 'UPDATE emby_accounts SET xui_line_id = NULL WHERE id = ?',
    },
    {
      id: account.emby_user_id,
      label: 'Emby',
      run: () => E().deleteUser(account.emby_user_id),
      clearSql: 'UPDATE emby_accounts SET emby_user_id = NULL, has_emby = 0 WHERE id = ?',
    },
  ];
  for (const step of steps) {
    const failure = await clearRemote(account, step);
    if (failure) errors.push(failure);
  }
  if (errors.length) {
    const message = `Borrado incompleto: ${errors.join(' · ')}. Lo que sí se borró ya quedó registrado. Pulsa Borrar otra vez para reintentar.`;
    db.prepare('UPDATE emby_accounts SET provision_error = ? WHERE id = ?').run(message, account.id);
    throw new BusinessError(message);
  }
  markDeleted(account.id);
}

async function deleteAccount({ accountId, actor }) {
  const account = loadOwned(accountId, actor);
  await deleteEverywhere(account);
}

// Caducidad. Max Player no tiene un "desactivar": se corta la línea XUI
// (la playlist deja de reproducir) y, si se puede, se cierran sus dispositivos.
async function expireRemotes(account) {
  const errors = [];
  if (account.emby_user_id) {
    try {
      await E().updatePolicy(account.emby_user_id, await expiredPolicyPatch());
    } catch (err) {
      errors.push(`Emby: ${err.message}`);
    }
  }
  if (account.xui_line_id) {
    try {
      await X().disableLine(account.xui_line_id);
    } catch (err) {
      errors.push(`XUI: ${err.message}`);
    }
  }
  if (account.maxplayer_user_id) {
    if (!account.xui_line_id) {
      errors.push('Max Player: no hay línea XUI que desactivar');
    } else {
      await M().deleteDevices(account.maxplayer_user_id).catch((err) => {
        console.error(`[expiry] No se pudieron cerrar los dispositivos Max Player de ${account.username}: ${err.message}`);
      });
    }
  }
  if (errors.length) throw new Error(errors.join(' · '));
}

async function restoreRemotes(account) {
  const errors = [];
  if (account.emby_user_id) {
    try {
      await E().updatePolicy(account.emby_user_id, await restoredPolicyPatch());
    } catch (err) {
      errors.push(`Emby: ${err.message}`);
    }
  }
  if (account.xui_line_id) {
    try {
      await X().editLine(account.xui_line_id, xuiEditFields(account, { exp_date: unixSeconds(account.expires_at) }));
      await X().enableLine(account.xui_line_id);
    } catch (err) {
      errors.push(`XUI: ${err.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join(' · '));
}

module.exports = {
  BusinessError,
  isUserFacingError,
  toSqlDate,
  parseSqlDate,
  daysLeft,
  formatDuration,
  addCredits,
  parseServices,
  quoteCost,
  costForAccount,
  cachedXuiPackages,
  refreshXuiPackages,
  packagesForForm,
  setPackageCost,
  createAccount,
  retryProvision,
  renewAccount,
  changePassword,
  changePlan,
  connectionData,
  connectionCard,
  buildWelcomeMessage,
  xuiPlaylistUrl,
  markDeleted,
  deleteAccount,
  deleteEverywhere,
  activeLibrariesPatch,
  listDevices,
  removeDevice,
  expiredPolicyPatch,
  restoredPolicyPatch,
  expireRemotes,
  restoreRemotes,
  setIntegrations,
};
