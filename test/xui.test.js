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
  assert.equal(q.get('is_trial'), null);
  assert.equal(q.get('allowed_outputs'), null);
  assert.deepEqual(q.getAll('access_output[]'), ['1', '2', '3']);
});

test('buildUrl repite access_output[] y create_line usa XUI_ALLOWED_OUTPUTS', async () => {
  assert.deepEqual(xui.allowedOutputIds(''), null);
  assert.deepEqual(xui.allowedOutputIds('[]'), null);
  assert.deepEqual(xui.allowedOutputIds('1, 2, 3'), [1, 2, 3]);
  assert.deepEqual(xui.allowedOutputIds('[4,5]'), [4, 5]);
  assert.deepEqual(xui.allowedOutputIds('no'), null);

  const url = xui.buildUrl('edit_line', {
    id: '4',
    username: 'ana',
    'access_output[]': [1, 2, 3],
  });
  assert.deepEqual(url.searchParams.getAll('access_output[]'), ['1', '2', '3']);
  assert.equal((url.search.match(/access_output%5B%5D=/g) || []).length, 3);
  assert.equal(url.searchParams.get('username'), 'ana');

  const seen = fakeTransport({ status: 'STATUS_SUCCESS', data: { id: '7', username: 'ana' } });
  await xui.createLine({
    username: 'ana',
    password: 'secret',
    expDate: '2026-05-01 10:00',
    maxConnections: 1,
    packageId: '4',
  });
  assert.equal(seen[0].searchParams.get('action'), 'create_line');
  assert.deepEqual(seen[0].searchParams.getAll('access_output[]'), ['1', '2', '3']);
  assert.equal(seen[0].searchParams.get('allowed_outputs'), null);

  const previous = config.xuiAllowedOutputs;
  config.xuiAllowedOutputs = '2, 3';
  try {
    await xui.createLine({
      username: 'ana',
      password: 'secret',
      expDate: '2026-05-01 10:00',
      maxConnections: 1,
      packageId: '4',
    });
    assert.deepEqual(seen[1].searchParams.getAll('access_output[]'), ['2', '3']);
  } finally {
    config.xuiAllowedOutputs = previous;
  }
});

test('edit_line lee la línea, reenvía el conjunto completo y lo comprueba', async () => {
  const line = {
    id: 7,
    username: 'ana',
    password: 'secret',
    exp_date: '2026-05-01 10:00',
    bouquet: '[10,11]',
    max_connections: '2',
    is_trial: '0',
    enabled: '1',
    admin_enabled: '1',
    member_id: '3',
    allowed_outputs: '[]',
    allowed_ips: '["1.2.3.4"]',
    allowed_ua: '[]',
    admin_notes: 'nota interna',
    reseller_notes: 'nota reseller',
    created_at: '2026-01-01 00:00:00',
    active_connections: '4',
  };
  const seen = [];
  xui.setTransport(async (url) => {
    seen.push(url);
    const action = url.searchParams.get('action');
    if (action === 'get_line') {
      return { status: 200, body: JSON.stringify({ status: 'STATUS_SUCCESS', data: line }) };
    }
    return { status: 200, body: JSON.stringify({ status: 'STATUS_SUCCESS', data: { id: '7' } }) };
  });

  const previous = config.xuiAllowedOutputs;
  config.xuiAllowedOutputs = '1,2,3';
  try {
    await xui.editLine('7', { exp_date: '2026-06-01 12:00', bouquets_selected: '[]' });
  } finally {
    config.xuiAllowedOutputs = previous;
  }

  assert.deepEqual(seen.map((url) => url.searchParams.get('action')), ['get_line', 'edit_line', 'get_line']);
  const edit = seen[1].searchParams;
  assert.equal(edit.get('id'), '7');
  assert.equal(edit.get('username'), 'ana');
  assert.equal(edit.get('password'), 'secret');
  assert.equal(edit.get('exp_date'), '2026-06-01 12:00');
  assert.equal(edit.get('bouquets_selected'), '["10","11"]');
  assert.equal(edit.get('max_connections'), '2');
  assert.equal(edit.get('is_trial'), null);
  assert.equal(edit.get('enabled'), '1');
  assert.equal(edit.get('admin_enabled'), '1');
  assert.equal(edit.get('member_id'), '3');
  assert.equal(edit.get('allowed_outputs'), null);
  assert.deepEqual(edit.getAll('access_output[]'), ['1', '2', '3']);
  assert.deepEqual(edit.getAll('allowed_ips[]'), ['1.2.3.4']);
  assert.equal(edit.get('allowed_ips'), null);
  assert.equal(edit.get('allowed_ua'), null);
  assert.deepEqual(edit.getAll('allowed_ua[]'), []);
  assert.equal(edit.get('notes'), 'nota interna');
  assert.equal(edit.get('admin_notes'), 'nota interna');
  assert.equal(edit.get('reseller_notes'), 'nota reseller');
  assert.equal(edit.get('created_at'), null);

  line.allowed_outputs = '[4,5]';
  seen.length = 0;
  await xui.editLine('7', { password: 'nueva' });
  assert.deepEqual(seen[1].searchParams.getAll('access_output[]'), ['4', '5']);
  assert.equal(seen[1].searchParams.get('password'), 'nueva');
  assert.equal(seen[1].searchParams.get('username'), 'ana');
  assert.equal(seen[1].searchParams.get('bouquets_selected'), '["10","11"]');
  assert.equal(seen[1].searchParams.get('is_trial'), null);

  seen.length = 0;
  await xui.disableLine('7');
  const disabled = seen[1].searchParams;
  assert.deepEqual(seen.map((url) => url.searchParams.get('action')), ['get_line', 'edit_line', 'get_line']);
  assert.equal(disabled.get('enabled'), '0');
  assert.equal(disabled.get('username'), 'ana');
  assert.equal(disabled.get('password'), 'secret');
  assert.equal(disabled.get('bouquets_selected'), '["10","11"]');
  assert.equal(disabled.get('is_trial'), null);
  assert.deepEqual(disabled.getAll('access_output[]'), ['4', '5']);
});

