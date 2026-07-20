const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const accounts = require('../services/accounts');
const { requirePanelRole } = require('../middleware/auth');

const router = express.Router();
router.use(requirePanelRole('admin'));

// Envuelve handlers async para que los errores lleguen al manejador global
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function backWithError(req, res, err, fallback) {
  const msg = err.name === 'BusinessError' || err.name === 'EmbyError' ? err.message : 'Error interno';
  if (err.name !== 'BusinessError' && err.name !== 'EmbyError') console.error(err);
  req.setFlash('error', msg);
  res.redirect(fallback);
}

// --- Dashboard ---

router.get('/', (req, res) => {
  const stats = {
    active: db.prepare("SELECT COUNT(*) n FROM emby_accounts WHERE status = 'active'").get().n,
    expired: db.prepare("SELECT COUNT(*) n FROM emby_accounts WHERE status = 'expired'").get().n,
    dueToday: db
      .prepare("SELECT COUNT(*) n FROM emby_accounts WHERE status = 'active' AND date(expires_at) <= date('now')")
      .get().n,
    dueWeek: db
      .prepare(
        "SELECT COUNT(*) n FROM emby_accounts WHERE status = 'active' AND expires_at <= datetime('now', '+7 days')"
      )
      .get().n,
    resellers: db.prepare("SELECT COUNT(*) n FROM panel_users WHERE role = 'reseller' AND is_active = 1").get().n,
    creditsSpent30: db
      .prepare(
        "SELECT COALESCE(-SUM(amount), 0) n FROM credit_transactions WHERE amount < 0 AND created_at >= datetime('now', '-30 days')"
      )
      .get().n,
  };
  const recent = db
    .prepare(
      `SELECT t.*, r.username AS reseller, a.username AS account
       FROM credit_transactions t
       JOIN panel_users r ON r.id = t.reseller_id
       LEFT JOIN emby_accounts a ON a.id = t.account_id
       ORDER BY t.id DESC LIMIT 8`
    )
    .all();
  const byReseller = db
    .prepare(
      `SELECT p.username, p.credits,
              SUM(CASE WHEN a.status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN a.status = 'expired' THEN 1 ELSE 0 END) AS expired
       FROM panel_users p
       LEFT JOIN emby_accounts a ON a.owner_id = p.id AND a.status != 'deleted'
       WHERE p.role = 'reseller'
       GROUP BY p.id ORDER BY p.username`
    )
    .all();
  const upcoming = db
    .prepare(
      `SELECT a.username, a.expires_at, p.username AS owner, pl.duration_days
       FROM emby_accounts a
       JOIN panel_users p ON p.id = a.owner_id
       LEFT JOIN plans pl ON pl.id = a.plan_id
       WHERE a.status = 'active' AND a.expires_at <= datetime('now', '+7 days')
       ORDER BY a.expires_at LIMIT 20`
    )
    .all();
  res.render('admin/dashboard', { stats, byReseller, upcoming, recent, daysLeft: accounts.daysLeft });
});

// --- Resellers ---

