require('./env');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../src/db/database');
const { auditInventedExpiries, isImportPlusThirty, formatAuditReport } = require('../src/services/unlimitedAudit');

const hash = bcrypt.hashSync('secret', 4);
db.prepare("INSERT INTO panel_users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(hash);
const owner = db.prepare("SELECT id FROM panel_users WHERE username = 'admin'").get();
const plan = db.prepare('SELECT id FROM plans LIMIT 1').get();

function add({ username, created, expires, notes, lineId, xuiAt }) {
  db.prepare(
    `INSERT INTO emby_accounts (
       username, password_hash, owner_id, plan_id, expires_at, created_at, status, notes,
       has_emby, xui_line_id, player_kind, xui_expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, 'totalflix', ?)`
  ).run(username, hash, owner.id, plan.id, expires, created, notes, lineId, xuiAt == null ? expires : xuiAt);
}

add({
  username: 'inventada',
  created: '2026-09-01 12:00:00',
  expires: '2026-10-01 12:00:00',
  notes: 'importado de XUI',
  lineId: '50',
});
add({
  username: 'confecha',
  created: '2026-09-01 12:00:00',
  expires: '2026-10-01 12:00:00',
  notes: 'importado de XUI',
  lineId: '51',
});
add({
  username: 'mensual',
  created: '2026-09-01 12:00:00',
  expires: '2026-10-01 12:00:00',
  notes: null,
  lineId: '52',
});

after(() => db.close());

test('la ventana de 30 días cabe en un par de minutos', () => {
  assert.equal(isImportPlusThirty('2026-09-01 12:00:00', '2026-10-01 12:00:30'), true);
  assert.equal(isImportPlusThirty('2026-09-01 12:00:00', '2026-10-01 12:05:00'), false);
  assert.equal(isImportPlusThirty('2026-09-01 12:00:00', null), false);
});

test('la simulación señala la línea sin exp_date y no escribe', async () => {
  const lines = {
    50: { id: '50', username: 'inventada', exp_date: null },
    51: { id: '51', username: 'confecha', exp_date: '2028-01-01 00:00' },
  };
  const summary = await auditInventedExpiries({
    dryRun: true,
    xui: { getLine: async (id) => lines[String(id)] },
  });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.checked, 2);
  assert.equal(summary.matches.length, 1);
  assert.equal(summary.matches[0].username, 'inventada');
  assert.match(formatAuditReport(summary), /Simulación/);
  assert.equal(db.prepare("SELECT expires_at FROM emby_accounts WHERE username = 'inventada'").get().expires_at, '2026-10-01 12:00:00');
  assert.equal(db.prepare("SELECT expires_at FROM emby_accounts WHERE username = 'mensual'").get().expires_at, '2026-10-01 12:00:00');
});

test('aplicar deja sin caducidad solo la línea que XUI confirma vacía', async () => {
  const summary = await auditInventedExpiries({
    dryRun: false,
    xui: {
      getLine: async (id) => (String(id) === '50'
        ? { id: '50', exp_date: null }
        : { id: '51', exp_date: '2028-01-01 00:00' }),
    },
  });
  assert.equal(summary.dryRun, false);
  assert.equal(summary.matches.length, 1);
  const row = db.prepare("SELECT * FROM emby_accounts WHERE username = 'inventada'").get();
  assert.equal(row.expires_at, null);
  assert.equal(row.xui_expires_at, null);
  assert.equal(row.status, 'active');
  assert.equal(db.prepare("SELECT expires_at FROM emby_accounts WHERE username = 'confecha'").get().expires_at, '2026-10-01 12:00:00');
  assert.match(formatAuditReport(summary), /sin caducidad/i);
});
