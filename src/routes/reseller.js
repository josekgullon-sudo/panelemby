const express = require('express');
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
      `SELECT username, expires_at FROM emby_accounts
       WHERE owner_id = ? AND status = 'active' AND expires_at <= datetime('now', '+7 days')
       ORDER BY expires_at LIMIT 20`
    )
    .all(req.user.id);
  const movements = db
    .prepare('SELECT * FROM credit_transactions WHERE reseller_id = ? ORDER BY id DESC LIMIT 10')
    .all(req.user.id);
  res.render('reseller/dashboard', { stats, upcoming, movements, daysLeft: accounts.daysLeft });
});

// --- Sus cuentas ---

router.get('/cuentas', (req, res) => {
  const list = db
    .prepare(
      `SELECT a.*, pl.name AS plan
       FROM emby_accounts a LEFT JOIN plans pl ON pl.id = a.plan_id
       WHERE a.owner_id = ? AND a.status != 'deleted'
       ORDER BY a.expires_at`
    )
    .all(req.user.id);
  const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY duration_days').all();
  res.render('reseller/accounts', { list, plans, daysLeft: accounts.daysLeft });
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
      res.redirect('/reseller/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/reseller/cuentas');
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
