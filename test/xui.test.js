process.env.XUI_INSECURE_TLS = '1';
process.env.XUI_MEMBER_ID = '3';
require('./env');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const xui = require('../src/services/xui');
const config = require('../src/config');

after(() => {
  xui.setTransport(null);
  xui.setScanWait(null);
});

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

test('si get_lines viene null se recorre get_line y se para tras los fallos', async () => {
  const seen = [];
  xui.setTransport(async (url) => {
    const action = url.searchParams.get('action');
    const id = url.searchParams.get('id');
    seen.push(`${action}${id ? `:${id}` : ''}`);
    if (action === 'get_lines') return { status: 200, body: 'null' };
    if (action === 'get_line' && id === '2') {
      return {
        status: 200,
        body: JSON.stringify({
          status: 'STATUS_SUCCESS',
          data: { id: 2, username: 'ana', exp_date: '2026-08-01 12:00', member_id: 3, enabled: 1 },
        }),
      };
    }
    return { status: 200, body: JSON.stringify({ status: 'STATUS_FAILURE', error: 'line does not exist' }) };
  });
  const lines = await xui.getLines({ missStreak: 4, concurrency: 10 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].username, 'ana');
  assert.equal(lines[0].member_id, '3');
  const ids = seen.filter((item) => item.startsWith('get_line:')).map((item) => Number(item.slice('get_line:'.length)));
  assert.ok(ids.includes(2));
  assert.ok(Math.max(...ids) < 30);
  assert.equal(seen.filter((item) => item === 'get_lines').length, 1);
});

test('get_lines con datos no recorre ids', async () => {
  const seen = [];
  xui.setTransport(async (url) => {
    seen.push(url.searchParams.get('action'));
    return { status: 200, body: JSON.stringify([{ id: 4, username: 'beta', enabled: 1 }]) };
  });
  const lines = await xui.getLines();
  assert.equal(lines[0].username, 'beta');
  assert.deepEqual(seen, ['get_lines']);
});

test('el barrido usa poca concurrencia, un hueco largo y un id máximo alto', () => {
  assert.ok(config.xuiScanConcurrency >= 1 && config.xuiScanConcurrency <= 4);
  assert.ok(config.xuiScanMissGap >= 1500);
  assert.ok(config.xuiScanMaxId >= 8000);
});

test('STATUS_FAILURE sin texto es 404', async () => {
  fakeTransport({ status: 'STATUS_FAILURE' });
  await assert.rejects(() => xui.getLine(4), (err) => {
    assert.equal(err.status, 404);
    assert.match(err.message, /STATUS_FAILURE/);
    return true;
  });
});

test('get_line devuelve is_trial como texto "1" y la línea es prueba', async () => {
  xui.setScanWait(async () => {});
  xui.setTransport(async (url) => {
    const action = url.searchParams.get('action');
    const id = url.searchParams.get('id');
    if (action === 'get_lines') return { status: 200, body: 'null' };
    if (id === '1') {
      return {
        status: 200,
        body: JSON.stringify({
          status: 'STATUS_SUCCESS',
          data: {
            id: '1',
            username: 'demo.prueba',
            password: 'x',
            exp_date: null,
            is_trial: '1',
            enabled: '1',
            member_id: '4',
          },
        }),
      };
    }
    return { status: 200, body: JSON.stringify({ status: 'STATUS_FAILURE' }) };
  });
  const lines = await xui.getLines({ missStreak: 2, concurrency: 1, maxId: 4 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].is_trial, true);
  assert.equal(lines[0].exp_date, null);
  assert.equal(xui.trialFlag('0'), false);
  assert.equal(xui.trialFlag('1'), true);
});

test('STATUS_FAILURE sin texto se salta y el escaneo sigue hasta la línea posterior', async () => {
  xui.setScanWait(async () => {});
  xui.setTransport(async (url) => {
    const action = url.searchParams.get('action');
    const id = url.searchParams.get('id');
    if (action === 'get_lines') return { status: 200, body: 'null' };
    if (id === '3') {
      return {
        status: 200,
        body: JSON.stringify({ status: 'STATUS_SUCCESS', data: { id: 3, username: 'tarde', enabled: 1 } }),
      };
    }
    return { status: 200, body: JSON.stringify({ status: 'STATUS_FAILURE' }) };
  });
  const lines = await xui.getLines({ missStreak: 4, concurrency: 2, maxId: 8 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].username, 'tarde');
});

