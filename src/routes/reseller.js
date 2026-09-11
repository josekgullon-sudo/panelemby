const express = require('express');
const config = require('../config');
const db = require('../db/database');
const accounts = require('../services/accounts');
const { requirePanelRole } = require('../middleware/auth');

const router = express.Router();
router.use(requirePanelRole('reseller'));

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
    credits: req.user.credits,
    active: db.prepare("SELECT COUNT(*) n FROM emby_accounts WHERE owner_id = ? AND status = 'active'").get(req.user.id).n,
    expired: db.prepare("SELECT COUNT(*) n FROM emby_accounts WHERE owner_id = ? AND status = 'expired'").get(req.user.id).n,
  };
  const upcoming = db
    .prepare(
      `SELECT a.username, a.expires_at, pl.duration_days
       FROM emby_accounts a LEFT JOIN plans pl ON pl.id = a.plan_id
       WHERE a.owner_id = ? AND a.status = 'active' AND a.expires_at <= datetime('now', '+7 days')
       ORDER BY a.expires_at LIMIT 20`
    )
    .all(req.user.id);
  const movements = db
    .prepare('SELECT * FROM credit_transactions WHERE reseller_id = ? ORDER BY id DESC LIMIT 10')
    .all(req.user.id);
  res.render('reseller/dashboard', { stats, upcoming, movements, daysLeft: accounts.daysLeft });
});

// --- Sus cuentas ---

router.get('/cuentas', (req, res) => {
  const q = (req.query.q || '').trim();
  const estado = ['active', 'expired'].includes(req.query.estado) ? req.query.estado : '';
  let sql = `SELECT a.*, pl.name AS plan, pl.duration_days
             FROM emby_accounts a LEFT JOIN plans pl ON pl.id = a.plan_id
             WHERE a.owner_id = ? AND a.status != 'deleted'`;
  const params = [req.user.id];
  if (q) {
    sql += ' AND a.username LIKE ?';
    params.push(`%${q}%`);
  }
  if (estado) {
    sql += ' AND a.status = ?';
    params.push(estado);
  }
  sql += ' ORDER BY a.expires_at';
  const list = db.prepare(sql).all(...params);
  const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY duration_days, screens').all();
  const newAccount = req.session.newAccount || null;
  delete req.session.newAccount;
  res.render('reseller/accounts', {
    list,
    plans,
    q,
    estado,
    newAccount,
    embyPublicUrl: config.embyPublicUrl,
    daysLeft: accounts.daysLeft,
  });
});

router.post(
  '/cuentas',
  wrap(async (req, res) => {
    try {
      const created = await accounts.createAccount({
        username: req.body.username,
        password: req.body.password,
        planId: parseInt(req.body.plan_id, 10),
        owner: req.user,
        notes: req.body.notes,
      });
      req.session.newAccount = {
        username: req.body.username.trim(),
        password: req.body.password,
        expiresAt: created.expiresAt,
        plan: created.plan.name,
        screens: created.plan.screens,
      };
      res.redirect('/reseller/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/reseller/cuentas');
    }
  })
);

// Cambiar el plan de una cuenta sin tocar su fecha (misma duración; cobra/abona diferencia)
router.post(
  '/cuentas/:id/plan',
  wrap(async (req, res) => {
    try {
      const { newPlan, diff } = await accounts.changePlan({
        accountId: parseInt(req.params.id, 10),
        planId: parseInt(req.body.plan_id, 10),
        actor: req.user,
      });
      const extra = diff > 0 ? ` (−${diff} créditos)` : diff < 0 ? ` (+${-diff} créditos devueltos)` : '';
      req.setFlash('ok', `Plan cambiado a ${newPlan.name}${extra}`);
      res.redirect('/reseller/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/reseller/cuentas');
    }
  })
);

// Borrar una cuenta propia: la elimina de Emby y la deja como historial en el panel
router.post(
  '/cuentas/:id/borrar',
  wrap(async (req, res) => {
    try {
      await accounts.deleteAccount({ accountId: parseInt(req.params.id, 10), actor: req.user });
      req.setFlash('ok', 'Cuenta borrada de Emby');
      res.redirect('/reseller/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/reseller/cuentas');
    }
  })
);

// Reenviar datos de conexión (solo cuentas propias)
router.get('/cuentas/:id/datos', (req, res) => {
  try {
    req.session.newAccount = accounts.connectionData(parseInt(req.params.id, 10), req.user);
    res.redirect('/reseller/cuentas');
  } catch (err) {
    backWithError(req, res, err, '/reseller/cuentas');
  }
});

// Dispositivos con sesión iniciada en una cuenta (solo cuentas propias)
router.get(
  '/cuentas/:id/dispositivos',
  wrap(async (req, res) => {
    const account = db
      .prepare("SELECT * FROM emby_accounts WHERE id = ? AND owner_id = ? AND status != 'deleted'")
      .get(req.params.id, req.user.id);
    if (!account) {
      req.setFlash('error', 'Cuenta no encontrada');
      return res.redirect('/reseller/cuentas');
    }
    try {
      const devices = await accounts.listDevices(account.emby_user_id);
      res.render('devices', { account, devices, base: `/reseller/cuentas/${account.id}/dispositivos`, backUrl: '/reseller/cuentas' });
    } catch (err) {
      backWithError(req, res, err, '/reseller/cuentas');
    }
  })
);

router.post(
  '/cuentas/:id/dispositivos/borrar',
  wrap(async (req, res) => {
    const back = `/reseller/cuentas/${req.params.id}/dispositivos`;
    try {
      const account = db
        .prepare("SELECT * FROM emby_accounts WHERE id = ? AND owner_id = ? AND status != 'deleted'")
        .get(req.params.id, req.user.id);
      if (!account) throw new accounts.BusinessError('Cuenta no encontrada');
      const device = await accounts.removeDevice({ account, deviceId: req.body.device_id });
      req.setFlash('ok', `Dispositivo "${device.name}" quitado: tendrá que iniciar sesión de nuevo`);
      res.redirect(back);
    } catch (err) {
      backWithError(req, res, err, back);
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
      res.redirect('/reseller/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/reseller/cuentas');
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
      res.redirect('/reseller/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/reseller/cuentas');
    }
  })
);

module.exports = router;
