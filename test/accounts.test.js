require('./env');

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../src/db/database');
const accounts = require('../src/services/accounts');

let reseller;
let plan;
let planB;
let seq = 0;

function creditsOf(id) {
  return db.prepare('SELECT credits FROM panel_users WHERE id = ?').get(id).credits;
}

function install(overrides = {}) {
  const calls = [];
  const emby = Object.assign(
    {
      createUser: async (name) => {
        calls.push(['emby.create', name]);
        return { Id: `e-${name}` };
      },
      updatePolicy: async (id, patch) => calls.push(['emby.policy', id, patch]),
      setPassword: async (id, pw) => calls.push(['emby.pw', id, pw]),
      renameUser: async (id, name) => calls.push(['emby.rename', id, name]),
      setStreamLimit: async (id, n) => calls.push(['emby.streams', id, n]),
      deleteUser: async (id) => calls.push(['emby.del', id]),
      getVirtualFolders: async () => [],
      getDevices: async () => [],
      getSessions: async () => [],
    },
    overrides.emby
  );
  const xui = Object.assign(
    {
      isConfigured: () => true,
      getPackages: async () => [
        {
          id: '7',
          package_name: 'Full',
          is_trial: false,
          is_official: true,
          trial_duration: null,
          official_duration: 720,
          max_connections: 2,
          bouquets: ['1', '2'],
        },
      ],
      createLine: async (body) => {
        calls.push(['xui.create', body.username, body.packageId]);
        seq += 1;
        return { id: `line-${seq}` };
      },
      editLine: async (id, fields) => calls.push(['xui.edit', id, fields]),
      findLineByUsername: async (name) => {
        calls.push(['xui.find', name]);
        return null;
      },
      deleteLine: async (id) => calls.push(['xui.del', id]),
      enableLine: async (id) => calls.push(['xui.enable', id]),
      disableLine: async (id) => calls.push(['xui.disable', id]),
    },
    overrides.xui
  );
  const maxplayer = Object.assign(
    {
      isConfigured: () => true,
      provisionUser: async (body) => {
        calls.push(['mp.create', body.username]);
        seq += 1;
        return { userId: `mp-${seq}` };
      },
      deleteUser: async (id) => calls.push(['mp.del', id]),
      attachPlaylist: async (id, body) => calls.push(['mp.list', id, body]),
      changePassword: async (id, pw) => calls.push(['mp.pw', id, pw]),
      setDeviceLimit: async (id, n) => calls.push(['mp.limit', id, n]),
      deleteDevices: async (id) => calls.push(['mp.devices', id]),
    },
    overrides.maxplayer
  );
  const hotplayer = Object.assign(
    {
      isConfigured: () => true,
      normalizeMac: (raw) => {
        const text = String(raw || '').trim().toUpperCase();
        if (!text || /[^0-9A-F\s:.-]/.test(text)) return '';
        const compact = text.replace(/[\s:.-]/g, '');
        if (!/^[0-9A-F]{12}$/.test(compact)) return '';
        return compact.match(/.{2}/g).join(':');
      },
      addPlaylist: async (mac, body) => {
        calls.push(['hot.add', mac, body && body.username, body && body.name]);
        return { status: 'success' };
      },
    },
    overrides.hotplayer
  );
  accounts.setIntegrations({ emby, xui, maxplayer, hotplayer });
  return calls;
}

before(() => {
  const hash = bcrypt.hashSync('secret', 4);
  db.prepare("INSERT INTO panel_users (username, password_hash, role, credits) VALUES ('resi', ?, 'reseller', 50)").run(hash);
  reseller = db.prepare("SELECT * FROM panel_users WHERE username = 'resi'").get();
  const id = db
    .prepare(
      `INSERT INTO plans (name, duration_days, credit_cost, screens, xui_credit_cost, maxplayer_credit_cost)
       VALUES ('Plan test', 30, 1, 1, 2, 3)`
    )
    .run().lastInsertRowid;
  plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  const idB = db
    .prepare(
      `INSERT INTO plans (name, duration_days, credit_cost, screens, xui_credit_cost, maxplayer_credit_cost)
       VALUES ('Plan test 2', 30, 4, 2, 5, 6)`
    )
    .run().lastInsertRowid;
  planB = db.prepare('SELECT * FROM plans WHERE id = ?').get(idB);
});

beforeEach(() => install());

after(() => {
  accounts.setIntegrations({ emby: null, xui: null, maxplayer: null, hotplayer: null });
  db.close();
});

function actor() {
  return db.prepare('SELECT * FROM panel_users WHERE id = ?').get(reseller.id);
}

test('el precio suma Emby, el paquete XUI si tiene precio propio, y Max Player', () => {
  const quoted = accounts.quoteCost({
    plan,
    packageRow: { credit_cost: 10 },
    emby: true,
    xui: true,
    maxplayer: true,
  });
  assert.equal(quoted.cost, 1 + 10 + 3);
  const fallback = accounts.quoteCost({ plan, packageRow: { credit_cost: null }, emby: false, xui: true, maxplayer: false });
  assert.equal(fallback.cost, 2);
});

test('solo Emby no llama a XUI y cobra el coste de siempre', async () => {
  const calls = install();
  const beforeCredits = creditsOf(reseller.id);
  const created = await accounts.createAccount({
    username: 'solo.emby',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: false },
  });
  assert.equal(created.provisionError, null);
  assert.equal(created.cost, 1);
  assert.equal(creditsOf(reseller.id), beforeCredits - 1);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['emby.create', 'emby.policy']
  );
  const row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.emby_user_id, 'e-solo.emby');
  assert.equal(row.xui_line_id, null);
  assert.equal(row.player_kind, null);
  const card = accounts.connectionCard(created.id, actor());
  const vence = String(row.emby_expires_at).slice(0, 10);
  assert.equal(
    card.message,
    [
      '🎬 ¡Bienvenido a Totalflix!',
      '',
      '📺 Emby',
      'Servidor: http://emby.example',
      'Puerto: dejar vacío',
      'Usuario: solo.emby',
      'Contraseña: clave',
      'Pantallas: 1',
      '',
      '📦 Plan: Plan test',
      `📅 Vence: ${vence}`,
    ].join('\n')
  );
});