test('un 503 se reintenta y la línea entra', async () => {
  const waits = [];
  const hits = {};
  xui.setScanWait(async (ms) => { waits.push(ms); });
  xui.setTransport(async (url) => {
    const action = url.searchParams.get('action');
    const id = url.searchParams.get('id');
    if (action === 'get_lines') return { status: 200, body: 'null' };
    hits[id] = (hits[id] || 0) + 1;
    if (id === '1' && hits[id] < 3) return { status: 503, body: '' };
    if (id === '1') {
      return { status: 200, body: JSON.stringify({ status: 'STATUS_SUCCESS', data: { id: 1, username: 'ana', enabled: 1 } }) };
    }
    return { status: 200, body: JSON.stringify({ status: 'STATUS_FAILURE' }) };
  });
  const lines = await xui.getLines({ missStreak: 2, concurrency: 1, maxId: 6 });
  assert.equal(lines[0].username, 'ana');
  assert.equal(hits['1'], 3);
  assert.deepEqual(waits.slice(0, 2), [300, 900]);
});

test('si un id sigue en 503 la importación se detiene y no lo salta', async () => {
  const waits = [];
  const ids = [];
  xui.setScanWait(async (ms) => { waits.push(ms); });
  xui.setTransport(async (url) => {
    const action = url.searchParams.get('action');
    const id = url.searchParams.get('id');
    if (action === 'get_lines') return { status: 200, body: 'null' };
    ids.push(id);
    return { status: 503, body: '' };
  });
  await assert.rejects(
    () => xui.getLines({ missStreak: 50, concurrency: 1, maxId: 20 }),
    (err) => {
      assert.match(err.message, /línea 1/);
      assert.match(err.message, /no saltarse/);
      return true;
    }
  );
  assert.deepEqual(ids, ['1', '1', '1', '1', '1']);
  assert.deepEqual(waits, [300, 900, 2700, 8000]);
});

test('un fallo que no es id ausente no se reintenta ni se salta', async () => {
  let calls = 0;
  xui.setScanWait(async () => {});
  xui.setTransport(async (url) => {
    if (url.searchParams.get('action') === 'get_lines') return { status: 200, body: 'null' };
    calls += 1;
    return { status: 200, body: JSON.stringify({ status: 'STATUS_FAILURE', error: 'invalid package' }) };
  });
  await assert.rejects(
    () => xui.getLines({ concurrency: 1, missStreak: 5, maxId: 4 }),
    /línea 1/
  );
  assert.equal(calls, 1);
});

test('un hueco corto no tapa la línea siguiente y el id máximo corta el barrido', async () => {
  xui.setScanWait(async () => {});
  xui.setTransport(async (url) => {
    const action = url.searchParams.get('action');
    const id = url.searchParams.get('id');
    if (action === 'get_lines') return { status: 200, body: 'null' };
    if (id === '1' || id === '8') {
      return {
        status: 200,
        body: JSON.stringify({ status: 'STATUS_SUCCESS', data: { id: Number(id), username: `u${id}`, enabled: 1 } }),
      };
    }
    return { status: 200, body: JSON.stringify({ status: 'STATUS_FAILURE' }) };
  });
  const lines = await xui.getLines({ missStreak: 10, concurrency: 4, maxId: 30 });
  assert.deepEqual(lines.map((line) => line.username), ['u1', 'u8']);
  const rest = [];
  xui.setTransport(async (url) => {
    const action = url.searchParams.get('action');
    const id = url.searchParams.get('id');
    if (action === 'get_lines') return { status: 200, body: 'null' };
    rest.push(Number(id));
    if (id === '50') {
      return { status: 200, body: JSON.stringify({ status: 'STATUS_SUCCESS', data: { id: 50, username: 'lejos', enabled: 1 } }) };
    }
    return { status: 200, body: JSON.stringify({ status: 'STATUS_FAILURE' }) };
  });
  const cut = await xui.getLines({ missStreak: 100, concurrency: 4, maxId: 10 });
  assert.equal(cut.length, 0);
  assert.deepEqual([...new Set(rest)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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
