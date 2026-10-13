const express = require('express');
const config = require('../config');
const db = require('../db/database');
const accounts = require('../services/accounts');
const { requirePanelRole } = require('../middleware/auth');

const router = express.Router();
router.use(requirePanelRole('reseller'));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function backWithError(req, res, err, fallback) {
  const known = accounts.isUserFacingError(err);
  const msg = known ? err.message : 'Error interno';
  if (!known) console.error(err);
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
      `SELECT a.username, a.expires_at, a.emby_user_id, a.emby_expires_at,
              a.xui_line_id, a.xui_expires_at, a.has_emby, a.is_trial, pl.duration_days
       FROM emby_accounts a LEFT JOIN plans pl ON pl.id = a.plan_id
       WHERE a.owner_id = ? AND a.status = 'active' AND a.expires_at <= datetime('now', '+7 days')
       ORDER BY a.expires_at LIMIT 20`
    )
    .all(req.user.id);
  const movements = db
    .prepare('SELECT * FROM credit_transactions WHERE reseller_id = ? ORDER BY id DESC LIMIT 10')
    .all(req.user.id);
  res.render('reseller/dashboard', {
    stats,
    upcoming,
    movements,
    daysLeft: accounts.daysLeft,
    dueServices: accounts.dueServices,
  });
});

// --- Sus cuentas ---

router.get(
  '/cuentas',
  wrap(async (req, res) => {
  const pageData = accounts.listAccounts(req.query, { ownerId: req.user.id, base: '/reseller/cuentas' });
  const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY duration_days, screens').all();
  const newAccount = req.session.newAccount || null;
  delete req.session.newAccount;
  const form = await accounts.packagesForForm();
  res.render('reseller/accounts', {
    list: pageData.list,
    total: pageData.total,
    pageNum: pageData.page,
    pages: pageData.pages,
    pageSize: pageData.pageSize,
    rangeFrom: pageData.from,
    rangeTo: pageData.to,
    pageWindow: pageData.pageWindow,
    pageHref: (n) => pageData.href(n),
    sort: pageData.sort,
    dir: pageData.dir,
    reseller: pageData.reseller,
    showReseller: false,
    owners: [],
    plans,
    q: pageData.q,
    estado: pageData.estado,
    servicio: pageData.servicio,
    dominio: pageData.dominio,
    tipo: pageData.tipo,
    newAccount,
    embyPublicUrl: config.embyPublicUrl,
    daysLeft: accounts.daysLeft,
    packages: form.packages,
    xuiConfigured: form.xuiConfigured,
    maxplayerConfigured: form.maxplayerConfigured,
    xuiNotice: form.notice,
    formAction: '/reseller/cuentas',
  });
  })
);

router.post(
  '/cuentas',
  wrap(async (req, res) => {
    try {
      const services = accounts.parseServices(req.body);
      const planId = services.emby ? parseInt(req.body.plan_id, 10) : parseInt(req.body.xui_plan_id, 10);
      const created = await accounts.createAccount({
        username: req.body.username,
        password: req.body.password,
        planId,
        owner: req.user,
        notes: req.body.notes,
        services,
      });
      const card = accounts.connectionCard(created.id, req.user);
      card.mode = 'created';
      req.session.newAccount = card;
      if (created.provisionError) req.setFlash('error', created.provisionError);
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
      req.setFlash('ok', 'Cuenta borrada en todos los servicios donde existía');
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
    if (!account.emby_user_id) {
      req.setFlash('error', 'Esta cuenta no tiene usuario en Emby');
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
  '/cuentas/:id/reintentar',
  wrap(async (req, res) => {
    try {
      const result = await accounts.retryProvision({
        accountId: parseInt(req.params.id, 10),
        actor: req.user,
      });
      if (result.provisionError) req.setFlash('error', result.provisionError);
      else req.setFlash('ok', 'Servicios pendientes creados');
      const card = accounts.connectionCard(parseInt(req.params.id, 10), req.user);
      card.mode = 'resend';
      req.session.newAccount = card;
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
      req.setFlash('ok', 'Contraseña cambiada en el panel y en cada servicio de la cuenta');
      res.redirect('/reseller/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/reseller/cuentas');
    }
  })
);

router.get(
  '/cuentas/:id',
  wrap(async (req, res) => {
    try {
      const payload = await accounts.detailPayload(parseInt(req.params.id, 10), req.user);
      const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY duration_days, screens').all();
      const form = await accounts.packagesForForm();
      const newAccount = req.session.newAccount || null;
      delete req.session.newAccount;
      res.render('account-detail', Object.assign(payload, {
        plans,
        packages: form.packages,
        maxplayerConfigured: form.maxplayerConfigured,
        base: '/reseller/cuentas',
        listUrl: '/reseller/cuentas',
        newAccount,
      }));
    } catch (err) {
      backWithError(req, res, err, '/reseller/cuentas');
    }
  })
);

router.post(
  '/cuentas/:id/reparar',
  wrap(async (req, res) => {
    const back = `/reseller/cuentas/${req.params.id}`;
    try {
      const result = await accounts.repairMaxPlayer({ accountId: parseInt(req.params.id, 10), actor: req.user });
      req.setFlash('ok', `Max Player de ${result.username} reparado: dispositivos cerrados y servidor cambiado de ${result.fromLabel} a ${result.toLabel}.`);
      res.redirect(back);
    } catch (err) {
      backWithError(req, res, err, back);
    }
  })
);

router.post(
  '/cuentas/:id/ampliar',
  wrap(async (req, res) => {
    const back = `/reseller/cuentas/${req.params.id}`;
    try {
      const result = await accounts.extendService({
        accountId: parseInt(req.params.id, 10),
        actor: req.user,
        service: req.body.service,
        planId: parseInt(req.body.plan_id, 10),
      });
      req.setFlash('ok', `${result.service === 'emby' ? 'Emby' : 'XUI'} ampliado hasta ${String(result.expiresAt).slice(0, 16)}.`);
      res.redirect(back);
    } catch (err) {
      backWithError(req, res, err, back);
    }
  })
);

router.post(
  '/cuentas/:id/servicio',
  wrap(async (req, res) => {
    const back = `/reseller/cuentas/${req.params.id}`;
    try {
      const result = await accounts.addService({
        accountId: parseInt(req.params.id, 10),
        actor: req.user,
        service: req.body.service,
        planId: parseInt(req.body.plan_id, 10),
        packageId: req.body.xui_package_id,
        playerKind: req.body.player_kind,
      });
      const card = accounts.connectionCard(parseInt(req.params.id, 10), req.user);
      card.mode = 'created';
      req.session.newAccount = card;
      if (result.provisionError) req.setFlash('error', result.provisionError);
      else req.setFlash('ok', 'Servicio añadido');
      res.redirect(back);
    } catch (err) {
      backWithError(req, res, err, back);
    }
  })
);

module.exports = router;