test('TotalFlix crea la línea y no llama a Max Player', async () => {
  const calls = install();
  const created = await accounts.createAccount({
    username: 'solo.xui',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: false, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  assert.equal(created.cost, 2);
  assert.ok(calls.some((c) => c[0] === 'xui.create'));
  assert.equal(calls.some((c) => c[0] === 'mp.create'), false);
  const row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.ok(row.xui_line_id);
  assert.equal(row.player_kind, 'totalflix');
  assert.equal(row.has_emby, 0);
  const card = accounts.connectionCard(created.id, actor());
  assert.match(card.message, /📡 TOTALFLIX/);
  assert.equal(card.message.replaceAll(card.username, '').toLowerCase().includes('xui'), false);
  assert.match(card.message, /📅 Vence: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.equal(card.message.includes('m3u'), false);
  assert.match(card.m3u, /iptv\.test:8080/);
  assert.match(card.m3u, /username=solo\.xui/);
  const days = (accounts.parseSqlDate(row.xui_expires_at).getTime() - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31, `la duración sale del paquete, no de otro selector: ${days}`);
});

test('la duración de XUI es la del paquete aunque el plan de Emby sea otro', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  db.prepare(
    `INSERT INTO xui_packages (
       id, package_name, is_trial, is_official, trial_duration, official_duration,
       max_connections, credit_cost, is_listed
     ) VALUES ('year', '1 AÑO- 1 CONEXION', 0, 1, NULL, 8760, 1, 9, 1)`
  ).run();
  const calls = install({
    xui: {
      createLine: async (body) => {
        calls.push(['xui.create', body.username, body.packageId, body.maxConnections, body.expDate]);
        return { id: 'line-year' };
      },
    },
  });
  const created = await accounts.createAccount({
    username: 'anual.xui',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: false, xui: true, playerKind: 'totalflix', packageId: 'year' },
  });
  assert.equal(created.cost, 9);
  const row = db.prepare('SELECT xui_expires_at FROM emby_accounts WHERE id = ?').get(created.id);
  const days = (accounts.parseSqlDate(row.xui_expires_at).getTime() - Date.now()) / 86400000;
  assert.ok(days > 360 && days < 370, String(days));
  const call = calls.find((item) => item[0] === 'xui.create');
  assert.equal(call[2], 'year');
  assert.equal(call[3], 1);
});

test('cada paquete caduca según su unidad, no leyendo meses como horas', () => {
  const catalog = [
    { id: '2', package_name: '1 MES- 1 CONEXION', is_trial: 0, official_duration: 1, official_duration_in: 'Months', max_connections: 1, days: 30 },
    { id: '2-sin-unidad', package_name: '1 MES- 1 CONEXION', is_trial: 0, official_duration: 1, official_duration_in: '', days: 30 },
    { id: 'demo', package_name: 'Demo 6 horas', is_trial: 1, trial_duration: 6, trial_duration_in: 'Hours', official_duration: 0, days: 0.25 },
    { id: 'demo-horas', package_name: 'Demo 6 horas', is_trial: 1, trial_duration: 6, official_duration: 0, days: 0.25 },
    { id: 'ano', package_name: '1 AÑO- 1 CONEXION', is_trial: 0, official_duration: 1, official_duration_in: 'Years', days: 365 },
    { id: 'ano-horas', package_name: '1 AÑO- 1 CONEXION', is_trial: 0, official_duration: 8760, days: 365 },
    { id: '3m', package_name: '3 MESES- 1 CONEXION', is_trial: 0, official_duration: 3, official_duration_in: 'Months', days: 90 },
    { id: '6m', package_name: '6 MESES- 2 CONEXION', is_trial: 0, official_duration: 6, official_duration_in: 'months', days: 180 },
    { id: '12m', package_name: '12 MESES- 1 CONEXION', is_trial: 0, official_duration: 12, official_duration_in: 'Months', days: 360 },
    { id: '7d', package_name: '7 DIAS- 1 CONEXION', is_trial: 0, official_duration: 7, official_duration_in: 'Days', days: 7 },
    { id: '24h', package_name: '24 HORAS', is_trial: 0, official_duration: 24, official_duration_in: 'Hours', days: 1 },
    { id: '720', package_name: 'Full', is_trial: 0, official_duration: 720, days: 30 },
    { id: 'pago', package_name: '1 MES- 1 CONEXION', is_trial: 0, trial_duration: 1, trial_duration_in: 'Hours', official_duration: 1, official_duration_in: 'Months', days: 30 },
    { id: 'abierto', package_name: 'Sin duración', is_trial: 0, official_duration: null, days: null },
  ];
  for (const pack of catalog) {
    assert.equal(accounts.packageDurationDays(pack), pack.days, pack.id);
  }
});

test('el alta de pago de 1 MES guarda en el panel la misma caducidad que manda a XUI', async () => {
  const { formatExpDate, parseExpToDate } = require('../src/services/xui');
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  db.prepare(
    `INSERT INTO xui_packages (
       id, package_name, is_trial, is_official, trial_duration, official_duration,
       trial_duration_in, official_duration_in, max_connections, is_listed
     ) VALUES ('2', '1 MES- 1 CONEXION', 0, 1, 0, 1, 'Hours', 'Months', 1, 1)`
  ).run();
  const mensual = db.prepare("SELECT * FROM plans WHERE name = 'Mensual · 1 pantalla'").get();
  const calls = install({
    xui: {
      createLine: async (body) => {
        calls.push(['xui.create', body.expDate, body.packageId, body.isTrial]);
        return { id: 'line-mes' };
      },
    },
  });
  const created = await accounts.createAccount({
    username: 'mes.xui',
    password: 'clave',
    planId: mensual.id,
    owner: actor(),
    services: { emby: false, xui: true, playerKind: 'totalflix', packageId: '2' },
  });
  const row = db.prepare('SELECT xui_expires_at, expires_at, has_emby, player_kind FROM emby_accounts WHERE id = ?').get(created.id);
  const call = calls.find((item) => item[0] === 'xui.create');
  assert.equal(call[1], row.xui_expires_at);
  assert.equal(call[2], '2');
  assert.equal(call[3], false);
  assert.equal(row.expires_at, row.xui_expires_at);
  assert.equal(row.has_emby, 0);
  assert.equal(row.player_kind, 'totalflix');
  const days = (accounts.parseSqlDate(row.xui_expires_at).getTime() - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31, String(days));
  const madrid = formatExpDate(row.xui_expires_at);
  const back = parseExpToDate(madrid).getTime();
  assert.ok(Math.abs(back - accounts.parseSqlDate(row.xui_expires_at).getTime()) < 60000);
});

test('un paquete sin duración hereda la de Emby y, si no hay Emby, 30 días', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  db.prepare(
    `INSERT INTO xui_packages (
       id, package_name, is_trial, is_official, trial_duration, official_duration,
       max_connections, credit_cost, is_listed
     ) VALUES ('open', 'Sin duración', 0, 1, NULL, NULL, 1, NULL, 1)`
  ).run();
  const withEmby = await accounts.createAccount({
    username: 'hereda.emby',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'totalflix', packageId: 'open' },
  });
  const both = db.prepare('SELECT emby_expires_at, xui_expires_at FROM emby_accounts WHERE id = ?').get(withEmby.id);
  const embyAt = accounts.parseSqlDate(both.emby_expires_at).getTime();
  const xuiAt = accounts.parseSqlDate(both.xui_expires_at).getTime();
  assert.ok(Math.abs(embyAt - xuiAt) < 5000);
  const only = await accounts.createAccount({
    username: 'hereda.xui',
    password: 'clave',
    owner: actor(),
    services: { emby: false, xui: true, playerKind: 'totalflix', packageId: 'open' },
  });
  const row = db.prepare('SELECT xui_expires_at FROM emby_accounts WHERE id = ?').get(only.id);
  const days = (accounts.parseSqlDate(row.xui_expires_at).getTime() - Date.now()) / 86400000;
  assert.ok(days > 29 && days < 31, String(days));
});

