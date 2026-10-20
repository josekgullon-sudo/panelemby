const express = require('express');
const config = require('../config');
const db = require('../db/database');
const accounts = require('../services/accounts');
const { requireClient } = require('../middleware/auth');

const router = express.Router();
router.use(requireClient);

router.get('/', (req, res) => {
  const plan = req.account.plan_id
    ? db.prepare('SELECT name, screens, duration_days FROM plans WHERE id = ?').get(req.account.plan_id)
    : null;
  const embyServer = accounts.embyServerFor(req.account);
  res.render('client/home', {
    account: req.account,
    plan,
    days: accounts.daysLeft(req.account.expires_at),
    embyUrl: (embyServer && embyServer.publicUrl) || config.embyPublicUrl,
    embyServerName: (embyServer && embyServer.name) || 'Servidor 1',
    xuiPublicUrl: config.xuiPublicUrl,
  });
});

module.exports = router;
