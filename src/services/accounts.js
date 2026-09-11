// Lógica de negocio: altas, renovaciones y créditos.
// Regla de oro: cualquier operación que toque créditos + BD va en una
// transacción SQLite; la llamada a Emby se hace antes, y si la parte de BD
// falla se compensa borrando/revirtiendo en Emby.

const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db/database');
const emby = require('./emby');
const secret = require('./secret');

class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
  }
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
  const raw = await emby.getVirtualFolders();
  const libs = Array.isArray(raw) ? raw : raw.Items || [];
  const lib = libs.find((l) => l.Name === config.expiryLibrary);
  if (!lib) {
    throw new BusinessError(
      `No existe en Emby ninguna biblioteca llamada "${config.expiryLibrary}" (revisa EXPIRY_LIBRARY en el .env)`
    );
  }
  showcaseLibraryIdCache = lib.ItemId || lib.Id;
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
  const raw = await emby.getVirtualFolders();
  const libs = Array.isArray(raw) ? raw : raw.Items || [];
  const ids = libs.filter((l) => l.Name !== config.expiryLibrary).map((l) => l.ItemId || l.Id);
  return { EnableAllFolders: false, EnabledFolders: ids };
}

async function restoredPolicyPatch() {
  if (config.expiryMode !== 'vitrina') return { IsDisabled: false };
  return { IsDisabled: false, ...(await activeLibrariesPatch()) };
}

// --- Dispositivos de una cuenta ---

// Lista los dispositivos cuyo último usuario es esta cuenta, marcando cuáles
// están conectados ahora mismo (y qué reproducen).
async function listDevices(embyUserId) {
  const [rawDevices, rawSessions] = await Promise.all([
    emby.getDevices(),
    emby.getSessions().catch(() => []),
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

// Quita un dispositivo de una cuenta (revoca la sesión de ese aparato en Emby).
// Verifica que el dispositivo pertenece de verdad a esa cuenta.
async function removeDevice({ account, deviceId }) {
  const devices = await listDevices(account.emby_user_id);
  const device = devices.find((d) => d.id === deviceId);
  if (!device) throw new BusinessError('Ese dispositivo no pertenece a esta cuenta');
  await emby.deleteDevice(deviceId);
  return device;
}

// --- Cuentas de Emby ---

// Alta completa: crea en Emby, guarda en BD y descuenta créditos (si el dueño es reseller).
async function createAccount({ username, password, planId, owner, notes }) {
  username = username.trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new BusinessError('Usuario inválido: 3-32 caracteres, solo letras, números, punto, guion y guion bajo');
  }
  if (!password || password.length < 4) {
    throw new BusinessError('La contraseña debe tener al menos 4 caracteres');
  }
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
  if (!plan) throw new BusinessError('Plan no válido');
  const taken = db.prepare('SELECT 1 FROM emby_accounts WHERE username = ?').get(username);
  if (taken) throw new BusinessError('Ese nombre de usuario ya existe en el panel');
  if (owner.role === 'reseller' && owner.credits < plan.credit_cost) {
    throw new BusinessError(`Créditos insuficientes: el plan cuesta ${plan.credit_cost} y tienes ${owner.credits}`);
  }

  // 1) Emby primero (es lo que puede fallar por red): pantallas del plan y,
  // en modo vitrina, acceso a todas las bibliotecas menos el cartel
  const embyUser = await emby.createUser(username, password);
  try {
    const patch = { SimultaneousStreamLimit: plan.screens || 1, ...(await activeLibrariesPatch()) };
    await emby.updatePolicy(embyUser.Id, patch);
  } catch (err) {
    await emby.deleteUser(embyUser.Id).catch(() => {});
    throw err;
  }

  // 2) BD en transacción; si falla, compensamos borrando el usuario recién creado en Emby
  try {
    const expiresAt = toSqlDate(new Date(Date.now() + plan.duration_days * 24 * 3600 * 1000));
    const passwordHash = bcrypt.hashSync(password, 10);
    const insertTx = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO emby_accounts (emby_user_id, username, password_hash, password_enc, owner_id, plan_id, expires_at, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
        )
        .run(embyUser.Id, username, passwordHash, secret.encrypt(password), owner.id, plan.id, expiresAt, notes || null);
      if (owner.role === 'reseller') {
        deductCredits(owner.id, plan.credit_cost, 'create_account', info.lastInsertRowid, owner.id);
      }
      return info.lastInsertRowid;
    });
    const accountId = insertTx();
    return { id: accountId, expiresAt, plan };
  } catch (err) {
    await emby.deleteUser(embyUser.Id).catch(() => {});
    throw err;
  }
}

