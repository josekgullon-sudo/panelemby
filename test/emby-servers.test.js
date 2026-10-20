require('./env');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const config = require('../src/config');
const db = require('../src/db/database');
const accounts = require('../src/services/accounts');
const { createClient } = require('../src/services/emby');
const { assignExistingEmbyAccounts } = require('../src/db/migrateEmbyServers');

let reseller;
let other;
let plan;

function actor(row) {
  return db.prepare('SELECT * FROM panel_users WHERE id = ?').get((row || reseller).id);
}

function serverDouble(key, calls, behavior) {
  const users = new Map();
  let seq = 0;
  const opts = behavior || {};
  return {
    createUser: async (name, password) => {
      calls.push([key, 'create', name, password]);
      if (opts.createError) throw opts.createError;
      seq += 1;
      const id = opts.ids && opts.ids[seq - 1] ? opts.ids[seq - 1] : `${key}-${name}`;
      const user = {
        Id: id,
        Name: name,
        Policy: {
          IsDisabled: false,
          IsAdministrator: true,
          EnableAllFolders: false,
          EnabledFolders: ['lib-a'],
          SimultaneousStreamLimit: 1,
        },
      };
      users.set(String(id), user);
      return user;
    },
    setPassword: async (id, password) => {
      calls.push([key, 'password', id, password]);
    },
    updatePolicy: async (id, patch) => {
      calls.push([key, 'policy', id, patch]);
      const user = users.get(String(id)) || { Id: id, Name: '', Policy: {} };
      user.Policy = Object.assign({}, user.Policy, patch);
      users.set(String(id), user);
    },
    getUser: async (id) => {
      calls.push([key, 'get', id]);
      if (opts.badVerify) return { Id: id, Name: 'otro-nombre' };
      const user = users.get(String(id));
      if (!user) {
        const missing = new Error('no está');
        missing.status = 404;
        throw missing;
      }
      return user;
    },
    deleteUser: async (id) => {
      calls.push([key, 'delete', id]);
      if (opts.deleteError) throw opts.deleteError;
      users.delete(String(id));
    },
    getVirtualFolders: async () => [],
    getDevices: async () => {
      calls.push([key, 'devices']);
      return [];
    },
    getSessions: async () => [],
    renameUser: async (id, name) => calls.push([key, 'rename', id, name]),
    setStreamLimit: async (id, n) => calls.push([key, 'streams', id, n]),
  };
}

function install(behaviors) {
  const calls = [];
  const opts = behaviors || {};
  const doubles = {
    1: serverDouble('1', calls, opts['1']),
    2: serverDouble('2', calls, opts['2']),
  };
  accounts.setIntegrations({
    emby: { forServer: (key) => doubles[key] || doubles['1'] },
    xui: { isConfigured: () => true, getPackages: async () => [] },
    maxplayer: { isConfigured: () => false },
    hotplayer: { isConfigured: () => false, normalizeMac: () => '' },
  });
  return calls;
}

before(() => {
  const hash = bcrypt.hashSync('secret', 4);
  db.prepare("INSERT INTO panel_users (username, password_hash, role, credits) VALUES ('resi-emby', ?, 'reseller', 40)").run(hash);
  db.prepare("INSERT INTO panel_users (username, password_hash, role, credits) VALUES ('otro-emby', ?, 'reseller', 40)").run(hash);
  reseller = db.prepare("SELECT * FROM panel_users WHERE username = 'resi-emby'").get();
  other = db.prepare("SELECT * FROM panel_users WHERE username = 'otro-emby'").get();
  const id = db
    .prepare(
      `INSERT INTO plans (name, duration_days, credit_cost, screens, xui_credit_cost, maxplayer_credit_cost)
       VALUES ('Plan emby', 30, 1, 1, 0, 0)`
    )
    .run().lastInsertRowid;
  plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
});

after(() => {
  accounts.setIntegrations({ emby: null, xui: null, maxplayer: null, hotplayer: null });
  db.close();
});

test('el .env antiguo, sin EMBY_SERVER_*, deja solo el servidor 1', () => {
  const servers = config.parseEmbyServers({
    EMBY_URL: 'http://uno:8096/',
    EMBY_API_KEY: 'clave-uno',
    EMBY_PUBLIC_URL: 'http://publico:8096/',
    EMBY_SERVER_1_URL: 'http://no-se-usa:8096',
  });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].key, '1');
  assert.equal(servers[0].name, 'Servidor 1');
  assert.equal(servers[0].url, 'http://uno:8096');
  assert.equal(servers[0].publicUrl, 'http://publico:8096');
  assert.equal(servers[0].apiKey, 'clave-uno');
});