test('el formulario de alta y el de ampliar no duplican duración y paquete', () => {
  const fs = require('fs');
  const path = require('path');
  const create = fs.readFileSync(path.join(__dirname, '../src/views/partials/create-account.ejs'), 'utf8');
  const detail = fs.readFileSync(path.join(__dirname, '../src/views/account-detail.ejs'), 'utf8');
  assert.equal(create.includes('xui_plan_id'), false);
  assert.equal(create.includes('Paquete XUI'), false);
  assert.equal(create.includes('no guarda el id'), false);
  assert.equal(create.includes('Duración Emby'), false);
  assert.equal(create.includes('Duración XUI'), false);
  assert.match(create, /name="service_xui"/);
  assert.match(create, /name="plan_id"/);
  assert.match(create, /name="xui_package_id"/);
  assert.match(create, /for="xui-package">Duración/);
  assert.match(create, /xui-expiry/);
  assert.match(create, /id="hotplayer-mac"/);
  assert.equal(detail.includes('Paquete XUI'), false);
  assert.equal(detail.includes('xui_plan_id'), false);
  assert.match(detail, /id="extend-xui"/);
  assert.match(detail, /id="add-xui"/);
  assert.equal(fs.readFileSync(path.join(__dirname, '../src/views/client/home.ejs'), 'utf8').includes('ampliar'), false);
});

test('Emby y Max Player juntos guardan los dos ids', async () => {
  const created = await accounts.createAccount({
    username: 'ambos',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'maxplayer', packageId: '7' },
  });
  assert.equal(created.provisionError, null);
  assert.equal(created.cost, 1 + 2 + 3);
  const row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.emby_user_id, 'e-ambos');
  assert.ok(row.xui_line_id);
  assert.ok(row.maxplayer_user_id);
  assert.equal(row.maxplayer_list_ok, 1);
  assert.equal(row.xui_bouquets, '["1","2"]');
});

test('si Max Player falla, la línea XUI queda guardada y el reintento no vuelve a cobrar', async () => {
  install({
    maxplayer: {
      provisionUser: async () => {
        const err = new Error('cupo agotado');
        err.name = 'MaxPlayerError';
        err.status = 500;
        throw err;
      },
    },
  });
  const beforeCredits = creditsOf(reseller.id);
  const created = await accounts.createAccount({
    username: 'a.medias',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'maxplayer', packageId: '7' },
  });
  assert.match(created.provisionError, /Max Player/);
  assert.match(created.provisionError, /no se vuelve a cobrar/);
  assert.equal(creditsOf(reseller.id), beforeCredits - (1 + 2 + 3));
  let row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.ok(row.xui_line_id);
  assert.equal(row.emby_user_id, 'e-a.medias');
  assert.equal(row.maxplayer_user_id, null);

  const calls = install();
  const again = await accounts.retryProvision({ accountId: created.id, actor: actor() });
  assert.equal(again.provisionError, null);
  assert.equal(creditsOf(reseller.id), beforeCredits - (1 + 2 + 3));
  row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.ok(row.maxplayer_user_id);
  assert.equal(row.provision_error, null);
  assert.equal(calls.some((c) => c[0] === 'xui.create' || c[0] === 'xui.edit' || c[0] === 'emby.create'), false);
  assert.equal(calls.some((c) => c[0] === 'mp.create'), true);
});

test('reintentar Max Player engancha el usuario ya creado y no abre otro', async () => {
  install({
    maxplayer: {
      provisionUser: async () => {
        const err = new Error('cupo agotado');
        err.status = 500;
        throw err;
      },
    },
  });
  const created = await accounts.createAccount({
    username: 'mp.engancha',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'maxplayer', packageId: '7' },
  });
  const calls = install({
    maxplayer: {
      findUserId: async (name) => {
        calls.push(['mp.find', name]);
        return 'mp-viejo';
      },
      provisionUser: async () => {
        throw new Error('no debía crear otro usuario');
      },
    },
  });
  const again = await accounts.retryProvision({ accountId: created.id, actor: actor() });
  assert.equal(again.provisionError, null);
  assert.equal(calls.some((c) => c[0] === 'mp.create'), false);
  assert.equal(calls.some((c) => c[0] === 'mp.list'), true);
  assert.equal(calls.some((c) => c[0] === 'xui.create' || c[0] === 'xui.edit' || c[0] === 'emby.create'), false);
  const row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.maxplayer_user_id, 'mp-viejo');
  assert.equal(row.maxplayer_list_ok, 1);
});