// Renovación: extiende la caducidad desde max(ahora, caducidad actual).
// Si la cuenta estaba caducada (desactivada en Emby), la reactiva.
async function renewAccount({ accountId, planId, actor }) {
  const account = db.prepare("SELECT * FROM emby_accounts WHERE id = ? AND status != 'deleted'").get(accountId);
  if (!account) throw new BusinessError('Cuenta no encontrada');
  if (actor.role === 'reseller' && account.owner_id !== actor.id) {
    throw new BusinessError('Esa cuenta no es tuya');
  }
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
  if (!plan) throw new BusinessError('Plan no válido');
  if (actor.role === 'reseller' && actor.credits < plan.credit_cost) {
    throw new BusinessError(`Créditos insuficientes: el plan cuesta ${plan.credit_cost} y tienes ${actor.credits}`);
  }

  // Todo lo de Emby ANTES de tocar la BD (si falla, no se cobra nada):
  // restaurar el acceso si estaba caducada y aplicar las pantallas del plan.
  const policyPatch = { SimultaneousStreamLimit: plan.screens || 1 };
  if (account.status === 'expired') {
    Object.assign(policyPatch, await restoredPolicyPatch());
  }
  await emby.updatePolicy(account.emby_user_id, policyPatch);

  const base = Math.max(Date.now(), parseSqlDate(account.expires_at).getTime());
  const newExpiry = toSqlDate(new Date(base + plan.duration_days * 24 * 3600 * 1000));

  const renewTx = db.transaction(() => {
    db.prepare("UPDATE emby_accounts SET expires_at = ?, status = 'active', plan_id = ? WHERE id = ?").run(
      newExpiry,
      plan.id,
      account.id
    );
    if (actor.role === 'reseller') {
      deductCredits(actor.id, plan.credit_cost, 'renew', account.id, actor.id);
    }
  });
  renewTx();
  return newExpiry;
}

// Cambia la contraseña en Emby y el hash del panel a la vez.
async function changePassword({ accountId, newPassword, actor }) {
  const account = db.prepare("SELECT * FROM emby_accounts WHERE id = ? AND status != 'deleted'").get(accountId);
  if (!account) throw new BusinessError('Cuenta no encontrada');
  if (actor.role === 'reseller' && account.owner_id !== actor.id) {
    throw new BusinessError('Esa cuenta no es tuya');
  }
  if (!newPassword || newPassword.length < 4) {
    throw new BusinessError('La contraseña debe tener al menos 4 caracteres');
  }
  await emby.setPassword(account.emby_user_id, newPassword);
  db.prepare('UPDATE emby_accounts SET password_hash = ?, password_enc = ? WHERE id = ?').run(
    bcrypt.hashSync(newPassword, 10),
    secret.encrypt(newPassword),
    account.id
  );
}

