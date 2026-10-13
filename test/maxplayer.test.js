require('./env');

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const maxplayer = require('../src/services/maxplayer');

let originalFetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetch(handler) {
  originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls);
  };
  return calls;
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    text: async () => (body == null ? '' : JSON.stringify(body)),
  };
}

test('POST /users manda Api-Token y las credenciales IPTV de la línea', async () => {
  const calls = mockFetch((url, options) => {
    if (options.method === 'POST' && url.endsWith('/users')) {
      return jsonResponse({ success: 1, user_id: '55', max_devices: 1, max_profiles: 5 });
    }
    if (options.method === 'PUT' && url.endsWith('/users/list')) {
      return jsonResponse({ success: 1 });
    }
    throw new Error(`fetch inesperado ${options.method} ${url}`);
  });
  const created = await maxplayer.provisionUser({
    username: 'ana',
    password: 'secreta',
    iptvUser: 'ana',
    iptvPass: 'secreta',
    domainId: '9',
  });
  assert.equal(created.userId, '55');
  const create = calls[0];
  assert.equal(create.options.headers['Api-Token'], 'test-mp-key');
  assert.deepEqual(JSON.parse(create.options.body), {
    domain_id: '9',
    iptv_user: 'ana',
    iptv_pass: 'secreta',
    username: 'ana',
    user_password: 'secreta',
  });
  const list = JSON.parse(calls[1].options.body);
  assert.equal(list.user_id, '55');
  assert.equal(list.iptv_username, 'ana');
  assert.equal(list.iptv_password, 'secreta');
  assert.equal(list.domain_id, '9');
});

test('si la lista aún no existe, PUT /users/list cae a POST /users/list', async () => {
  const calls = mockFetch((url, options) => {
    if (options.method === 'PUT') return jsonResponse({ success: 0, error: 'no list' }, 404);
    return jsonResponse({ success: 1 });
  });
  await maxplayer.attachPlaylist('55', { domainId: '9', iptvUsername: 'ana', iptvPassword: 'secreta' });
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[1].options.method, 'POST');
  assert.match(calls[1].url, /\/users\/list$/);
});

test('un 409 al crear busca el usuario, lo conecta y fija la lista', async () => {
  mockFetch((url, options) => {
    if (options.method === 'POST' && url.endsWith('/users')) {
      return jsonResponse({ success: 0, error: 'ya existe' }, 409);
    }
    if (options.method === 'PUT' && url.endsWith('/users/connect')) return jsonResponse({ success: 1 });
    if (options.method === 'POST' && url.endsWith('/users/search')) {
      return jsonResponse({ success: 1, users: [{ id: '77', username: 'ana' }], next_cursor: '', has_more: false });
    }
    if (url.endsWith('/users/list')) return jsonResponse({ success: 1 });
    throw new Error(`fetch inesperado ${options.method} ${url}`);
  });
  const created = await maxplayer.provisionUser({
    username: 'ana',
    password: 'secreta',
    iptvUser: 'ana',
    iptvPass: 'secreta',
  });
  assert.equal(created.userId, '77');
});

test('DELETE /users/{id} y los errores de la API conservan el status', async () => {
  mockFetch(() => jsonResponse({ success: 1 }));
  await maxplayer.deleteUser('55');

  mockFetch(() => jsonResponse({ success: 0, error: 'Device limit must be a whole number between 1 and 5' }, 400));
  await assert.rejects(() => maxplayer.setDeviceLimit('55', 0), (err) => {
    assert.equal(err.name, 'MaxPlayerError');
    assert.equal(err.status, 400);
    assert.match(err.message, /Device limit/);
    return true;
  });
});

test('un 503 de cupo se reintenta y luego sigue', async () => {
  maxplayer.setRetryWait(async () => {});
  let n = 0;
  mockFetch(() => {
    n += 1;
    if (n === 1) return jsonResponse({ success: 0, error: 'Could not verify public API allowance. Please retry.' }, 503);
    return jsonResponse({ success: 1, name: 'ok' });
  });
  const info = await maxplayer.getInfo();
  assert.equal(info.name, 'ok');
  assert.equal(n, 2);
  maxplayer.setRetryWait(null);
});

test('un 429 menciona Retry-After', async () => {
  maxplayer.setRetryWait(async () => {});
  mockFetch(() => jsonResponse(null, 429, { 'retry-after': '8' }));
  await assert.rejects(() => maxplayer.getInfo(), /8 s/);
  maxplayer.setRetryWait(null);
});

test('un 429 con «Reintenta en N s» espera esos segundos y reintenta', async () => {
  const waits = [];
  maxplayer.setRetryWait(async (ms) => waits.push(ms));
  let n = 0;
  mockFetch(() => {
    n += 1;
    if (n === 1) return jsonResponse({ error: 'Reintenta en 2 s' }, 429);
    return jsonResponse({ success: 1, name: 'ok' });
  });
  const info = await maxplayer.getInfo();
  assert.equal(info.name, 'ok');
  assert.deepEqual(waits, [2000]);
  maxplayer.setRetryWait(null);
});

test('searchAll deja un segundo entre búsquedas', async () => {
  const waits = [];
  maxplayer.setRetryWait(async (ms) => waits.push(ms));
  mockFetch(() => jsonResponse({ users: [], has_more: false }));
  await maxplayer.searchAll('ana');
  await maxplayer.searchAll('luis');
  assert.ok(waits.some((ms) => ms > 0 && ms <= 1000));
  maxplayer.setRetryWait(null);
});

test('cambiar de dominio edita la lista que ya hay y borra el resto', async () => {
  const calls = mockFetch((url, options) => {
    if (options.method === 'GET' && url.endsWith('/customers/55/lists')) {
      return jsonResponse({
        success: 1,
        data: [
          { id: '8', name: 'Lista', domain_id: '1761067741584705224' },
          { id: '9', name: 'New list', domain_id: '1788037663857452993' },
        ],
      });
    }
    if (options.method === 'PUT' && url.endsWith('/customers/55/lists/8')) return jsonResponse({ success: 1 });
    if (options.method === 'DELETE' && url.endsWith('/customers/55/lists/9')) return jsonResponse({ success: 1 });
    throw new Error(`fetch inesperado ${options.method} ${url}`);
  });
  const result = await maxplayer.replacePlaylist('55', {
    domainId: '1788037663857452993',
    iptvUsername: 'ana',
    iptvPassword: 'secreta',
  });
  assert.equal(result.kept, '8');
  assert.equal(result.deleted, 1);
  const edit = calls.find((call) => call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(edit.options.body), {
    domain_id: '1788037663857452993',
    iptv_username: 'ana',
    iptv_password: 'secreta',
  });
  assert.equal(calls.some((call) => String(call.url).includes('/users/list')), false);
});

test('sin listas, Reparar crea una sola por POST /users/list', async () => {
  const calls = mockFetch((url, options) => {
    if (options.method === 'GET') return jsonResponse({ success: 1, data: [] });
    if (options.method === 'POST' && url.endsWith('/users/list')) return jsonResponse({ success: 1 });
    throw new Error(`fetch inesperado ${options.method} ${url}`);
  });
  const result = await maxplayer.replacePlaylist('55', {
    domainId: '9',
    iptvUsername: 'ana',
    iptvPassword: 'secreta',
  });
  assert.equal(result.created, true);
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
});