test('is_trial solo se envía cuando la línea es prueba', async () => {
  const seen = fakeTransport({ status: 'STATUS_SUCCESS', data: { id: '42', username: 'ana' } });
  await xui.createLine({
    username: 'ana',
    password: 'secret',
    expDate: '2026-05-01 10:00',
    maxConnections: 1,
    packageId: '4',
    isTrial: true,
  });
  assert.equal(seen[0].searchParams.get('is_trial'), '1');

  const line = {
    id: 7,
    username: 'ana',
    password: 'secret',
    exp_date: '2026-05-01 10:00',
    bouquet: '[10]',
    max_connections: '1',
    is_trial: '1',
    enabled: '1',
    admin_enabled: '1',
    member_id: '3',
    allowed_outputs: '[1,2,3]',
  };
  xui.setTransport(async (url) => {
    seen.push(url);
    if (url.searchParams.get('action') === 'get_line') {
      return { status: 200, body: JSON.stringify({ status: 'STATUS_SUCCESS', data: line }) };
    }
    return { status: 200, body: JSON.stringify({ status: 'STATUS_SUCCESS', data: { id: '7' } }) };
  });
  await xui.editLine('7', { exp_date: '2026-06-01 12:00' });
  const trialEdit = seen.at(-2).searchParams;
  assert.equal(trialEdit.get('action'), 'edit_line');
  assert.equal(trialEdit.get('is_trial'), '1');

  line.is_trial = '0';
  await xui.editLine('7', { is_trial: 0 });
  assert.equal(seen.at(-2).searchParams.get('is_trial'), null);

  line.is_trial = '1';
  await xui.editLine('7', { is_trial: '0' });
  assert.equal(seen.at(-2).searchParams.get('is_trial'), null);

  line.is_trial = '0';
  await xui.editLine('7', { is_trial: 1 });
  assert.equal(seen.at(-2).searchParams.get('is_trial'), '1');
});