test('el servidor 2 hereda la API key y se puede sustituir', () => {
  const inherited = config.parseEmbyServers({
    EMBY_URL: 'http://uno:8096',
    EMBY_API_KEY: 'clave-uno',
    EMBY_PUBLIC_URL: 'http://publico:8096',
    EMBY_SERVER_2_NAME: 'Servidor 2',
    EMBY_SERVER_2_URL: 'http://dos:8096/',
    EMBY_SERVER_2_API_KEY: '',
    EMBY_SERVER_4_URL: 'http://cuatro:8096',
  });
  assert.deepEqual(inherited.map((server) => server.key), ['1', '2', '4']);
  assert.equal(inherited[1].name, 'Servidor 2');
  assert.equal(inherited[1].url, 'http://dos:8096');
  assert.equal(inherited[1].publicUrl, 'http://dos:8096');
  assert.equal(inherited[1].apiKey, 'clave-uno');
  assert.equal(inherited[2].name, 'Servidor 4');
  assert.equal(inherited[2].apiKey, 'clave-uno');

  const own = config.parseEmbyServers({
    EMBY_URL: 'http://uno:8096',
    EMBY_API_KEY: 'clave-uno',
    EMBY_SERVER_2_URL: 'http://dos:8096',
    EMBY_SERVER_2_PUBLIC_URL: 'http://dos-publico:8096',
    EMBY_SERVER_2_API_KEY: 'clave-dos',
  });
  assert.equal(own[1].apiKey, 'clave-dos');
  assert.equal(own[1].publicUrl, 'http://dos-publico:8096');
});

test('el cliente llama a la URL y la API key de ese servidor, no al otro', async () => {
  const hits = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    hits.push({
      url: String(url),
      method: options.method,
      token: options.headers['X-Emby-Token'],
    });
    const path = String(url);
    const body = path.endsWith('/Users/New') ? { Id: 'nuevo-2', Name: 'ana' } : null;
    return {
      ok: true,
      status: 200,
      headers: { get: () => (body ? 'application/json' : 'text/plain') },
      json: async () => body,
      text: async () => '',
    };
  };
  try {
    const client = createClient({
      key: '2',
      name: 'Servidor 2',
      url: 'http://emby2.test:8096',
      apiKey: 'key-dos',
    });
    const user = await client.createUser('ana', 'secreta');
    assert.equal(user.Id, 'nuevo-2');
    assert.equal(hits[0].url, 'http://emby2.test:8096/emby/Users/New');
    assert.equal(hits[0].token, 'key-dos');
    assert.equal(hits[1].url, 'http://emby2.test:8096/emby/Users/nuevo-2/Password');
    assert.equal(hits[1].token, 'key-dos');
    assert.equal(hits.some((hit) => hit.url.includes('127.0.0.1') || hit.url.includes('175.110.121.37')), false);
  } finally {
    global.fetch = original;
  }
});

test('la migración manda las cuentas viejas al servidor 1 y no pisa una clave ya puesta', () => {
  const memory = new Database(':memory:');
  memory.exec(`
    CREATE TABLE emby_accounts (
      id INTEGER PRIMARY KEY,
      emby_user_id TEXT,
      username TEXT,
      has_emby INTEGER,
      emby_server_key TEXT
    );
    INSERT INTO emby_accounts (emby_user_id, username, has_emby) VALUES ('e-old', 'vieja', 1);
    INSERT INTO emby_accounts (emby_user_id, username, has_emby) VALUES (NULL, 'soloxui', 0);
    INSERT INTO emby_accounts (emby_user_id, username, has_emby, emby_server_key) VALUES ('e-dos', 'ya', 1, '2');
  `);
  assert.equal(assignExistingEmbyAccounts(memory), 1);
  assert.equal(memory.prepare("SELECT emby_server_key FROM emby_accounts WHERE username = 'vieja'").get().emby_server_key, '1');
  assert.equal(memory.prepare("SELECT emby_server_key FROM emby_accounts WHERE username = 'soloxui'").get().emby_server_key, null);
  assert.equal(memory.prepare("SELECT emby_server_key FROM emby_accounts WHERE username = 'ya'").get().emby_server_key, '2');
  assert.equal(assignExistingEmbyAccounts(memory), 0);
  memory.close();

  const cols = db.prepare('PRAGMA table_info(emby_servers)').all().map((col) => col.name);
  assert.equal(cols.includes('api_key'), false);
  assert.equal(cols.includes('apiKey'), false);
  const catalog = db.prepare('SELECT server_key, name FROM emby_servers ORDER BY server_key').all();
  assert.deepEqual(catalog.map((row) => row.server_key), ['1', '2']);
});

