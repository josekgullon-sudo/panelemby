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
          official_duration: 30,
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
      attachPlaylist: async (id) => calls.push(['mp.list', id]),
      changePassword: async (id, pw) => calls.push(['mp.pw', id, pw]),
      deleteDevices: async (id) => calls.push(['mp.devices', id]),
    },
    overrides.maxplayer
  );
  accounts.setIntegrations({ emby, xui, maxplayer });
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
  accounts.setIntegrations({ emby: null, xui: null, maxplayer: null });
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
  assert.match(card.message, /TotalFlix/);
  assert.match(card.m3u, /iptv\.test:8080/);
  assert.match(card.m3u, /username=solo\.xui/);
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

  install();
  const again = await accounts.retryProvision({ accountId: created.id, actor: actor() });
  assert.equal(again.provisionError, null);
  assert.equal(creditsOf(reseller.id), beforeCredits - (1 + 2 + 3));
  row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.ok(row.maxplayer_user_id);
  assert.equal(row.provision_error, null);
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
  assert.ok(calls.some((c) => c[0] === 'xui.edit' && c[2].exp_date));
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
