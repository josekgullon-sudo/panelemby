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
const { formatExpDate } = require('./xui');

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
    xuiPlanId: parseInt(body.xui_plan_id, 10) || null,
  };
}

function xuiCredit(plan, packageRow) {
  if (packageRow && packageRow.credit_cost != null) return packageRow.credit_cost;
  return plan.xui_credit_cost || 0;
}

// Emby usa credit_cost (como hasta ahora). XUI suma el precio del paquete si
// el admin lo fijó, y si no el del plan. Max Player es un extra del plan.
function quoteCost({ plan, xuiPlan, packageRow, emby, xui, maxplayer }) {
  const parts = [];
  let cost = 0;
  const xPlan = xuiPlan || plan;
  if (emby) {
    cost += plan.credit_cost;
    parts.push({ key: 'emby', label: 'Emby', amount: plan.credit_cost });
  }
  if (xui) {
    const amount = xuiCredit(xPlan, packageRow);
    cost += amount;
    parts.push({ key: 'xui', label: 'XUI', amount });
  }
  if (maxplayer) {
    const amount = xPlan.maxplayer_credit_cost || 0;
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

function formatClientDate(sql, withTime) {
  if (!sql) return '';
  if (!withTime) return String(sql).slice(0, 10);
  const date = parseSqlDate(sql);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type) => {
    const part = parts.find((item) => item.type === type);
    return part ? part.value : '';
  };
  const hour = pick('hour') === '24' ? '00' : pick('hour');
  return `${pick('year')}-${pick('month')}-${pick('day')} ${hour}:${pick('minute')}`;
}

function buildWelcomeMessage(card) {
  const password = card.password || 'la que ya tienes';
  const lines = ['🎬 ¡Bienvenido a Totalflix!', ''];
  const both = card.hasEmby && card.hasXui;
  if (card.hasEmby) {
    lines.push('📺 Emby');
    lines.push(`Servidor: ${config.embyPublicUrl}`);
    lines.push('Puerto: dejar vacío');
    lines.push(`Usuario: ${card.username}`);
    lines.push(`Contraseña: ${password}`);
    if (card.screens) lines.push(`Pantallas: ${card.screens}`);
    if (both) lines.push(`📅 Vence: ${formatClientDate(card.embyExpiresAt || card.expiresAt)}`);
    lines.push('');
  }
  if (card.hasXui) {
    lines.push('📡 XUI');
    lines.push(`Usuario: ${card.username}`);
    lines.push(`Contraseña: ${password}`);
    lines.push(`📅 Vence: ${formatClientDate(card.xuiExpiresAt || card.expiresAt, true)}`);
    lines.push('');
  }
  if (card.plan) lines.push(`📦 Plan: ${card.plan}`);
  if (card.hasEmby && !card.hasXui) lines.push(`📅 Vence: ${formatClientDate(card.embyExpiresAt || card.expiresAt)}`);
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
    embyExpiresAt: account.emby_expires_at,
    xuiExpiresAt: account.xui_expires_at,
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
        xuiPlanId: services.xuiPlanId || null,
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
  const xuiPlanId = want.xui ? services.xuiPlanId || planId : null;
  const xuiPlan = want.xui
    ? xuiPlanId === plan.id
      ? plan
      : db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(xuiPlanId)
    : null;
  if (want.xui && !xuiPlan) throw new BusinessError('Elige la duración de XUI');
  const taken = db.prepare('SELECT 1 FROM emby_accounts WHERE username = ?').get(username);
  if (taken) throw new BusinessError('Ese nombre de usuario ya existe en el panel');

  const packageRow = want.xui ? await loadPackage(want.packageId) : null;
  const quoted = quoteCost({
    plan,
    xuiPlan,
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
  const xuiExpiresAt = want.xui
    ? xuiPlan.id === plan.id
      ? expiresAt
      : toSqlDate(new Date(Date.now() + xuiPlan.duration_days * 24 * 3600 * 1000))
    : null;
  const embyExpiresAt = want.emby ? expiresAt : null;
  const clock = [embyExpiresAt, xuiExpiresAt].filter(Boolean).sort()[0];
  const made = { embyId: null, xuiId: null, mpId: null, listOk: 0, domainId: null };

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
        expDate: xuiExpiresAt,
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
      made.domainId = String(config.maxplayerDomainId || '');
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
        expiresAt: clock,
        embyExpiresAt,
        xuiExpiresAt,
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
      expiresAt: clock,
      embyExpiresAt,
      xuiExpiresAt,
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

function persistNewAccount({
  username,
  password,
  owner,
  plan,
  notes,
  expiresAt,
  embyExpiresAt,
  xuiExpiresAt,
  want,
  packageRow,
  made,
  cost,
  provisionError,
}) {
  const passwordHash = bcrypt.hashSync(password, 10);
  const bouquets = packageRow ? JSON.stringify(parseBouquets(packageRow.bouquets)) : null;
  const insertTx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO emby_accounts (
           emby_user_id, username, password_hash, password_enc, owner_id, plan_id, expires_at, status, notes,
           has_emby, xui_line_id, xui_package_id, xui_package_name, xui_bouquets, player_kind,
           maxplayer_user_id, maxplayer_list_ok, maxplayer_domain_id, provision_error,
           emby_expires_at, xui_expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        bouquets && bouquets !== '[]' ? bouquets : null,
        want.playerKind,
        made.mpId,
        made.listOk ? 1 : 0,
        made.domainId || null,
        provisionError,
        embyExpiresAt,
        xuiExpiresAt
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
        domainId: account.maxplayer_domain_id || config.maxplayerDomainId,
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
        expDate: account.xui_expires_at || account.expires_at,
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
      saveProgress(account.id, {
        maxplayer_user_id: created.userId,
        maxplayer_list_ok: 1,
        maxplayer_domain_id: config.maxplayerDomainId || null,
      });
      account = loadOwned(account.id, actor);
    } catch (err) {
      errors.push(`Max Player: ${err.message}`);
    }
  } else if (account.maxplayer_user_id && !account.maxplayer_list_ok && password) {
    try {
      await M().attachPlaylist(account.maxplayer_user_id, {
        domainId: account.maxplayer_domain_id || config.maxplayerDomainId,
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

  const embyExpiry = account.emby_user_id ? extendDate(account.emby_expires_at || account.expires_at, plan) : null;
  const xuiExpiry = account.xui_line_id ? extendDate(account.xui_expires_at || account.expires_at, plan) : null;
  const newExpiry = [embyExpiry, xuiExpiry].filter(Boolean).sort()[0] || extendDate(account.expires_at, plan);
  await renewRemotes(account, plan, { embyExpiry, xuiExpiry });

  const renewTx = db.transaction(() => {
    db.prepare(
      `UPDATE emby_accounts
       SET expires_at = ?, status = 'active', plan_id = ?,
           emby_expires_at = COALESCE(?, emby_expires_at),
           xui_expires_at = COALESCE(?, xui_expires_at),
           emby_cut = CASE WHEN ? IS NULL THEN emby_cut ELSE 0 END,
           xui_cut = CASE WHEN ? IS NULL THEN xui_cut ELSE 0 END
       WHERE id = ?`
    ).run(newExpiry, plan.id, embyExpiry, xuiExpiry, embyExpiry, xuiExpiry, account.id);
    if (actor.role === 'reseller') {
      deductCredits(actor.id, quoted.cost, 'renew', account.id, actor.id);
    }
  });
  renewTx();
  return newExpiry;
}

function extendDate(sql, plan) {
  const base = Math.max(Date.now(), sql ? parseSqlDate(sql).getTime() : Date.now());
  return toSqlDate(new Date(base + plan.duration_days * 24 * 3600 * 1000));
}

function clockFrom(account) {
  const dates = [];
  if (account.emby_user_id || account.has_emby) dates.push(account.emby_expires_at || account.expires_at);
  if (account.xui_line_id || account.player_kind) dates.push(account.xui_expires_at || account.expires_at);
  const present = dates.filter(Boolean);
  if (!present.length) return account.expires_at;
  const future = present.filter((value) => parseSqlDate(value).getTime() > Date.now());
  const pool = future.length ? future : present;
  return pool.slice().sort()[future.length ? 0 : pool.length - 1];
}

async function renewRemotes(account, plan, dates) {
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
      const fields = { exp_date: formatExpDate(dates.xuiExpiry || account.xui_expires_at || account.expires_at) };
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
          domainId: account.maxplayer_domain_id || config.maxplayerDomainId,
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
  if (account.emby_user_id && !account.emby_cut) {
    try {
      await E().updatePolicy(account.emby_user_id, await restoredPolicyPatch());
    } catch (err) {
      errors.push(`Emby: ${err.message}`);
    }
  }
  if (account.xui_line_id && !account.xui_cut) {
    try {
      await X().editLine(
        account.xui_line_id,
        xuiEditFields(account, { exp_date: formatExpDate(account.xui_expires_at || account.expires_at) })
      );
      await X().enableLine(account.xui_line_id);
    } catch (err) {
      errors.push(`XUI: ${err.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join(' · '));
}

function domainLabel(id) {
  const value = id == null ? '' : String(id);
  if (value && value === String(config.maxplayerDomainPatoId)) return 'PATO';
  if (value && value === String(config.maxplayerDomainCisneId)) return 'CISNE';
  return value ? 'otro servidor' : 'el servidor actual';
}

function nextDomainLabel(id) {
  return String(id || '') === String(config.maxplayerDomainPatoId) ? 'CISNE' : 'PATO';
}

function accountListFilters(query) {
  const servicio = ['emby', 'xui', 'maxplayer', 'totalflix'].includes(query.servicio) ? query.servicio : '';
  const dominio = ['pato', 'cisne'].includes(query.dominio) ? query.dominio : '';
  const clauses = [];
  const params = [];
  if (servicio === 'emby') clauses.push('(a.has_emby = 1 OR a.emby_user_id IS NOT NULL)');
  if (servicio === 'xui') clauses.push('a.xui_line_id IS NOT NULL');
  if (servicio === 'maxplayer') clauses.push("(a.player_kind = 'maxplayer' OR a.maxplayer_user_id IS NOT NULL)");
  if (servicio === 'totalflix') clauses.push("a.player_kind = 'totalflix'");
  if (dominio === 'pato') {
    clauses.push('a.maxplayer_domain_id = ?');
    params.push(String(config.maxplayerDomainPatoId));
  }
  if (dominio === 'cisne') {
    clauses.push('a.maxplayer_domain_id = ?');
    params.push(String(config.maxplayerDomainCisneId));
  }
  return { servicio, dominio, clauses, params };
}

const PAGE_SIZES = [25, 50, 100];
const SORTS = {
  vence: 'a.expires_at',
  cuenta: 'a.username',
  creada: 'a.created_at',
  estado: 'a.status',
  reseller: 'p.username COLLATE NOCASE',
  plan: 'pl.name COLLATE NOCASE',
};

function pageWindow(page, pages) {
  if (pages <= 1) return [];
  const start = Math.max(1, page - 2);
  const end = Math.min(pages, page + 2);
  const items = [];
  if (start > 1) items.push(1);
  if (start > 2) items.push(0);
  for (let i = start; i <= end; i += 1) items.push(i);
  if (end < pages - 1) items.push(0);
  if (end < pages) items.push(pages);
  return items;
}

function accountPageHref(base, state, page) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.estado) params.set('estado', state.estado);
  if (state.servicio) params.set('servicio', state.servicio);
  if (state.dominio) params.set('dominio', state.dominio);
  if (state.reseller) params.set('reseller', String(state.reseller));
  if (state.pageSize !== 50) params.set('tam', String(state.pageSize));
  if (state.sort !== 'vence') params.set('orden', state.sort);
  if (state.dir !== 'asc') params.set('dir', state.dir);
  if (page > 1) params.set('pagina', String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// Lista paginada. Filtros, búsqueda y orden se aplican en SQL sobre todas
// las cuentas, no sobre la página ya cortada. ownerId limita al reseller.
function listAccounts(query, { ownerId = null, base = '/admin/cuentas' } = {}) {
  const src = query || {};
  const q = String(src.q || '').trim();
  const estado = ['active', 'expired'].includes(src.estado) ? src.estado : '';
  const filters = accountListFilters(src);
  const pageSize = PAGE_SIZES.includes(parseInt(src.tam, 10)) ? parseInt(src.tam, 10) : 50;
  let sort = Object.prototype.hasOwnProperty.call(SORTS, src.orden) ? src.orden : 'vence';
  if (ownerId && sort === 'reseller') sort = 'vence';
  const dir = src.dir === 'desc' ? 'desc' : 'asc';
  let reseller = '';
  if (!ownerId) {
    const raw = parseInt(src.reseller, 10);
    if (Number.isInteger(raw) && raw > 0) reseller = String(raw);
  }

  const clauses = ["a.status != 'deleted'"];
  const params = [];
  if (ownerId) {
    clauses.push('a.owner_id = ?');
    params.push(ownerId);
  } else if (reseller) {
    clauses.push('a.owner_id = ?');
    params.push(parseInt(reseller, 10));
  }
  if (q) {
    if (ownerId) {
      clauses.push('a.username LIKE ?');
      params.push(`%${q}%`);
    } else {
      clauses.push('(a.username LIKE ? OR p.username LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
  }
  if (estado) {
    clauses.push('a.status = ?');
    params.push(estado);
  }
  if (filters.clauses.length) {
    clauses.push(...filters.clauses);
    params.push(...filters.params);
  }

  const from = `FROM emby_accounts a
    JOIN panel_users p ON p.id = a.owner_id
    LEFT JOIN plans pl ON pl.id = a.plan_id
    WHERE ${clauses.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  let page = parseInt(src.pagina, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (page > pages) page = pages;
  const offset = (page - 1) * pageSize;
  const sqlDir = dir === 'desc' ? 'DESC' : 'ASC';
  const list = db.prepare(
    `SELECT a.*, p.username AS owner, pl.name AS plan, pl.duration_days
     ${from}
     ORDER BY ${SORTS[sort]} ${sqlDir}, a.id ${sqlDir}
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);

  const state = {
    q,
    estado,
    servicio: filters.servicio,
    dominio: filters.dominio,
    reseller,
    pageSize,
    sort,
    dir,
    total,
    page,
    pages,
    pageWindow: pageWindow(page, pages),
    from: total === 0 ? 0 : offset + 1,
    to: offset + list.length,
    list,
    href(n) {
      return accountPageHref(base, state, n);
    },
  };
  return state;
}

function chargeReseller(actor, cost, reason, accountId) {
  if (actor.role !== 'reseller' || !cost) return;
  deductCredits(actor.id, cost, reason, accountId, actor.id);
}

async function extendService({ accountId, actor, service, planId }) {
  const account = loadOwned(accountId, actor);
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
  if (!plan) throw new BusinessError('Plan no válido');
  if (service !== 'emby' && service !== 'xui') throw new BusinessError('Servicio no válido');

  const packageRow = account.xui_package_id
    ? db.prepare('SELECT * FROM xui_packages WHERE id = ?').get(String(account.xui_package_id))
    : null;
  const quoted = quoteCost({
    plan,
    xuiPlan: plan,
    packageRow,
    emby: service === 'emby',
    xui: service === 'xui',
    maxplayer: service === 'xui' && !!account.maxplayer_user_id,
  });
  if (actor.role === 'reseller' && actor.credits < quoted.cost) {
    throw new BusinessError(`Créditos insuficientes: ampliar cuesta ${quoted.cost} y tienes ${actor.credits}`);
  }

  if (service === 'emby') {
    if (!account.emby_user_id) throw new BusinessError('Esta cuenta no tiene Emby. Créalo antes de ampliarlo.');
    const embyExpiry = extendDate(account.emby_expires_at || account.expires_at, plan);
    const patch = { SimultaneousStreamLimit: plan.screens || 1 };
    if (account.emby_cut || account.status === 'expired') Object.assign(patch, await restoredPolicyPatch());
    await E().updatePolicy(account.emby_user_id, patch);
    const next = Object.assign({}, account, { emby_expires_at: embyExpiry, emby_cut: 0 });
    const expiresAt = clockFrom(next);
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE emby_accounts
         SET emby_expires_at = ?, emby_cut = 0, expires_at = ?, status = 'active', plan_id = ?
         WHERE id = ?`
      ).run(embyExpiry, expiresAt, plan.id, account.id);
      chargeReseller(actor, quoted.cost, 'renew', account.id);
    });
    tx();
    return { expiresAt: embyExpiry, cost: quoted.cost, service: 'emby' };
  }

  if (!account.xui_line_id) throw new BusinessError('Esta cuenta no tiene línea XUI. Créala antes de ampliarla.');
  const xuiExpiry = extendDate(account.xui_expires_at || account.expires_at, plan);
  const fields = { exp_date: formatExpDate(xuiExpiry) };
  if (!packageRow || !packageRow.max_connections) fields.max_connections = plan.screens || 1;
  await X().editLine(account.xui_line_id, xuiEditFields(account, fields));
  await X().enableLine(account.xui_line_id);
  const next = Object.assign({}, account, { xui_expires_at: xuiExpiry, xui_cut: 0 });
  const expiresAt = clockFrom(next);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE emby_accounts
       SET xui_expires_at = ?, xui_cut = 0, expires_at = ?, status = 'active'
       WHERE id = ?`
    ).run(xuiExpiry, expiresAt, account.id);
    chargeReseller(actor, quoted.cost, 'renew', account.id);
  });
  tx();
  return { expiresAt: xuiExpiry, cost: quoted.cost, service: 'xui' };
}

async function addService({ accountId, actor, service, planId, packageId, playerKind }) {
  let account = loadOwned(accountId, actor);
  const password = account.password_enc ? secret.decrypt(account.password_enc) : null;
  if (!password) {
    throw new BusinessError('No hay contraseña guardada. Pon una nueva y después añade el servicio.');
  }
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
  if (!plan) throw new BusinessError('Plan no válido');

  if (service === 'emby') {
    if (account.emby_user_id) throw new BusinessError('Esta cuenta ya tiene Emby');
    const quoted = quoteCost({ plan, emby: true, xui: false, maxplayer: false });
    if (actor.role === 'reseller' && actor.credits < quoted.cost) {
      throw new BusinessError(`Créditos insuficientes: Emby cuesta ${quoted.cost} y tienes ${actor.credits}`);
    }
    const user = await E().createUser(account.username, password);
    try {
      await E().updatePolicy(user.Id, { SimultaneousStreamLimit: plan.screens || 1, ...(await activeLibrariesPatch()) });
    } catch (err) {
      await E().deleteUser(user.Id).catch(() => {});
      throw err;
    }
    const embyExpiry = extendDate(null, plan);
    const next = Object.assign({}, account, { emby_expires_at: embyExpiry, has_emby: 1, emby_user_id: user.Id });
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE emby_accounts
         SET emby_user_id = ?, has_emby = 1, emby_expires_at = ?, emby_cut = 0, expires_at = ?, plan_id = ?, status = 'active'
         WHERE id = ?`
      ).run(user.Id, embyExpiry, clockFrom(next), plan.id, account.id);
      chargeReseller(actor, quoted.cost, 'create_account', account.id);
    });
    tx();
    return { cost: quoted.cost };
  }

  if (service !== 'xui') throw new BusinessError('Servicio no válido');
  if (account.xui_line_id) throw new BusinessError('Esta cuenta ya tiene línea XUI');
  const kind = playerKind === 'maxplayer' ? 'maxplayer' : 'totalflix';
  const packageRow = await loadPackage(packageId);
  const quoted = quoteCost({
    plan,
    xuiPlan: plan,
    packageRow,
    emby: false,
    xui: true,
    maxplayer: kind === 'maxplayer',
  });
  if (actor.role === 'reseller' && actor.credits < quoted.cost) {
    throw new BusinessError(`Créditos insuficientes: XUI cuesta ${quoted.cost} y tienes ${actor.credits}`);
  }
  const xuiExpiry = toSqlDate(new Date(Date.now() + plan.duration_days * 24 * 3600 * 1000));
  const line = await X().createLine({
    username: account.username,
    password,
    expDate: xuiExpiry,
    maxConnections: lineConnections(plan, packageRow),
    packageId: packageRow.id,
    isTrial: !!packageRow.is_trial,
    bouquets: parseBouquets(packageRow.bouquets),
  });
  let mpId = null;
  let domainId = null;
  let provisionError = null;
  if (kind === 'maxplayer') {
    try {
      const created = await M().provisionUser({
        username: account.username,
        password,
        iptvUser: account.username,
        iptvPass: password,
        domainId: config.maxplayerDomainId,
      });
      mpId = created.userId;
      domainId = config.maxplayerDomainId || null;
    } catch (err) {
      provisionError = `Línea XUI creada, pero Max Player falló (${err.message}). Pulsa Reintentar: no se vuelve a cobrar.`;
    }
  }
  const next = Object.assign({}, account, { xui_expires_at: xuiExpiry, xui_line_id: line.id, player_kind: kind });
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE emby_accounts
       SET xui_line_id = ?, xui_package_id = ?, xui_package_name = ?, xui_bouquets = ?, player_kind = ?,
           xui_expires_at = ?, xui_cut = 0, expires_at = ?, status = 'active',
           maxplayer_user_id = COALESCE(?, maxplayer_user_id),
           maxplayer_domain_id = COALESCE(?, maxplayer_domain_id),
           maxplayer_list_ok = ?, provision_error = ?
       WHERE id = ?`
    ).run(
      line.id,
      packageRow.id,
      packageRow.package_name,
      JSON.stringify(parseBouquets(packageRow.bouquets)),
      kind,
      xuiExpiry,
      clockFrom(next),
      mpId,
      domainId,
      mpId ? 1 : 0,
      provisionError,
      account.id
    );
    chargeReseller(actor, quoted.cost, 'create_account', account.id);
  });
  tx();
  return { cost: quoted.cost, provisionError };
}

async function repairMaxPlayer({ accountId, actor }) {
  const account = loadOwned(accountId, actor);
  if (!account.maxplayer_user_id) throw new BusinessError('Esta cuenta no tiene usuario de Max Player');
  const pato = String(config.maxplayerDomainPatoId || '');
  const cisne = String(config.maxplayerDomainCisneId || '');
  if (!pato || !cisne) throw new BusinessError('Faltan MAXPLAYER_DOMAIN_PATO_ID y MAXPLAYER_DOMAIN_CISNE_ID');
  const password = account.password_enc ? secret.decrypt(account.password_enc) : null;
  if (!password) {
    throw new BusinessError('Falta la contraseña guardada para cambiar de servidor. Pon una nueva y pulsa Reparar otra vez.');
  }
  const current = String(account.maxplayer_domain_id || '');
  const target = current === pato ? cisne : pato;
  await M().deleteAllDevices(account.maxplayer_user_id);
  await M().replacePlaylist(account.maxplayer_user_id, {
    domainId: target,
    iptvUsername: account.username,
    iptvPassword: password,
  });
  saveProgress(account.id, { maxplayer_domain_id: target, maxplayer_list_ok: 1 });
  return {
    username: account.username,
    fromLabel: domainLabel(current),
    toLabel: domainLabel(target),
  };
}

async function listMaxPlayerDevices(userId) {
  const raw = await M().listCustomerDevices(userId);
  return raw.map((device) => ({
    id: String(device.id || device.device_id || ''),
    name: device.name || device.device_name || 'Dispositivo',
    app: device.device_type || device.model || '',
    lastActivity: device.last_seen || device.updated_at || '',
  }));
}

async function detailPayload(accountId, actor) {
  const account = loadDetail(accountId, actor);
  let embyDevices = [];
  let embyDevicesError = null;
  let mpDevices = [];
  let mpDevicesError = null;
  if (account.emby_user_id) {
    try {
      embyDevices = await listDevices(account.emby_user_id);
    } catch (err) {
      embyDevicesError = err.message;
    }
  }
  if (account.maxplayer_user_id) {
    try {
      mpDevices = await listMaxPlayerDevices(account.maxplayer_user_id);
    } catch (err) {
      mpDevicesError = err.message;
    }
  }
  return { account, embyDevices, embyDevicesError, mpDevices, mpDevicesError };
}

function loadDetail(accountId, actor) {
  const account = db
    .prepare(
      `SELECT a.*, p.username AS owner_name, pl.name AS plan, pl.duration_days, pl.screens AS plan_screens
       FROM emby_accounts a
       JOIN panel_users p ON p.id = a.owner_id
       LEFT JOIN plans pl ON pl.id = a.plan_id
       WHERE a.id = ? AND a.status != 'deleted'`
    )
    .get(accountId);
  if (!account) throw new BusinessError('Cuenta no encontrada');
  if (actor && actor.role === 'reseller' && account.owner_id !== actor.id) {
    throw new BusinessError('Esa cuenta no es tuya');
  }
  return account;
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
  extendService,
  addService,
  repairMaxPlayer,
  listMaxPlayerDevices,
  loadDetail,
  detailPayload,
  domainLabel,
  nextDomainLabel,
  accountListFilters,
  listAccounts,
  formatClientDate,
  clockFrom,
  setIntegrations,
};