router.get('/resellers', (req, res) => {
  const resellers = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM emby_accounts a WHERE a.owner_id = p.id AND a.status != 'deleted') AS accounts
       FROM panel_users p WHERE p.role = 'reseller' ORDER BY p.username`
    )
    .all();
  res.render('admin/resellers', { resellers });
});

router.post('/resellers', (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new accounts.BusinessError('Usuario inválido (3-32 caracteres alfanuméricos)');
    if (password.length < 6) throw new accounts.BusinessError('La contraseña del reseller debe tener al menos 6 caracteres');
    if (db.prepare('SELECT 1 FROM panel_users WHERE username = ?').get(username)) {
      throw new accounts.BusinessError('Ese nombre de usuario ya existe');
    }
    db.prepare("INSERT INTO panel_users (username, password_hash, role) VALUES (?, ?, 'reseller')").run(
      username,
      bcrypt.hashSync(password, 10)
    );
    req.setFlash('ok', `Reseller ${username} creado`);
    res.redirect('/admin/resellers');
  } catch (err) {
    backWithError(req, res, err, '/admin/resellers');
  }
});

router.post('/resellers/:id/credits', (req, res) => {
  try {
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount === 0) throw new accounts.BusinessError('Cantidad inválida');
    accounts.addCredits(parseInt(req.params.id, 10), amount, req.user.id);
    req.setFlash('ok', amount > 0 ? `${amount} créditos añadidos` : `${-amount} créditos retirados`);
    res.redirect('/admin/resellers');
  } catch (err) {
    backWithError(req, res, err, '/admin/resellers');
  }
});

router.post('/resellers/:id/toggle', (req, res) => {
  db.prepare("UPDATE panel_users SET is_active = 1 - is_active WHERE id = ? AND role = 'reseller'").run(req.params.id);
  req.setFlash('ok', 'Estado del reseller actualizado');
  res.redirect('/admin/resellers');
});

router.post('/resellers/:id/password', (req, res) => {
  try {
    const password = req.body.password || '';
    if (password.length < 6) throw new accounts.BusinessError('La contraseña debe tener al menos 6 caracteres');
    const r = db
      .prepare("UPDATE panel_users SET password_hash = ? WHERE id = ? AND role = 'reseller'")
      .run(bcrypt.hashSync(password, 10), req.params.id);
    if (r.changes === 0) throw new accounts.BusinessError('Reseller no encontrado');
    req.setFlash('ok', 'Contraseña del reseller cambiada');
    res.redirect('/admin/resellers');
  } catch (err) {
    backWithError(req, res, err, '/admin/resellers');
  }
});

// --- Historial de créditos ---

router.get('/creditos', (req, res) => {
  const movements = db
    .prepare(
      `SELECT t.*, r.username AS reseller, pb.username AS by_user, a.username AS account
       FROM credit_transactions t
       JOIN panel_users r ON r.id = t.reseller_id
       JOIN panel_users pb ON pb.id = t.performed_by
       LEFT JOIN emby_accounts a ON a.id = t.account_id
       ORDER BY t.id DESC LIMIT 200`
    )
    .all();
  res.render('admin/credits', { movements });
});

// --- Planes ---

router.get('/planes', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans ORDER BY duration_days').all();
  res.render('admin/plans', { plans });
});

function readPlanForm(body) {
  const name = (body.name || '').trim();
  const days = parseInt(body.duration_days, 10);
  const cost = parseInt(body.credit_cost, 10);
  const screens = parseInt(body.screens, 10);
  if (!name) throw new accounts.BusinessError('El plan necesita un nombre');
  if (!Number.isInteger(days) || days <= 0) throw new accounts.BusinessError('Duración inválida');
  if (!Number.isInteger(cost) || cost < 0) throw new accounts.BusinessError('Coste inválido');
  if (!Number.isInteger(screens) || screens < 1 || screens > 10) {
    throw new accounts.BusinessError('Las pantallas deben estar entre 1 y 10');
  }
  return { name, days, cost, screens };
}

router.post('/planes', (req, res) => {
  try {
    const p = readPlanForm(req.body);
    if (db.prepare('SELECT 1 FROM plans WHERE name = ?').get(p.name)) {
      throw new accounts.BusinessError('Ya existe un plan con ese nombre');
    }
    db.prepare('INSERT INTO plans (name, duration_days, credit_cost, screens) VALUES (?, ?, ?, ?)').run(
      p.name,
      p.days,
      p.cost,
      p.screens
    );
    req.setFlash('ok', `Plan "${p.name}" creado`);
    res.redirect('/admin/planes');
  } catch (err) {
    backWithError(req, res, err, '/admin/planes');
  }
});

// Editar un plan. No afecta a cuentas ya creadas (guardan su fecha de caducidad);
// las próximas altas/renovaciones usan los valores nuevos.
router.post('/planes/:id/editar', (req, res) => {
  try {
    const p = readPlanForm(req.body);
    const dup = db.prepare('SELECT 1 FROM plans WHERE name = ? AND id != ?').get(p.name, req.params.id);
    if (dup) throw new accounts.BusinessError('Ya existe otro plan con ese nombre');
    const r = db
      .prepare('UPDATE plans SET name = ?, duration_days = ?, credit_cost = ?, screens = ? WHERE id = ?')
      .run(p.name, p.days, p.cost, p.screens, req.params.id);
    if (r.changes === 0) throw new accounts.BusinessError('Plan no encontrado');
    req.setFlash('ok', `Plan "${p.name}" actualizado`);
    res.redirect('/admin/planes');
  } catch (err) {
    backWithError(req, res, err, '/admin/planes');
  }
});

router.post('/planes/:id/toggle', (req, res) => {
  db.prepare('UPDATE plans SET is_active = 1 - is_active WHERE id = ?').run(req.params.id);
  req.setFlash('ok', 'Plan actualizado');
  res.redirect('/admin/planes');
});

// --- Cuentas de Emby (todas) ---

router.get('/cuentas', (req, res) => {
  const q = (req.query.q || '').trim();
  const estado = ['active', 'expired'].includes(req.query.estado) ? req.query.estado : '';
  let sql = `SELECT a.*, p.username AS owner, pl.name AS plan, pl.duration_days
             FROM emby_accounts a
             JOIN panel_users p ON p.id = a.owner_id
             LEFT JOIN plans pl ON pl.id = a.plan_id
             WHERE a.status != 'deleted'`;
  const params = [];
  if (q) {
    sql += ' AND (a.username LIKE ? OR p.username LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (estado) {
    sql += ' AND a.status = ?';
    params.push(estado);
  }
  sql += ' ORDER BY a.expires_at';
  const list = db.prepare(sql).all(...params);
  const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY duration_days, screens').all();
  res.render('admin/accounts', { list, plans, q, estado, daysLeft: accounts.daysLeft });
});

router.post(
  '/cuentas',
  wrap(async (req, res) => {
    try {
      await accounts.createAccount({
        username: req.body.username,
        password: req.body.password,
        planId: parseInt(req.body.plan_id, 10),
        owner: req.user,
        notes: req.body.notes,
      });
      req.setFlash('ok', `Cuenta ${req.body.username} creada en Emby`);
      res.redirect('/admin/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/admin/cuentas');
    }
  })
);

router.post(
  '/cuentas/:id/renovar',
  wrap(async (req, res) => {
    try {
      await accounts.renewAccount({
        accountId: parseInt(req.params.id, 10),
        planId: parseInt(req.body.plan_id, 10),
        actor: req.user,
      });
      req.setFlash('ok', 'Cuenta renovada');
      res.redirect('/admin/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/admin/cuentas');
    }
  })
);

router.post(
  '/cuentas/:id/password',
  wrap(async (req, res) => {
    try {
      await accounts.changePassword({
        accountId: parseInt(req.params.id, 10),
        newPassword: req.body.password,
        actor: req.user,
      });
      req.setFlash('ok', 'Contraseña cambiada (en Emby y en el panel)');
      res.redirect('/admin/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/admin/cuentas');
    }
  })
);

router.post(
  '/cuentas/:id/borrar',
  wrap(async (req, res) => {
    try {
      await accounts.deleteAccount({ accountId: parseInt(req.params.id, 10), actor: req.user });
      req.setFlash('ok', 'Cuenta borrada de Emby');
      res.redirect('/admin/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/admin/cuentas');
    }
  })
);

module.exports = router;
