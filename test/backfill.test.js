require('./env');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../src/db/database');
const xui = require('../src/services/xui');
const { backfillImportedLines, formatBackfillReport } = require('../src/services/xuiBackfill');

const hash = bcrypt.hashSync('secret', 4);
db.prepare("INSERT INTO panel_users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(hash);
const owner = db.prepare("SELECT id FROM panel_users WHERE username = 'admin'").get();
const plan = db.prepare('SELECT id FROM plans LIMIT 1').get();

function add({ username, lineId, trial = 0, expires = '2026-11-01 00:00:00', notes = 'importado de XUI' }) {
  db.prepare(
    `INSERT INTO emby_accounts (
       username, password_hash, owner_id, plan_id, expires_at, status, notes,
       has_emby, xui_line_id, player_kind, xui_expires_at, is_trial
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, 'totalflix', ?, ?)`
  ).run(username, hash, owner.id, plan.id, expires, notes, lineId, expires, trial);
}

add({ username: 'plana', lineId: '1' });
add({ username: 'ya.prueba', lineId: '2', trial: 1, expires: null });
db.prepare(
  "UPDATE emby_accounts SET xui_expires_at = NULL WHERE username = 'ya.prueba'"
).run();
add({ username: 'creada.aqui', lineId: '3', notes: null });

after(() => {
  xui.setTransport(null);
  xui.setScanWait(null);
  db.close();
});

test('la simulación cuenta pruebas y caducidades vacías sin escribir', async () => {
  let current = 0;
  let peak = 0;
  const summary = await backfillImportedLines({
    dryRun: true,
    concurrency: 4,
    fetchLine: async (id) => {
      current += 1;
      peak = Math.max(peak, current);
      await new Promise((resolve) => setTimeout(resolve, 15));
      current -= 1;
      if (String(id) === '1') return { id: '1', username: 'plana', is_trial: true, exp_date: null };
      if (String(id) === '2') return { id: '2', username: 'ya.prueba', is_trial: true, exp_date: '2028-01-01 00:00' };
      throw new Error('no debería leer la cuenta creada en el panel');
    },
  });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.checked, 2);
  assert.equal(summary.trials, 2);
  assert.equal(summary.trialChanges, 1);
  assert.equal(summary.unlimited, 1);
  assert.equal(summary.expiryChanges, 1);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.errors.length, 0);
  assert.ok(peak <= 4);
  assert.ok(peak >= 2);
  assert.match(formatBackfillReport(summary), /Simulación/);
  assert.match(formatBackfillReport(summary), /is_trial en 1/);
  assert.equal(db.prepare("SELECT is_trial, expires_at FROM emby_accounts WHERE username = 'plana'").get().is_trial, 0);
  assert.equal(db.prepare("SELECT expires_at FROM emby_accounts WHERE username = 'creada.aqui'").get().expires_at, '2026-11-01 00:00:00');
});

test('aplicar guarda la prueba y deja ilimitada la línea sin exp_date', async () => {
  const summary = await backfillImportedLines({
    dryRun: false,
    concurrency: 2,
    fetchLine: async (id) => {
      if (String(id) === '1') return { id: '1', is_trial: '1', exp_date: null };
      return { id: '2', is_trial: 1, exp_date: '2028-01-01 00:00' };
    },
  });
  assert.equal(summary.dryRun, false);
  const row = db.prepare("SELECT * FROM emby_accounts WHERE username = 'plana'").get();
  assert.equal(row.is_trial, 1);
  assert.equal(row.expires_at, null);
  assert.equal(row.xui_expires_at, null);
  const kept = db.prepare("SELECT * FROM emby_accounts WHERE username = 'ya.prueba'").get();
  assert.equal(kept.is_trial, 1);
  assert.equal(kept.expires_at, null);
});

test('un 503 al leer la línea se reintenta y luego se guarda la prueba', async () => {
  add({ username: 'reintento', lineId: '9', expires: '2026-12-01 00:00:00' });
  xui.setScanWait(async () => {});
  let calls = 0;
  xui.setTransport(async (url) => {
    const id = url.searchParams.get('id');
    calls += 1;
    if (calls === 1) return { status: 503, body: '' };
    return {
      status: 200,
      body: JSON.stringify({
        status: 'STATUS_SUCCESS',
        data: { id, username: 'reintento', password: 'a', is_trial: '1', exp_date: null, enabled: '1' },
      }),
    };
  });
  const summary = await backfillImportedLines({ dryRun: false, concurrency: 1 });
  assert.ok(calls >= 2);
  assert.equal(summary.errors.length, 0);
  const row = db.prepare("SELECT * FROM emby_accounts WHERE username = 'reintento'").get();
  assert.equal(row.is_trial, 1);
  assert.equal(row.xui_expires_at, null);
});