test('si la línea XUI ya existe, el alta la reutiliza y no crea otra', async () => {
  const calls = install({
    xui: {
      findLineByUsername: async (name) => ({ id: 'line-ya', username: name }),
    },
  });
  const beforeCredits = creditsOf(reseller.id);
  const created = await accounts.createAccount({
    username: 'ya.existe',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: false, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  assert.equal(created.provisionError, null);
  assert.equal(creditsOf(reseller.id), beforeCredits - 2);
  const row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.xui_line_id, 'line-ya');
  assert.equal(calls.some((c) => c[0] === 'xui.create'), false);
  const edit = calls.find((c) => c[0] === 'xui.edit');
  assert.ok(edit);
  assert.equal(edit[1], 'line-ya');
  assert.equal(edit[2].password, 'clave');
  assert.equal(edit[2].enabled, 1);
  assert.equal(edit[2].admin_enabled, 1);
});

test('un aviso viejo no ofrece reintento si la cuenta ya está completa', async () => {
  const created = await accounts.createAccount({
    username: 'aviso.viejo',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: false },
  });
  db.prepare("UPDATE emby_accounts SET provision_error = 'fallo al borrar' WHERE id = ?").run(created.id);
  const row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.deepEqual(accounts.pendingParts(row), []);
  await assert.rejects(
    () => accounts.retryProvision({ accountId: created.id, actor: actor() }),
    /nada pendiente/
  );
});

