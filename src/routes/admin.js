const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db/database');
const accounts = require('../services/accounts');
const { memberIds, normalizeMemberIds, startSyncInBackground, jobSnapshot } = require('../services/xuiSync');
const { requirePanelRole } = require('../middleware/auth');

const router = express.Router();
router.use(requirePanelRole('admin'));

// Envuelve handlers async para que los errores lleguen al manejador global
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
      `SELECT a.username, a.expires_at, a.emby_user_id, a.emby_expires_at,
              a.xui_line_id, a.xui_expires_at, a.has_emby, a.is_trial,
              a.player_kind, a.maxplayer_user_id,
              p.username AS owner, pl.duration_days
       FROM emby_accounts a
       JOIN panel_users p ON p.id = a.owner_id
       LEFT JOIN plans pl ON pl.id = a.plan_id
       WHERE a.status = 'active' AND a.expires_at IS NOT NULL AND a.expires_at <= datetime('now', '+7 days')
       ORDER BY a.expires_at LIMIT 20`
    )
    .all();
  res.render('admin/dashboard', {
    stats,
    byReseller,
    upcoming,
    recent,
    daysLeft: accounts.daysLeft,
    dueServices: accounts.dueServices,
  });
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
  const packages = accounts.cachedXuiPackages();
  res.render('admin/plans', { plans, packages, xuiConfigured: require('../services/xui').isConfigured() });
});

function readPlanForm(body) {
  const name = (body.name || '').trim();
  const value = parseFloat(body.duration_value);
  const unit = body.duration_unit;
  const cost = parseInt(body.credit_cost, 10);
  const screens = parseInt(body.screens, 10);
  if (!name) throw new accounts.BusinessError('El plan necesita un nombre');
  if (!Number.isFinite(value) || value <= 0) throw new accounts.BusinessError('Duración inválida');
  if (!['horas', 'dias', 'meses'].includes(unit)) throw new accounts.BusinessError('Unidad de duración inválida');
  // Todo se guarda en días (las horas, como fracción de día)
  const days = unit === 'horas' ? Math.round((value / 24) * 10000) / 10000 : unit === 'meses' ? value * 30 : value;
  if (days > 3650) throw new accounts.BusinessError('La duración máxima es 10 años');
  if (!Number.isInteger(cost) || cost < 0) throw new accounts.BusinessError('Coste inválido');
  if (!Number.isInteger(screens) || screens < 1 || screens > 10) {
    throw new accounts.BusinessError('Las pantallas deben estar entre 1 y 10');
  }
  const xuiCost = parseInt(body.xui_credit_cost, 10);
  const maxCost = parseInt(body.maxplayer_credit_cost, 10);
  if (!Number.isInteger(xuiCost) || xuiCost < 0) throw new accounts.BusinessError('Coste XUI inválido');
  if (!Number.isInteger(maxCost) || maxCost < 0) throw new accounts.BusinessError('Coste Max Player inválido');
  return { name, days, cost, screens, xuiCost, maxCost };
}

