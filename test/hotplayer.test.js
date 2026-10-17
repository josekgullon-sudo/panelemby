require('./env');

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const hotplayer = require('../src/services/hotplayer');

let originalFetch;

afterEach(() => {
  global.fetch = originalFetch;
  hotplayer.setRetryWait(null);
});

function mockFetch(handler) {
  originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(url, options, calls);
  };
  return calls;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (body == null ? '' : JSON.stringify(body)),
  };
}

test('normaliza la MAC a mayúsculas con dos puntos', () => {
  assert.equal(hotplayer.normalizeMac('aa:bb:cc:dd:ee:ff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(hotplayer.normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(hotplayer.normalizeMac('AABBCCDDEEFF'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(hotplayer.normalizeMac('AA:BB:CC:DD:EE'), '');
  assert.equal(hotplayer.normalizeMac('zz:bb:cc:dd:ee:ff'), '');
  assert.equal(hotplayer.normalizeMac(''), '');
});

test('GET /balance usa ApiKey y no toca otras rutas', async () => {
  const calls = mockFetch(() => jsonResponse({ status: 'success', balance: 12 }));
  const balance = await hotplayer.getBalance();
  assert.equal(balance.balance, 12);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.match(calls[0].url, /\/balance$/);
  assert.equal(calls[0].options.headers.Authorization, 'ApiKey test-hotplayer-key');
  assert.equal(calls[0].url.includes('test-hotplayer-key'), false);
});

test('add-playlists manda HOST:PORT|usuario|clave y el mismo nombre', async () => {
  const calls = mockFetch(() => jsonResponse({ status: 'success' }));
  await hotplayer.addPlaylist('aa:bb:cc:dd:ee:ff', { username: 'linea', password: 'secreta' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].url, /\/add-playlists\/AA%3ABB%3ACC%3ADD%3AEE%3AFF$/);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, [{ name: 'TOTALFLIX', url: 'cisnerojo.click:80|linea|secreta' }]);
  assert.equal(calls.some((call) => /activate|delete-playlists/.test(call.url)), false);
  assert.equal(Object.keys(hotplayer).some((name) => /delete|activate/i.test(name)), false);
});

test('un 5xx se reintenta y el siguiente 200 vale', async () => {
  hotplayer.setRetryWait(() => Promise.resolve());
  let hits = 0;
  const calls = mockFetch(() => {
    hits += 1;
    if (hits === 1) return jsonResponse({ message: 'caido' }, 503);
    return jsonResponse({ status: 'success', balance: 4 });
  });
  const balance = await hotplayer.getBalance();
  assert.equal(balance.balance, 4);
  assert.equal(calls.length, 2);
});

test('tres 5xx seguidos terminan en error', async () => {
  hotplayer.setRetryWait(() => Promise.resolve());
  const calls = mockFetch(() => jsonResponse({ message: 'caido' }, 500));
  await assert.rejects(() => hotplayer.getBalance(), /500/);
  assert.equal(calls.length, 4);
});