test('la ficha muestra la contraseña en claro dentro del mensaje de bienvenida', async () => {
  const created = await accounts.createAccount({
    username: 'clave.visible',
    password: 'secreta',
    planId: plan.id,
    owner: actor(),
    services: { emby: false, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  const card = accounts.connectionCard(created.id, actor());
  assert.equal(card.username, 'clave.visible');
  assert.equal(card.password, 'secreta');
  assert.match(card.message, /Usuario: clave\.visible/);
  assert.match(card.message, /Contraseña: secreta/);
  assert.equal(card.message.includes('&amp;'), false);
  await assert.rejects(
    async () => accounts.connectionCard(created.id, { id: reseller.id + 99, role: 'reseller' }),
    /no es tuya/
  );
});

test('get_line con fecha futura reactiva la cuenta cortada y el modo prueba no escribe', async () => {
  const { parseExpToDate } = require('../src/services/xui');
  const calls = install({
    xui: {
      getLine: async (id) => {
        calls.push(['xui.get', id]);
        if (id === 'line-off') {
          return { exp_date: '2099-04-01 10:00', enabled: '0', username: 'sync.off' };
        }
        if (id === 'line-old') {
          return { exp_date: '2020-05-01 00:00', enabled: '1', username: 'sync.old' };
        }
        return { exp_date: '2099-03-01 10:00', enabled: '1', admin_enabled: '1', username: 'sync.ok' };
      },
    },
  });
  async function seed(username, lineId) {
    const created = await accounts.createAccount({
      username,
      password: 'clave',
      planId: plan.id,
      owner: actor(),
      services: { emby: false, xui: true, playerKind: 'totalflix', packageId: '7' },
    });
    db.prepare(
      `UPDATE emby_accounts SET xui_line_id = ?, status = 'expired', xui_cut = 1, xui_expires_at = ?, expires_at = ? WHERE id = ?`
    ).run(lineId, '2020-01-01 00:00:00', '2020-01-01 00:00:00', created.id);
    return created.id;
  }
  const okId = await seed('sync.ok', 'line-ok');
  const offId = await seed('sync.off', 'line-off');
  const oldId = await seed('sync.old', 'line-old');

  const okRow = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(okId);
  const dry = await accounts.reconcileAccountXui(okRow, { apply: false });
  assert.equal(dry.action, 'adopt');
  assert.equal(dry.applied, false);
  assert.equal(db.prepare('SELECT status FROM emby_accounts WHERE id = ?').get(okId).status, 'expired');

  const applied = await accounts.reconcileAccountXui(okRow, { apply: true });
  assert.equal(applied.action, 'adopt');
  const okAfter = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(okId);
  assert.equal(okAfter.status, 'active');
  assert.equal(okAfter.xui_cut, 0);
  assert.equal(okAfter.xui_expires_at, accounts.toSqlDate(parseExpToDate('2099-03-01 10:00')));

  const detail = await accounts.detailPayload(offId, actor());
  assert.equal(detail.account.status, 'active');
  assert.match(detail.xuiSyncNote, /reactiv/);
  const offEdit = calls.find((c) => c[0] === 'xui.edit' && c[1] === 'line-off');
  assert.ok(offEdit);
  assert.equal(offEdit[2].enabled, 1);
  assert.equal(offEdit[2].admin_enabled, 1);
  const offAfter = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(offId);
  assert.equal(offAfter.status, 'active');
  assert.equal(offAfter.xui_cut, 0);

  const oldRow = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(oldId);
  const past = await accounts.reconcileAccountXui(oldRow, { apply: true });
  assert.equal(past.action, 'past');
  assert.equal(calls.some((c) => c[0] === 'xui.edit' && c[1] === 'line-old'), false);
  assert.equal(db.prepare('SELECT status, xui_cut FROM emby_accounts WHERE id = ?').get(oldId).status, 'expired');
});

test('sin ningún servicio no se cobra ni se crea nada', async () => {
  const beforeCredits = creditsOf(reseller.id);
  await assert.rejects(
    () =>
      accounts.createAccount({
        username: 'nada',
        password: 'clave',
        planId: plan.id,
        owner: actor(),
        services: { emby: false, xui: false },
      }),
    /Activa Emby/
  );
  assert.equal(creditsOf(reseller.id), beforeCredits);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM emby_accounts WHERE username = 'nada'").get().n, 0);
});

test('si la BD no puede cobrar, se borran los usuarios que ya se habían creado fuera', async () => {
  const calls = install();
  const previous = creditsOf(reseller.id);
  db.prepare('UPDATE panel_users SET credits = 0 WHERE id = ?').run(reseller.id);
  const owner = Object.assign({}, actor(), { credits: 100 });
  await assert.rejects(
    () =>
      accounts.createAccount({
        username: 'huerfano',
        password: 'clave',
        planId: plan.id,
        owner,
        services: { emby: true, xui: true, playerKind: 'maxplayer', packageId: '7' },
      }),
    /Créditos insuficientes/
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM emby_accounts WHERE username = 'huerfano'").get().n, 0);
  assert.ok(calls.some((c) => c[0] === 'mp.del'));
  assert.ok(calls.some((c) => c[0] === 'xui.del'));
  assert.ok(calls.some((c) => c[0] === 'emby.del'));
  db.prepare('UPDATE panel_users SET credits = ? WHERE id = ?').run(previous, reseller.id);
});

test('renovar, caducar y borrar tocan cada sistema donde existe la cuenta', async () => {
  const calls = install();
  const created = await accounts.createAccount({
    username: 'ciclo',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'maxplayer', packageId: '7' },
  });
  calls.length = 0;
  await accounts.renewAccount({ accountId: created.id, planId: plan.id, actor: actor() });
  assert.ok(calls.some((c) => c[0] === 'emby.policy'));
  const renewed = calls.find((c) => c[0] === 'xui.edit');
  assert.ok(renewed && renewed[2].exp_date);
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  db.prepare("UPDATE emby_accounts SET xui_bouquets = '[]' WHERE id = ?").run(created.id);
  calls.length = 0;
  await accounts.renewAccount({ accountId: created.id, planId: plan.id, actor: actor() });
  const emptyBouquets = calls.find((c) => c[0] === 'xui.edit');
  assert.equal(emptyBouquets[2].bouquets_selected, undefined);
  db.prepare("UPDATE emby_accounts SET xui_bouquets = ? WHERE id = ?").run('[9,8]', created.id);
  calls.length = 0;
  await accounts.renewAccount({ accountId: created.id, planId: plan.id, actor: actor() });
  const keptBouquets = calls.find((c) => c[0] === 'xui.edit');
  assert.equal(keptBouquets[2].bouquets_selected, '[9,8]');
  assert.ok(calls.some((c) => c[0] === 'xui.enable'));
  assert.ok(calls.some((c) => c[0] === 'mp.list'));

  calls.length = 0;
  const account = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  await accounts.expireRemotes(account);
  assert.ok(calls.some((c) => c[0] === 'emby.policy' && c[2].IsDisabled === true));
  assert.ok(calls.some((c) => c[0] === 'xui.disable'));
  assert.ok(calls.some((c) => c[0] === 'mp.devices'));

  calls.length = 0;
  await accounts.deleteAccount({ accountId: created.id, actor: actor() });
  const gone = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(gone.status, 'deleted');
  assert.ok(calls.some((c) => c[0] === 'mp.del'));
  assert.ok(calls.some((c) => c[0] === 'xui.del'));
  assert.ok(calls.some((c) => c[0] === 'emby.del'));
});

test('un borrado a medias conserva la línea que no se pudo borrar y el reintento la elimina', async () => {
  const created = await accounts.createAccount({
    username: 'medio.borrado',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  install({
    xui: {
      deleteLine: async () => {
        const err = new Error('XUI caído');
        err.name = 'XuiError';
        err.status = 500;
        throw err;
      },
    },
  });
  await assert.rejects(
    () => accounts.deleteAccount({ accountId: created.id, actor: actor() }),
    /Borrado incompleto/
  );
  let row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.status, 'active');
  assert.equal(row.emby_user_id, null);
  assert.ok(row.xui_line_id);

  install();
  await accounts.deleteAccount({ accountId: created.id, actor: actor() });
  row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.status, 'deleted');
  assert.equal(row.xui_line_id, null);
});

test('si la renovación falla en XUI no se cobra ni se mueve la fecha', async () => {
  const created = await accounts.createAccount({
    username: 'renueva.mal',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: false, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  const beforeCredits = creditsOf(reseller.id);
  const beforeDate = db.prepare('SELECT expires_at FROM emby_accounts WHERE id = ?').get(created.id).expires_at;
  install({
    xui: {
      editLine: async () => {
        throw Object.assign(new Error('timeout'), { name: 'XuiError', status: 0 });
      },
    },
  });
  await assert.rejects(
    () => accounts.renewAccount({ accountId: created.id, planId: plan.id, actor: actor() }),
    /No se pudo renovar/
  );
  assert.equal(creditsOf(reseller.id), beforeCredits);
  assert.equal(db.prepare('SELECT expires_at FROM emby_accounts WHERE id = ?').get(created.id).expires_at, beforeDate);
});

test('cambiar de plan con la misma duración cobra solo la diferencia de los servicios que existen', async () => {
  const created = await accounts.createAccount({
    username: 'cambia.plan',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'maxplayer', packageId: '7' },
  });
  db.prepare('UPDATE xui_packages SET credit_cost = 10 WHERE id = ?').run('7');
  const beforeCredits = creditsOf(reseller.id);
  const result = await accounts.changePlan({ accountId: created.id, planId: planB.id, actor: actor() });
  // Emby 4-1 = 3, XUI lo marca el paquete (no cambia), Max Player 6-3 = 3.
  assert.equal(result.diff, 6);
  assert.equal(creditsOf(reseller.id), beforeCredits - 6);
  const row = db.prepare('SELECT plan_id, expires_at FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.plan_id, planB.id);
});

test('el texto para copiar junta Emby y XUI sin la M3U', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  const created = await accounts.createAccount({
    username: 'copia.ambos',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'maxplayer', packageId: '7' },
  });
  const card = accounts.connectionCard(created.id, actor());
  assert.match(card.message, /🎬 ¡Bienvenido a Totalflix!/);
  assert.match(card.message, /📺 Emby/);
  assert.match(card.message, /Servidor: http:\/\/emby\.example/);
  assert.match(card.message, /Puerto: dejar vacío/);
  assert.match(card.message, /Pantallas:/);
  assert.match(card.message, /📡 TOTALFLIX/);
  assert.equal(card.message.replaceAll(card.username, '').toLowerCase().includes('xui'), false);
  assert.match(card.message, /📅 Vence: \d{4}-\d{2}-\d{2}\n/);
  assert.match(card.message, /📅 Vence: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.equal(/Lista M3U/.test(card.message), false);
});

test('ampliar XUI no mueve la fecha de Emby y reparar cambia de servidor', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  const calls = install({
    maxplayer: {
      deleteAllDevices: async (id) => calls.push(['mp.wipe', id]),
      attachPlaylist: async (id, body) => calls.push(['mp.list', id, body.domainId]),
      replacePlaylist: async (id, body) => calls.push(['mp.replace', id, body.domainId]),
    },
  });
  const created = await accounts.createAccount({
    username: 'ampliar.uno',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'maxplayer', packageId: '7' },
  });
  const before = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  const pato = require('../src/config').maxplayerDomainPatoId;
  db.prepare('UPDATE emby_accounts SET maxplayer_domain_id = ? WHERE id = ?').run(pato, created.id);
  calls.length = 0;
  const credits = creditsOf(reseller.id);
  await accounts.extendService({ accountId: created.id, actor: actor(), service: 'xui', planId: plan.id });
  const after = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(after.emby_expires_at, before.emby_expires_at);
  assert.notEqual(after.xui_expires_at, before.xui_expires_at);
  assert.ok(calls.some((c) => c[0] === 'xui.edit'));
  assert.equal(calls.some((c) => c[0] === 'emby.policy'), false);
  assert.ok(creditsOf(reseller.id) < credits);

  calls.length = 0;
  const repaired = await accounts.repairMaxPlayer({ accountId: created.id, actor: actor() });
  assert.equal(repaired.toLabel, 'CISNE');
  assert.ok(calls.some((c) => c[0] === 'mp.wipe'));
  assert.ok(calls.some((c) => c[0] === 'mp.replace' && c[2] === require('../src/config').maxplayerDomainCisneId));
  assert.equal(calls.some((c) => c[0] === 'mp.list'), false);
  assert.equal(calls.some((c) => String(c[0]).startsWith('xui')), false);
  const row = db.prepare('SELECT maxplayer_domain_id FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.maxplayer_domain_id, require('../src/config').maxplayerDomainCisneId);
});

test('editar actualiza usuario, contraseña, conexiones y notas en los tres servicios', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  const calls = install();
  const created = await accounts.createAccount({
    username: 'editar.uno',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    notes: 'vieja',
    services: { emby: true, xui: true, playerKind: 'maxplayer', packageId: '7' },
  });
  calls.length = 0;
  const result = await accounts.editAccount({
    accountId: created.id,
    username: 'editar.dos',
    password: 'nueva',
    screens: 4,
    notes: 'nota nueva',
    actor: actor(),
  });
  assert.equal(result.credentialsChanged, true);
  const names = calls.map((call) => call[0]);
  assert.deepEqual(names, [
    'xui.find',
    'xui.edit',
    'emby.rename',
    'emby.pw',
    'emby.streams',
    'mp.pw',
    'mp.list',
    'mp.limit',
  ]);
  const edit = calls.find((call) => call[0] === 'xui.edit');
  assert.equal(edit[2].username, 'editar.dos');
  assert.equal(edit[2].password, 'nueva');
  assert.equal(edit[2].max_connections, 4);
  const list = calls.find((call) => call[0] === 'mp.list');
  assert.equal(list[2].iptvUsername, 'editar.dos');
  assert.equal(list[2].iptvPassword, 'nueva');
  const row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.username, 'editar.dos');
  assert.equal(row.screens, 4);
  assert.equal(row.notes, 'nota nueva');
  assert.equal(require('../src/services/secret').decrypt(row.password_enc), 'nueva');
  const card = accounts.connectionCard(created.id, actor());
  assert.match(card.message, /Usuario: editar\.dos/);
  assert.match(card.message, /Contraseña: nueva/);
  assert.match(card.message, /Pantallas: 4/);
  assert.equal(card.message.replaceAll(card.username, '').toLowerCase().includes('xui'), false);
});

test('un usuario repetido en el panel no llama a ningún servicio', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  const calls = install();
  const first = await accounts.createAccount({
    username: 'ocupado',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: false },
  });
  const second = await accounts.createAccount({
    username: 'libre.panel',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  calls.length = 0;
  await assert.rejects(
    () =>
      accounts.editAccount({
        accountId: second.id,
        username: 'Ocupado',
        password: '',
        screens: 1,
        notes: '',
        actor: actor(),
      }),
    /ya existe en el panel/
  );
  assert.equal(calls.length, 0);
  assert.equal(db.prepare('SELECT username FROM emby_accounts WHERE id = ?').get(second.id).username, 'libre.panel');
  assert.equal(db.prepare('SELECT username FROM emby_accounts WHERE id = ?').get(first.id).username, 'ocupado');
});

test('un usuario repetido en XUI no modifica la cuenta', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  const calls = install({
    xui: {
      findLineByUsername: async (name) => {
        calls.push(['xui.find', name]);
        if (String(name).toLowerCase() === 'choca') return { id: 'otra-linea', username: name };
        return null;
      },
    },
  });
  const created = await accounts.createAccount({
    username: 'unico.xui',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: false, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  calls.length = 0;
  await assert.rejects(
    () =>
      accounts.editAccount({
        accountId: created.id,
        username: 'choca',
        screens: 2,
        actor: actor(),
      }),
    /ya existe en XUI/
  );
  assert.deepEqual(calls.map((call) => call[0]), ['xui.find']);
  const row = db.prepare('SELECT username, screens FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.username, 'unico.xui');
  assert.equal(row.screens, null);
});

test('si Emby falla después de XUI se deshace la línea y la fila no cambia', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  const calls = install({
    emby: {
      renameUser: async () => {
        throw Object.assign(new Error('emby caido'), { name: 'EmbyError', status: 500 });
      },
    },
  });
  const created = await accounts.createAccount({
    username: 'rollback.ok',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  calls.length = 0;
  await assert.rejects(
    () =>
      accounts.editAccount({
        accountId: created.id,
        username: 'rollback.new',
        password: 'otra',
        screens: 3,
        actor: actor(),
      }),
    /Falló Emby/
  );
  const edits = calls.filter((call) => call[0] === 'xui.edit');
  assert.equal(edits.length, 2);
  assert.equal(edits[0][2].username, 'rollback.new');
  assert.equal(edits[1][2].username, 'rollback.ok');
  assert.equal(edits[1][2].password, 'clave');
  assert.equal(edits[1][2].max_connections, 1);
  assert.equal(calls.some((call) => call[0] === 'mp.pw'), false);
  const row = db.prepare('SELECT username FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.username, 'rollback.ok');
  assert.equal(require('../src/services/secret').decrypt(db.prepare('SELECT password_enc FROM emby_accounts WHERE id = ?').get(created.id).password_enc), 'clave');
});

test('si el deshacer de XUI falla, el panel conserva el usuario anterior', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  install({
    xui: {
      editLine: async (id, fields) => {
        if (fields.username === 'pegado') return;
        throw Object.assign(new Error('no deshace'), { name: 'XuiError', status: 500 });
      },
    },
    emby: {
      renameUser: async () => {
        throw Object.assign(new Error('emby caido'), { name: 'EmbyError', status: 500 });
      },
    },
  });
  const created = await accounts.createAccount({
    username: 'rollback.mal',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  await assert.rejects(
    () =>
      accounts.editAccount({
        accountId: created.id,
        username: 'pegado',
        actor: actor(),
      }),
    /Falló Emby[\s\S]*panel sigue con el usuario rollback\.mal/
  );
  assert.equal(db.prepare('SELECT username FROM emby_accounts WHERE id = ?').get(created.id).username, 'rollback.mal');
});

test('cambiar solo las notas no llama a los servicios', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  const calls = install();
  const created = await accounts.createAccount({
    username: 'solo.notas',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: true, playerKind: 'maxplayer', packageId: '7' },
  });
  calls.length = 0;
  const result = await accounts.editAccount({
    accountId: created.id,
    username: 'solo.notas',
    password: '',
    screens: 1,
    notes: 'apunte',
    actor: actor(),
  });
  assert.equal(result.credentialsChanged, false);
  assert.equal(calls.length, 0);
  assert.equal(db.prepare('SELECT notes FROM emby_accounts WHERE id = ?').get(created.id).notes, 'apunte');
});

test('añadir Emby a una cuenta XUI copia la caducidad y cobra el plan', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  const calls = install();
  const created = await accounts.createAccount({
    username: 'solo.linea',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: false, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  const xuiExpiry = '2027-04-01 10:00:00';
  db.prepare('UPDATE emby_accounts SET xui_expires_at = ?, screens = 2 WHERE id = ?').run(xuiExpiry, created.id);
  const before = creditsOf(reseller.id);
  calls.length = 0;
  const added = await accounts.addService({
    accountId: created.id,
    actor: actor(),
    service: 'emby',
    planId: plan.id,
  });
  assert.equal(added.cost, 1);
  assert.equal(creditsOf(reseller.id), before - 1);
  const row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.emby_user_id, 'e-solo.linea');
  assert.equal(row.emby_expires_at, xuiExpiry);
  const policy = calls.find((call) => call[0] === 'emby.policy');
  assert.equal(policy[2].SimultaneousStreamLimit, 2);
  const card = accounts.connectionCard(created.id, actor());
  assert.match(card.message, /Usuario: solo\.linea/);
  assert.match(card.message, /Contraseña: clave/);
  assert.equal(card.message.replaceAll(card.username, '').toLowerCase().includes('xui'), false);
});

test('añadir XUI usa las mismas credenciales y cobra como un alta', async () => {
  db.prepare('UPDATE panel_users SET credits = 50 WHERE id = ?').run(reseller.id);
  const calls = install({
    xui: {
      createLine: async (body) => {
        calls.push(['xui.create', body]);
        return { id: 'line-cruzada' };
      },
    },
  });
  const created = await accounts.createAccount({
    username: 'solo.emby2',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: false },
  });
  const embyExpiry = '2027-06-15 08:00:00';
  db.prepare('UPDATE emby_accounts SET emby_expires_at = ? WHERE id = ?').run(embyExpiry, created.id);
  db.prepare('UPDATE xui_packages SET credit_cost = NULL WHERE id = ?').run('7');
  const before = creditsOf(reseller.id);
  calls.length = 0;
  const added = await accounts.addService({
    accountId: created.id,
    actor: actor(),
    service: 'xui',
    packageId: '7',
    playerKind: 'maxplayer',
  });
  assert.equal(added.cost, 2 + 3);
  assert.equal(creditsOf(reseller.id), before - 5);
  const body = calls.find((call) => call[0] === 'xui.create')[1];
  assert.equal(body.username, 'solo.emby2');
  assert.equal(body.password, 'clave');
  assert.equal(body.packageId, '7');
  assert.ok(calls.some((call) => call[0] === 'mp.create' && call[1] === 'solo.emby2'));
  const row = db.prepare('SELECT xui_line_id, player_kind FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.xui_line_id, 'line-cruzada');
  assert.equal(row.player_kind, 'maxplayer');
  const card = accounts.connectionCard(created.id, actor());
  assert.match(card.message, /📡 TOTALFLIX/);
  assert.match(card.message, /Contraseña: clave/);
});

test('la ficha ofrece editar y añadir el servicio que falta', () => {
  const fs = require('fs');
  const path = require('path');
  const detail = fs.readFileSync(path.join(__dirname, '../src/views/account-detail.ejs'), 'utf8');
  const row = fs.readFileSync(path.join(__dirname, '../src/views/partials/account-row.ejs'), 'utf8');
  assert.match(detail, /id="editar"/);
  assert.match(detail, /Añadir a Emby/);
  assert.match(detail, /Añadir a XUI/);
  assert.match(detail, /suggestedEmbyPlanId/);
  assert.match(detail, /selectedPackageId: suggestedXuiPackageId/);
  assert.match(row, />\s*Editar/);
  assert.match(row, /#editar/);
  assert.match(row, /Arreglar conexión/);
  assert.match(detail, /Datos para el cliente/);
  assert.match(detail, /Copiar mensaje de bienvenida/);
  assert.match(detail, /id="hotplayer"/);
  assert.match(detail, /no quita la lista/);
});

test('HotPlayer carga la lista, no cobra de más y el mensaje no lleva credenciales', async () => {
  const calls = install();
  const before = creditsOf(reseller.id);
  const created = await accounts.createAccount({
    username: 'solo.hot',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: {
      emby: false,
      xui: true,
      playerKind: 'totalflix',
      hotplayer: true,
      mac: 'aa-bb-cc-dd-ee-ff',
      packageId: '7',
    },
  });
  assert.equal(created.cost, 2);
  assert.equal(creditsOf(reseller.id), before - 2);
  assert.equal(calls.some((call) => call[0] === 'mp.create'), false);
  assert.deepEqual(
    calls.find((call) => call[0] === 'hot.add').slice(1),
    ['AA:BB:CC:DD:EE:FF', 'solo.hot', undefined]
  );
  const row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.player_kind, 'hotplayer');
  assert.equal(row.hotplayer_mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(row.hotplayer_ok, 1);
  const card = accounts.connectionCard(created.id, actor());
  assert.match(card.message, /La lista ya está cargada en tu tele/);
  assert.equal(card.message.includes('Contraseña'), false);
  assert.equal(card.message.includes('clave'), false);
  assert.equal(card.message.toLowerCase().includes('cisnerojo'), false);
  assert.equal(card.message.includes('http'), false);
});

test('Max Player y HotPlayer a la vez cobran solo el extra de Max Player', async () => {
  const calls = install();
  const before = creditsOf(reseller.id);
  const created = await accounts.createAccount({
    username: 'dos.apps',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: accounts.parseServices({
      service_xui: '1',
      dest_maxplayer: '1',
      dest_hotplayer: '1',
      hotplayer_mac: '10:20:30:40:50:60',
      xui_package_id: '7',
    }),
  });
  assert.equal(created.cost, 2 + 3);
  assert.equal(creditsOf(reseller.id), before - 5);
  assert.ok(calls.some((call) => call[0] === 'mp.create'));
  assert.ok(calls.some((call) => call[0] === 'hot.add' && call[1] === '10:20:30:40:50:60'));
  const row = db.prepare('SELECT player_kind, hotplayer_mac FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.player_kind, 'maxplayer');
  assert.equal(row.hotplayer_mac, '10:20:30:40:50:60');
  const card = accounts.connectionCard(created.id, actor());
  assert.match(card.message, /📡 TOTALFLIX/);
  assert.match(card.message, /Contraseña: clave/);
  assert.match(card.message, /Abre la app HotPlayer/);
  assert.equal(card.message.toLowerCase().includes('cisnerojo'), false);
});

test('sin MAC válida no se crea la línea XUI', async () => {
  const calls = install();
  await assert.rejects(
    () => accounts.createAccount({
      username: 'sin.mac',
      password: 'clave',
      planId: plan.id,
      owner: actor(),
      services: { emby: false, xui: true, hotplayer: true, mac: 'no-es-mac', packageId: '7' },
    }),
    /MAC/
  );
  assert.equal(calls.some((call) => call[0] === 'xui.create'), false);
});

test('cambiar usuario o contraseña vuelve a cargar HotPlayer y borrarla no llama a la API', async () => {
  const calls = install();
  const created = await accounts.createAccount({
    username: 'hot.edit',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: false, xui: true, hotplayer: true, mac: 'AA:BB:CC:DD:EE:01', packageId: '7' },
  });
  calls.length = 0;
  await accounts.editAccount({
    accountId: created.id,
    username: 'hot.nuevo',
    password: 'nueva',
    actor: actor(),
  });
  const uploaded = calls.filter((call) => call[0] === 'hot.add');
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0][1], 'AA:BB:CC:DD:EE:01');
  assert.equal(uploaded[0][2], 'hot.nuevo');
  calls.length = 0;
  const removed = await accounts.deleteAccount({ accountId: created.id, actor: actor() });
  assert.equal(removed.hotplayerLeft, true);
  assert.equal(calls.some((call) => String(call[0]).startsWith('hot.')), false);
  assert.ok(calls.some((call) => call[0] === 'xui.del'));
});

test('añadir HotPlayer a una cuenta XUI no cobra créditos', async () => {
  const calls = install();
  const created = await accounts.createAccount({
    username: 'ya.xui',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: false, xui: true, playerKind: 'totalflix', packageId: '7' },
  });
  const before = creditsOf(reseller.id);
  calls.length = 0;
  const result = await accounts.setHotPlayer({
    accountId: created.id,
    mac: 'aabbccddeef0',
    actor: actor(),
  });
  assert.equal(result.mac, 'AA:BB:CC:DD:EE:F0');
  assert.equal(creditsOf(reseller.id), before);
  assert.deepEqual(calls.map((call) => call[0]), ['hot.add']);
  const row = db.prepare('SELECT player_kind, hotplayer_ok FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.player_kind, 'hotplayer');
  assert.equal(row.hotplayer_ok, 1);
  const renewBefore = creditsOf(reseller.id);
  await accounts.renewAccount({ accountId: created.id, planId: plan.id, actor: actor() });
  assert.equal(creditsOf(reseller.id), renewBefore - plan.xui_credit_cost);
});

test('el filtro de HotPlayer no mezcla las líneas TotalFlix', () => {
  const hot = accounts.accountListFilters({ servicio: 'hotplayer' });
  assert.match(hot.clauses[0], /hotplayer_mac/);
  const flix = accounts.accountListFilters({ servicio: 'totalflix' });
  assert.match(flix.clauses[0], /hotplayer_mac IS NULL/);
});