test('crear con Emby en el servidor 2 no toca el servidor 1', async () => {
  const calls = install();
  const before = actor().credits;
  const created = await accounts.createAccount({
    username: 'en.dos',
    password: 'clave-dos',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: false, embyServer: '2' },
  });
  const row = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.emby_server_key, '2');
  assert.equal(row.emby_user_id, '2-en.dos');
  assert.equal(actor().credits, before - 1);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['2', '2']
  );
  assert.equal(calls[0][1], 'create');
  assert.equal(calls[0][3], 'clave-dos');
  assert.equal(calls.some((call) => call[0] === '1'), false);
  const card = accounts.connectionCard(created.id, actor());
  assert.match(card.message, /Servidor: http:\/\/emby-publico\.test:8096/);
  assert.equal(card.embyServerName, 'Servidor 2');
});

test('transferir de 1 a 2 y de 2 a 1 copia usuario, contraseña y política, sin créditos', async () => {
  const calls = install();
  const created = await accounts.createAccount({
    username: 'va.y.vuelve',
    password: 'misma-clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: false, embyServer: '1' },
  });
  db.prepare('UPDATE emby_accounts SET screens = 2 WHERE id = ?').run(created.id);
  calls.length = 0;
  const credits = actor().credits;
  const moved = await accounts.transferEmbyServer({
    accountId: created.id,
    targetKey: '2',
    actor: actor(),
  });
  assert.equal(moved.toName, 'Servidor 2');
  assert.equal(moved.publicUrl, 'http://emby-publico.test:8096');
  assert.equal(actor().credits, credits);
  const row = db.prepare('SELECT emby_user_id, emby_server_key FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.emby_server_key, '2');
  assert.equal(row.emby_user_id, '2-va.y.vuelve');
  const policy = calls.find((call) => call[0] === '2' && call[1] === 'policy');
  assert.ok(policy);
  assert.equal(policy[3].SimultaneousStreamLimit, 2);
  assert.equal(policy[3].IsDisabled, false);
  assert.equal(policy[3].IsAdministrator, false);
  assert.deepEqual(policy[3].EnabledFolders, ['lib-a']);
  assert.ok(calls.some((call) => call[0] === '2' && call[1] === 'password' && call[3] === 'misma-clave'));
  assert.ok(calls.some((call) => call[0] === '2' && call[1] === 'get'));
  assert.ok(calls.some((call) => call[0] === '1' && call[1] === 'delete'));

  calls.length = 0;
  await accounts.transferEmbyServer({
    accountId: created.id,
    targetKey: '1',
    actor: actor(),
  });
  const back = db.prepare('SELECT emby_user_id, emby_server_key FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(back.emby_server_key, '1');
  assert.ok(calls.some((call) => call[0] === '1' && call[1] === 'create' && call[3] === 'misma-clave'));
  assert.ok(calls.some((call) => call[0] === '2' && call[1] === 'delete'));
  assert.equal(actor().credits, credits);
});

test('si el destino no confirma el usuario, se deshace y la cuenta sigue en el origen', async () => {
  const calls = install({ 2: { badVerify: true } });
  const created = await accounts.createAccount({
    username: 'no.confirma',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: false },
  });
  const before = db.prepare('SELECT emby_user_id, emby_server_key FROM emby_accounts WHERE id = ?').get(created.id);
  calls.length = 0;
  await assert.rejects(
    () => accounts.transferEmbyServer({ accountId: created.id, targetKey: '2', actor: actor() }),
    (err) => {
      assert.equal(err.name, 'BusinessError');
      assert.match(err.message, /Sigue en Servidor 1/);
      return true;
    }
  );
  const after = db.prepare('SELECT emby_user_id, emby_server_key FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(after.emby_user_id, before.emby_user_id);
  assert.equal(after.emby_server_key, '1');
  assert.ok(calls.some((call) => call[0] === '2' && call[1] === 'delete'));
  assert.equal(calls.some((call) => call[0] === '1' && call[1] === 'delete'), false);
});

test('si no se puede borrar el origen, se borra el usuario nuevo y el panel no cambia', async () => {
  const failure = new Error('origen caído');
  failure.status = 500;
  const calls = install({ 1: { deleteError: failure } });
  const created = await accounts.createAccount({
    username: 'origen.cae',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: false },
  });
  const before = db.prepare('SELECT emby_user_id, emby_server_key FROM emby_accounts WHERE id = ?').get(created.id);
  calls.length = 0;
  await assert.rejects(
    () => accounts.transferEmbyServer({ accountId: created.id, targetKey: '2', actor: actor() }),
    (err) => {
      assert.match(err.message, /Se deshizo el usuario en Servidor 2/);
      assert.match(err.message, /sigue en Servidor 1/);
      return true;
    }
  );
  const after = db.prepare('SELECT emby_user_id, emby_server_key FROM emby_accounts WHERE id = ?').get(created.id);
  assert.deepEqual(after, before);
  assert.ok(calls.some((call) => call[0] === '2' && call[1] === 'delete'));
});

test('si el panel no puede guardar el id nuevo, la cuenta vuelve al origen', async () => {
  const calls = install({
    1: { ids: ['origen-vivo', 'restaurada'] },
    2: { ids: ['clash'] },
  });
  const created = await accounts.createAccount({
    username: 'choque.id',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: false },
  });
  db.prepare(
    `INSERT INTO emby_accounts (username, password_hash, owner_id, has_emby, emby_user_id, emby_server_key, status)
     VALUES ('ocupada.clash', 'h', ?, 1, 'clash', '2', 'active')`
  ).run(reseller.id);
  calls.length = 0;
  await assert.rejects(
    () => accounts.transferEmbyServer({ accountId: created.id, targetKey: '2', actor: actor() }),
    (err) => {
      assert.match(err.message, /sigue en Servidor 1/);
      return true;
    }
  );
  const row = db.prepare('SELECT emby_user_id, emby_server_key FROM emby_accounts WHERE id = ?').get(created.id);
  assert.equal(row.emby_server_key, '1');
  assert.equal(row.emby_user_id, 'restaurada');
  assert.ok(calls.some((call) => call[0] === '1' && call[1] === 'create' && call[2] === 'choque.id'));
  assert.ok(calls.some((call) => call[0] === '2' && call[1] === 'delete' && call[2] === 'clash'));
});