router.post('/planes', (req, res) => {
  try {
    const p = readPlanForm(req.body);
    if (db.prepare('SELECT 1 FROM plans WHERE name = ?').get(p.name)) {
      throw new accounts.BusinessError('Ya existe un plan con ese nombre');
    }
    db.prepare(
      `INSERT INTO plans (name, duration_days, credit_cost, screens, xui_credit_cost, maxplayer_credit_cost)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(p.name, p.days, p.cost, p.screens, p.xuiCost, p.maxCost);
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
      .prepare(
        `UPDATE plans SET name = ?, duration_days = ?, credit_cost = ?, screens = ?,
         xui_credit_cost = ?, maxplayer_credit_cost = ? WHERE id = ?`
      )
      .run(p.name, p.days, p.cost, p.screens, p.xuiCost, p.maxCost, req.params.id);
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

router.post(
  '/paquetes/sync',
  wrap(async (req, res) => {
    try {
      const packages = await accounts.refreshXuiPackages();
      req.setFlash('ok', `${packages.length} paquetes XUI actualizados. El precio en créditos que ya tuvieran se conserva.`);
      res.redirect('/admin/planes');
    } catch (err) {
      backWithError(req, res, err, '/admin/planes');
    }
  })
);

router.post('/paquetes/coste', (req, res) => {
  try {
    const raw = req.body.credit_cost;
    const cost = raw === '' || raw == null ? null : parseInt(raw, 10);
    if (cost !== null && (!Number.isInteger(cost) || cost < 0)) {
      throw new accounts.BusinessError('El precio del paquete tiene que ser un número de créditos, o vacío para usar el del plan');
    }
    accounts.setPackageCost(req.body.package_id, cost);
    req.setFlash('ok', cost === null ? 'El paquete vuelve a usar el coste XUI del plan' : `Paquete a ${cost} créditos`);
    res.redirect('/admin/planes');
  } catch (err) {
    backWithError(req, res, err, '/admin/planes');
  }
});

// --- Cuentas de Emby (todas) ---

router.get(
  '/cuentas',
  wrap(async (req, res) => {
  const pageData = accounts.listAccounts(req.query, { base: '/admin/cuentas' });
  const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY duration_days, screens').all();
  const owners = db
    .prepare("SELECT id, username, role FROM panel_users WHERE is_active = 1 ORDER BY role, username")
    .all();
  const newAccount = req.session.newAccount || null;
  delete req.session.newAccount;
  const form = await accounts.packagesForForm();
  res.render('admin/accounts', {
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
    showReseller: true,
    plans,
    owners,
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
    formAction: '/admin/cuentas',
    syncJob: jobSnapshot(),
  });
  })
);

// Cambiar el plan de una cuenta sin tocar su fecha (corregir pantallas/plan)
router.post(
  '/cuentas/:id/plan',
  wrap(async (req, res) => {
    try {
      const { newPlan } = await accounts.changePlan({
        accountId: parseInt(req.params.id, 10),
        planId: parseInt(req.body.plan_id, 10),
        actor: req.user,
      });
      req.setFlash('ok', `Plan cambiado a ${newPlan.name} (la fecha de caducidad no cambia)`);
      res.redirect('/admin/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/admin/cuentas');
    }
  })
);

// Reenviar datos de conexión: rellena el modal en la siguiente carga de la lista
router.get('/cuentas/:id/datos', (req, res) => {
  try {
    req.session.newAccount = accounts.connectionData(parseInt(req.params.id, 10), req.user);
    res.redirect('/admin/cuentas');
  } catch (err) {
    backWithError(req, res, err, '/admin/cuentas');
  }
});

// Dispositivos con sesión iniciada en una cuenta
router.get(
  '/cuentas/:id/dispositivos',
  wrap(async (req, res) => {
    const account = db
      .prepare("SELECT * FROM emby_accounts WHERE id = ? AND status != 'deleted'")
      .get(req.params.id);
    if (!account) {
      req.setFlash('error', 'Cuenta no encontrada');
      return res.redirect('/admin/cuentas');
    }
    if (!account.emby_user_id) {
      req.setFlash('error', 'Esta cuenta no tiene usuario en Emby');
      return res.redirect('/admin/cuentas');
    }
    try {
      const devices = await accounts.listDevices(account.emby_user_id);
      res.render('devices', { account, devices, base: `/admin/cuentas/${account.id}/dispositivos`, backUrl: '/admin/cuentas' });
    } catch (err) {
      backWithError(req, res, err, '/admin/cuentas');
    }
  })
);

router.post(
  '/cuentas/:id/dispositivos/borrar',
  wrap(async (req, res) => {
    const back = `/admin/cuentas/${req.params.id}/dispositivos`;
    try {
      const account = db
        .prepare("SELECT * FROM emby_accounts WHERE id = ? AND status != 'deleted'")
        .get(req.params.id);
      if (!account) throw new accounts.BusinessError('Cuenta no encontrada');
      const device = await accounts.removeDevice({ account, deviceId: req.body.device_id });
      req.setFlash('ok', `Dispositivo "${device.name}" quitado: tendrá que iniciar sesión de nuevo`);
      res.redirect(back);
    } catch (err) {
      backWithError(req, res, err, back);
    }
  })
);

// Mover una cuenta a otro reseller (o al propio admin). Solo cambia la propiedad;
// no toca créditos ni fechas.
router.post('/cuentas/:id/mover', (req, res) => {
  try {
    const account = db
      .prepare("SELECT * FROM emby_accounts WHERE id = ? AND status != 'deleted'")
      .get(req.params.id);
    if (!account) throw new accounts.BusinessError('Cuenta no encontrada');
    const target = db
      .prepare('SELECT * FROM panel_users WHERE id = ? AND is_active = 1')
      .get(parseInt(req.body.owner_id, 10));
    if (!target) throw new accounts.BusinessError('Reseller de destino no válido');
    if (target.id === account.owner_id) throw new accounts.BusinessError('La cuenta ya pertenece a ese reseller');
    db.prepare('UPDATE emby_accounts SET owner_id = ? WHERE id = ?').run(target.id, account.id);
    req.setFlash('ok', `${account.username} movida a ${target.username}`);
    res.redirect('/admin/cuentas');
  } catch (err) {
    backWithError(req, res, err, '/admin/cuentas');
  }
});

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
      res.redirect('/admin/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/admin/cuentas');
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
      req.setFlash('ok', 'Contraseña cambiada en el panel y en cada servicio de la cuenta');
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
      req.setFlash('ok', 'Cuenta borrada en todos los servicios donde existía');
      res.redirect('/admin/cuentas');
    } catch (err) {
      backWithError(req, res, err, '/admin/cuentas');
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
        base: '/admin/cuentas',
        listUrl: '/admin/cuentas',
        newAccount,
      }));
    } catch (err) {
      backWithError(req, res, err, '/admin/cuentas');
    }
  })
);

router.get('/cuentas/sincronizar-xui/estado', (req, res) => {
  res.json(jobSnapshot());
});

router.post('/cuentas/sincronizar-xui', (req, res) => {
  const dryRun = req.body.simular === '1';
  const result = startSyncInBackground({ dryRun });
  req.setFlash(
    'ok',
    result.started
      ? 'Sincronización de XUI en curso. El avance se actualiza solo en esta página.'
      : 'Ya hay una sincronización de XUI en curso.'
  );
  res.redirect('/admin/cuentas');
});

router.post(
  '/cuentas/:id/reparar',
  wrap(async (req, res) => {
    const back = `/admin/cuentas/${req.params.id}`;
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
    const back = `/admin/cuentas/${req.params.id}`;
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
    const back = `/admin/cuentas/${req.params.id}`;
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

router.post('/resellers/:id/xui', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ids = normalizeMemberIds(req.body.xui_member_id);
    const others = db
      .prepare("SELECT id, username, xui_member_id FROM panel_users WHERE role = 'reseller' AND id != ? AND xui_member_id IS NOT NULL")
      .all(id);
    for (const row of others) {
      const clash = ids.find((memberId) => memberIds(row.xui_member_id).includes(memberId));
      if (clash) throw new accounts.BusinessError(`El member_id ${clash} ya está asignado a ${row.username}`);
    }
    const stored = ids.length ? ids.join(',') : null;
    const updated = db
      .prepare("UPDATE panel_users SET xui_member_id = ? WHERE id = ? AND role = 'reseller'")
      .run(stored, id);
    if (updated.changes === 0) throw new accounts.BusinessError('Reseller no encontrado');
    req.setFlash('ok', stored ? 'member_id de XUI guardado' : 'member_id de XUI quitado');
    res.redirect('/admin/resellers');
  } catch (err) {
    backWithError(req, res, err, '/admin/resellers');
  }
});

module.exports = router;