// Cambia el plan de una cuenta SIN tocar la fecha de caducidad — para corregir
// errores (1 pantalla en vez de 2, plan equivocado). Aplica las pantallas del
// nuevo plan en Emby. Los resellers solo pueden cambiar entre planes de la misma
// duración, cobrando o abonando la diferencia de créditos.
async function changePlan({ accountId, planId, actor }) {
  const account = db.prepare("SELECT * FROM emby_accounts WHERE id = ? AND status != 'deleted'").get(accountId);
  if (!account) throw new BusinessError('Cuenta no encontrada');
  if (actor.role === 'reseller' && account.owner_id !== actor.id) {
    throw new BusinessError('Esa cuenta no es tuya');
  }
  const newPlan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
  if (!newPlan) throw new BusinessError('Plan no válido');
  if (newPlan.id === account.plan_id) throw new BusinessError('La cuenta ya tiene ese plan');

  let diff = 0;
  if (actor.role === 'reseller') {
    const oldPlan = account.plan_id ? db.prepare('SELECT * FROM plans WHERE id = ?').get(account.plan_id) : null;
    if (!oldPlan || oldPlan.duration_days !== newPlan.duration_days) {
      throw new BusinessError('Solo puedes cambiar entre planes de la misma duración; para ampliar tiempo usa Renovar');
    }
    diff = newPlan.credit_cost - oldPlan.credit_cost;
    if (diff > 0 && actor.credits < diff) {
      throw new BusinessError(`Créditos insuficientes: el cambio cuesta ${diff} y tienes ${actor.credits}`);
    }
  }

  // Emby primero: si falla, no se toca nada en el panel
  await emby.setStreamLimit(account.emby_user_id, newPlan.screens || 1);

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

// Datos de conexión de una cuenta, para reenviárselos a un cliente que los perdió.
// La contraseña solo se conoce si la cuenta se creó (o se le cambió la contraseña)
// después de incorporar el cifrado reversible.
function connectionData(accountId, actor) {
  const account = db
    .prepare(
      `SELECT a.*, p.name AS plan_name, p.screens AS plan_screens
       FROM emby_accounts a LEFT JOIN plans p ON p.id = a.plan_id
       WHERE a.id = ? AND a.status != 'deleted'`
    )
    .get(accountId);
  if (!account) throw new BusinessError('Cuenta no encontrada');
  if (actor.role === 'reseller' && account.owner_id !== actor.id) {
    throw new BusinessError('Esa cuenta no es tuya');
  }
  return {
    mode: 'resend',
    username: account.username,
    password: account.password_enc ? secret.decrypt(account.password_enc) : null,
    plan: account.plan_name,
    screens: account.plan_screens,
    expiresAt: account.expires_at,
  };
}

// Marca una cuenta como borrada liberando su nombre de usuario: la fila se
// conserva como historial (con sufijo #del) y el nombre queda libre para
// crear una cuenta nueva que se llame igual.
function markDeleted(accountId) {
  db.prepare(
    "UPDATE emby_accounts SET status = 'deleted', username = username || '#del' || id WHERE id = ?"
  ).run(accountId);
}

// Borrado manual: elimina en Emby y marca como 'deleted' en el panel (historial se conserva).
async function deleteAccount({ accountId, actor }) {
  const account = db.prepare("SELECT * FROM emby_accounts WHERE id = ? AND status != 'deleted'").get(accountId);
  if (!account) throw new BusinessError('Cuenta no encontrada');
  if (actor.role === 'reseller' && account.owner_id !== actor.id) {
    throw new BusinessError('Esa cuenta no es tuya');
  }
  await emby.deleteUser(account.emby_user_id).catch((err) => {
    // Si Emby ya no la tiene (404), seguimos; otros errores sí abortan
    if (err.status !== 404) throw err;
  });
  markDeleted(account.id);
}

module.exports = {
  BusinessError,
  toSqlDate,
  parseSqlDate,
  daysLeft,
  formatDuration,
  addCredits,
  createAccount,
  renewAccount,
  changePassword,
  changePlan,
  connectionData,
  markDeleted,
  deleteAccount,
  activeLibrariesPatch,
  listDevices,
  removeDevice,
  expiredPolicyPatch,
  restoredPolicyPatch,
};