test('sin contraseña guardada no se llama a ningún servidor', async () => {
  const calls = install();
  const info = db
    .prepare(
      `INSERT INTO emby_accounts (username, password_hash, owner_id, plan_id, has_emby, emby_user_id, emby_server_key, status)
       VALUES ('sin.clave', 'hash', ?, ?, 1, 'e-sin', '1', 'active')`
    )
    .run(reseller.id, plan.id);
  await assert.rejects(
    () => accounts.transferEmbyServer({ accountId: info.lastInsertRowid, targetKey: '2', actor: actor() }),
    (err) => {
      assert.match(err.message, /No hay contraseña guardada/);
      assert.match(err.message, /sigue en Servidor 1/);
      return true;
    }
  );
  assert.equal(calls.length, 0);
  const row = db.prepare('SELECT emby_server_key FROM emby_accounts WHERE id = ?').get(info.lastInsertRowid);
  assert.equal(row.emby_server_key, '1');
});

test('un revendedor transfiere las suyas y no las de otro, y el resto de operaciones van a ese servidor', async () => {
  const calls = install();
  const created = await accounts.createAccount({
    username: 'de.resi',
    password: 'clave',
    planId: plan.id,
    owner: actor(),
    services: { emby: true, xui: false, embyServer: '2' },
  });
  await assert.rejects(
    () => accounts.transferEmbyServer({ accountId: created.id, targetKey: '1', actor: actor(other) }),
    (err) => {
      assert.match(err.message, /no es tuya/);
      return true;
    }
  );
  calls.length = 0;
  const credits = actor().credits;
  await accounts.transferEmbyServer({ accountId: created.id, targetKey: '1', actor: actor() });
  assert.equal(actor().credits, credits);
  db.prepare("UPDATE emby_accounts SET emby_server_key = '2', emby_user_id = '2-vivo' WHERE id = ?").run(created.id);
  calls.length = 0;
  const account = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(created.id);
  await accounts.changePassword({ accountId: created.id, newPassword: 'nueva-clave', actor: actor() });
  await accounts.renewAccount({ accountId: created.id, planId: plan.id, actor: actor() });
  await accounts.expireRemotes(account);
  await accounts.listDevices(account);
  await accounts.deleteAccount({ accountId: created.id, actor: actor() });
  const kinds = calls.filter((call) => call[0] === '2').map((call) => call[1]);
  assert.ok(kinds.includes('password'));
  assert.ok(kinds.includes('policy'));
  assert.ok(kinds.includes('devices'));
  assert.ok(kinds.includes('delete'));
  assert.equal(calls.some((call) => call[0] === '1'), false);
});