test('allowed_ips y allowed_ua vacíos no se mandan como texto []', async () => {
  const line = {
    id: 7,
    username: 'ana',
    password: 'secret',
    exp_date: '2026-05-01 10:00',
    bouquet: '[10]',
    max_connections: '1',
    is_trial: 0,
    enabled: '1',
    admin_enabled: '1',
    member_id: '3',
    allowed_outputs: '[1,2,3]',
    allowed_ips: [],
    allowed_ua: '[]',
  };
  let after = null;
  const seen = [];
  xui.setTransport(async (url) => {
    seen.push(url);
    if (url.searchParams.get('action') === 'get_line') {
      const data = seen.filter((item) => item.searchParams.get('action') === 'get_line').length > 1
        ? (after || line)
        : line;
      return { status: 200, body: JSON.stringify({ status: 'STATUS_SUCCESS', data }) };
    }
    return { status: 200, body: JSON.stringify({ status: 'STATUS_SUCCESS', data: { id: '7' } }) };
  });

  await xui.editLine('7', { exp_date: '2026-06-01 12:00' });
  const edit = seen[1].searchParams;
  assert.equal(edit.get('is_trial'), null);
  assert.equal(edit.get('allowed_ips'), null);
  assert.equal(edit.get('allowed_ua'), null);
  assert.deepEqual(edit.getAll('allowed_ips[]'), []);
  assert.deepEqual(edit.getAll('allowed_ua[]'), []);

  line.is_trial = '0';
  line.allowed_ips = '[]';
  line.allowed_ua = null;
  seen.length = 0;
  await xui.editLine('7', { allowed_ips: '[]', allowed_ua: [] });
  assert.equal(seen[1].searchParams.get('is_trial'), null);
  assert.equal(seen[1].searchParams.get('allowed_ips'), null);
  assert.deepEqual(seen[1].searchParams.getAll('allowed_ips[]'), []);
  assert.deepEqual(seen[1].searchParams.getAll('allowed_ua[]'), []);

  line.allowed_ips = ['[]'];
  line.allowed_ua = '["[]"]';
  after = { ...line, allowed_ips: [], allowed_ua: [] };
  seen.length = 0;
  await xui.editLine('7', {});
  assert.deepEqual(seen[1].searchParams.getAll('allowed_ips[]'), []);
  assert.deepEqual(seen[1].searchParams.getAll('allowed_ua[]'), []);
  assert.equal(seen[1].searchParams.get('allowed_ips'), null);

  line.allowed_ips = ['1.2.3.4', '8.8.8.8'];
  line.allowed_ua = '["VLC","TiviMate"]';
  after = null;
  seen.length = 0;
  await xui.editLine('7', {});
  assert.deepEqual(seen[1].searchParams.getAll('allowed_ips[]'), ['1.2.3.4', '8.8.8.8']);
  assert.deepEqual(seen[1].searchParams.getAll('allowed_ua[]'), ['VLC', 'TiviMate']);
  assert.match(seen[1].search, /allowed_ips%5B%5D=/);
  assert.equal(seen[1].searchParams.get('allowed_ips'), null);

  line.allowed_ips = ['1.2.3.4'];
  line.allowed_ua = [];
  after = { ...line, allowed_ips: ['[]'], allowed_ua: '[]' };
  seen.length = 0;
  await assert.rejects(
    () => xui.editLine('7', { exp_date: '2026-07-01 00:00' }),
    /bloquea los dispositivos/
  );
});

test('edit_line falla si después el usuario o los bouquets no coinciden', async () => {
  const line = {
    id: 7,
    username: 'ana',
    password: 'secret',
    exp_date: '2026-05-01 10:00',
    bouquet: '[10,11]',
    max_connections: '1',
    is_trial: '0',
    enabled: '1',
    admin_enabled: '1',
    member_id: '3',
    allowed_outputs: '[1,2,3]',
  };
  let reads = 0;
  const seen = [];
  xui.setTransport(async (url) => {
    const action = url.searchParams.get('action');
    seen.push(action);
    if (action === 'get_line') {
      reads += 1;
      const data = reads === 1 ? line : { ...line, username: '', bouquet: '[]' };
      return { status: 200, body: JSON.stringify({ status: 'STATUS_SUCCESS', data }) };
    }
    return { status: 200, body: JSON.stringify({ status: 'STATUS_SUCCESS' }) };
  });
  await assert.rejects(
    () => xui.editLine('7', { exp_date: '2026-08-01 00:00' }),
    /no conservó el usuario, los bouquets/
  );
  assert.deepEqual(seen, ['get_line', 'edit_line', 'get_line']);
});

test('edit_line no escribe si get_line falla', async () => {
  const seen = [];
  xui.setTransport(async (url) => {
    seen.push(url.searchParams.get('action'));
    return { status: 200, body: JSON.stringify({ status: 'STATUS_FAILURE', error: 'line does not exist' }) };
  });
  await assert.rejects(() => xui.editLine('9', { password: 'x' }), /leer la línea 9/);
  assert.deepEqual(seen, ['get_line']);
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

test('findLineByUsername acepta la línea de get_line y no sigue buscando', async () => {
  const actions = [];
  xui.setTransport(async (url) => {
    actions.push(url.searchParams.get('action'));
    return {
      status: 200,
      body: JSON.stringify({ status: 'STATUS_SUCCESS', data: { id: 3, username: 'Ana' } }),
    };
  });
  const line = await xui.findLineByUsername('ana');
  assert.equal(line.id, '3');
  assert.equal(line.username, 'Ana');
  assert.deepEqual(actions, ['get_line']);
});

test('findLineByUsername prueba get_lines y no recorre ids si no hay línea', async () => {
  const actions = [];
  xui.setTransport(async (url) => {
    actions.push(url.searchParams.get('action'));
    if (url.searchParams.get('action') === 'get_line') {
      return { status: 200, body: JSON.stringify({ status: 'STATUS_FAILURE', error: 'STATUS_FAILURE' }) };
    }
    return { status: 200, body: 'null' };
  });
  assert.equal(await xui.findLineByUsername('libre'), null);
  assert.deepEqual(actions, ['get_line', 'get_lines']);
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
