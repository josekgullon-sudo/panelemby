require('./env');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../src/db/database');
const { listPaidLinesFlaggedTrial, formatTrialAudit } = require('../src/services/xuiTrialAudit');

const hash = bcrypt.hashSync('secret', 4);
db.prepare("INSERT INTO panel_users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(hash);
const owner = db.prepare("SELECT id FROM panel_users WHERE username = 'admin'").get();
const plan = db.prepare('SELECT id FROM plans LIMIT 1').get();

function add({ username, lineId, trial = 0, notes = null, status = 'active', packageName = 'Mensual' }) {
  db.prepare(
    `INSERT INTO emby_accounts (
       username, password_hash, owner_id, plan_id, expires_at, status, notes,
       has_emby, xui_line_id, xui_package_name, player_kind, is_trial
     ) VALUES (?, ?, ?, ?, '2027-01-01 00:00:00', ?, ?, 0, ?, ?, 'totalflix', ?)`
  ).run(username, hash, owner.id, plan.id, status, notes, lineId, packageName, trial);
}

add({ username: 'pago.mal', lineId: '10', packageName: 'Mensual 30' });
add({ username: 'pago.bien', lineId: '11' });
add({ username: 'es.prueba', lineId: '12', trial: 1 });
add({ username: 'importada', lineId: '13', notes: 'importado de XUI' });
add({ username: 'borrada', lineId: '14', status: 'deleted' });

after(() => db.close());

test('lista solo las de pago creadas en el panel que XUI tiene como prueba', async () => {
  const calls = [];
  const summary = await listPaidLinesFlaggedTrial({
    concurrency: 2,
    fetchLine: async (id) => {
      calls.push(String(id));
      if (String(id) === '10') return { id, username: 'pago.mal', is_trial: '1' };
      if (String(id) === '11') return { id, username: 'pago.bien', is_trial: '0' };
      throw new Error('línea que no toca');
    },
  });
  assert.deepEqual(calls.sort(), ['10', '11']);
  assert.equal(summary.checked, 2);
  assert.equal(summary.flagged.length, 1);
  assert.equal(summary.flagged[0].username, 'pago.mal');
  assert.equal(summary.flagged[0].xui_line_id, '10');
  assert.equal(summary.flagged[0].packageName, 'Mensual 30');
  assert.equal(summary.errors.length, 0);
  const report = formatTrialAudit(summary);
  assert.match(report, /Solo lectura/);
  assert.match(report, /pago\.mal · línea 10 · admin · Mensual 30/);
  assert.equal(report.includes('pago.bien'), false);
  assert.equal(db.prepare('SELECT is_trial FROM emby_accounts WHERE username = ?').get('pago.mal').is_trial, 0);
});

test('un fallo de lectura se cuenta y no se escribe', async () => {
  const summary = await listPaidLinesFlaggedTrial({
    fetchLine: async (id) => {
      if (String(id) === '11') throw new Error('timeout');
      return { id, is_trial: 0 };
    },
  });
  assert.equal(summary.flagged.length, 0);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].username, 'pago.bien');
  assert.match(formatTrialAudit(summary), /timeout/);
});
