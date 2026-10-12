process.env.XUI_INSECURE_TLS = '1';
process.env.XUI_MEMBER_ID = '3';
require('./env');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const xui = require('../src/services/xui');

after(() => xui.setTransport(null));

function fakeTransport(payload, status = 200) {
  const seen = [];
  xui.setTransport(async (url) => {
    seen.push(url);
    return { status, body: typeof payload === 'string' ? payload : JSON.stringify(payload) };
  });
  return seen;
}

test('get_packages acepta un array pelado y normaliza campos', async () => {
  const seen = fakeTransport([
    {
      id: 4,
      package_name: 'Mensual',
      is_trial: '0',
      is_official: 1,
      official_duration: '720',
      max_connections: '2',
      bouquets: '[1,2]',
    },
  ]);
  const packs = await xui.getPackages();
  assert.equal(packs.length, 1);
  assert.equal(packs[0].id, '4');
  assert.equal(packs[0].package_name, 'Mensual');
  assert.equal(packs[0].is_trial, false);
  assert.equal(packs[0].is_official, true);
  assert.equal(packs[0].max_connections, 2);
  assert.deepEqual(packs[0].bouquets, ['1', '2']);
  const url = seen[0];
  assert.equal(url.searchParams.get('action'), 'get_packages');
  assert.equal(url.searchParams.get('api_key'), 'test-xui-key');
  assert.match(url.toString(), /https:\/\/xui\.test\/access\//);
});

test('get_packages acepta el sobre STATUS_SUCCESS', async () => {
  fakeTransport({ status: 'STATUS_SUCCESS', data: [{ id: 1, package_name: 'Demo', is_trial: 1, bouquets: [{ id: 9 }] }] });
  const packs = await xui.getPackages();
  assert.equal(packs[0].id, '1');
  assert.equal(packs[0].is_trial, true);
  assert.deepEqual(packs[0].bouquets, ['9']);
});

test('STATUS_FAILURE se convierte en XuiError y un id ausente es 404', async () => {
  fakeTransport({ status: 'STATUS_FAILURE', error: 'line does not exist' });
  await assert.rejects(() => xui.getLine(9), (err) => {
    assert.equal(err.name, 'XuiError');
    assert.equal(err.status, 404);
    assert.match(err.message, /does not exist/);
    return true;
  });
});

test('create_line manda paquete, caducidad, bouquets y member_id', async () => {
  const seen = fakeTransport({ status: 'STATUS_SUCCESS', data: { id: '42', username: 'ana' } });
  const line = await xui.createLine({
    username: 'ana',
    password: 'secret',
    expDate: 1700000000,
    maxConnections: 2,
    packageId: '4',
    isTrial: false,
    bouquets: [1, 2],
  });
  assert.equal(line.id, '42');
  const q = seen[0].searchParams;
  assert.equal(q.get('action'), 'create_line');
  assert.equal(q.get('username'), 'ana');
  assert.equal(q.get('package'), '4');
  assert.match(q.get('exp_date'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(q.get('exp_date'), xui.formatExpDate(1700000000));
  assert.equal(xui.formatExpDate(new Date('2026-01-15T23:30:00.000Z')), '2026-01-16 00:30');
  assert.equal(xui.formatExpDate(new Date('2026-07-15T22:30:00.000Z')), '2026-07-16 00:30');
  assert.equal(xui.formatExpDate('2026-03-01 10:15'), '2026-03-01 10:15');
  assert.equal(q.get('max_connections'), '2');
  assert.equal(q.get('bouquets_selected'), '["1","2"]');
  assert.equal(q.get('member_id'), '3');
  assert.equal(q.get('is_trial'), '0');
});

test('la petición real de XUI no verifica TLS solo cuando el flag está activo', async () => {
  assert.equal(xui.tlsRejectUnauthorized(), false);
  const original = https.request;
  let captured;
  https.request = function request(url, options, callback) {
    captured = options.rejectUnauthorized;
    const res = {
      statusCode: 200,
      on(event, fn) {
        if (event === 'data') fn(Buffer.from('[]'));
        if (event === 'end') fn();
        return res;
      },
    };
    callback(res);
    return { setTimeout() {}, on() {}, end() {}, destroy() {} };
  };
  xui.setTransport(null);
  try {
    await xui.getPackages();
  } finally {
    https.request = original;
  }
  assert.equal(captured, false);
});
