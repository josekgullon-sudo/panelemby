// Lógica de negocio: altas, renovaciones y créditos.
// Regla de oro: cualquier operación que toque créditos + BD va en una
// transacción SQLite; la llamada a Emby se hace antes, y si la parte de BD
// falla se compensa borrando/revirtiendo en Emby.

const bcrypt = require('bcryptjs');
const db = require('../db/database');
const emby = require('./emby');

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

  // 1) Emby primero (es lo que puede fallar por red)
  const embyUser = await emby.createUser(username, password);
  try {
    await emby.setStreamLimit(embyUser.Id, plan.screens || 1);
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
          `INSERT INTO emby_accounts (emby_user_id, username, password_hash, owner_id, plan_id, expires_at, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
        )
        .run(embyUser.Id, username, passwordHash, owner.id, plan.id, expiresAt, notes || null);
      if (owner.role === 'reseller') {
        deductCredits(owner.id, plan.credit_cost, 'create_account', info.lastInsertRowid, owner.id);
      }
      return info.lastInsertRowid;
    });
    return insertTx();
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
  // reactivar si estaba caducada y aplicar las pantallas del plan elegido.
  const policyPatch = { SimultaneousStreamLimit: plan.screens || 1 };
  if (account.status === 'expired') {
    policyPatch.IsDisabled = false;
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
  db.prepare('UPDATE emby_accounts SET password_hash = ? WHERE id = ?').run(
    bcrypt.hashSync(newPassword, 10),
    account.id
  );
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
  db.prepare("UPDATE emby_accounts SET status = 'deleted' WHERE id = ?").run(account.id);
}

module.exports = {
  BusinessError,
  toSqlDate,
  parseSqlDate,
  daysLeft,
  addCredits,
  createAccount,
  renewAccount,
  changePassword,
  deleteAccount,
};
