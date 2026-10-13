require('./env');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../src/db/database');
const accounts = require('../src/services/accounts');
const expiry = require('../src/jobs/expiry');

const hash = bcrypt.hashSync('secret', 4);
db.prepare("INSERT INTO panel_users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(hash);
const owner = db.prepare("SELECT id FROM panel_users WHERE username = 'admin'").get();
const plan = db.prepare('SELECT id FROM plans LIMIT 1').get();

function sqlDays(days) {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function insert(username, embyAt, xuiAt) {
  db.prepare(
    `INSERT INTO emby_accounts (
       emby_user_id, username, password_hash, owner_id, plan_id, expires_at, status,
       has_emby, xui_line_id, player_kind, emby_expires_at, xui_expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, 'totalflix', ?, ?)`
  ).run(`e-${username}`, username, hash, owner.id, plan.id, embyAt, `line-${username}`, embyAt, xuiAt);
}

insert('mixta', sqlDays(-3), sqlDays(20));
insert('reciente', sqlDays(-40), sqlDays(-1));
insert('vieja', sqlDays(-40), sqlDays(-30));
db.prepare(
  `INSERT INTO emby_accounts (
     username, password_hash, owner_id, plan_id, expires_at, status,
     has_emby, xui_line_id, player_kind, xui_expires_at, xui_cut, emby_cut
   ) VALUES ('solo.xui', ?, ?, ?, ?, 'active', 0, 'line-viva', 'totalflix', ?, 0, 0)`
).run(hash, owner.id, plan.id, sqlDays(40), sqlDays(40));

const calls = [];
accounts.setIntegrations({
  emby: {
    updatePolicy: async (id) => calls.push(['emby', id]),
    deleteUser: async (id) => calls.push(['emby.del', id]),
  },
  xui: {
    disableLine: async (id) => calls.push(['xui.off', id]),
    deleteLine: async (id) => calls.push(['xui.del', id]),
  },
  maxplayer: { deleteUser: async () => {} },
});

after(() => {
  accounts.setIntegrations({ emby: null, xui: null, maxplayer: null });
  db.close();
});

test('cada servicio caduca solo y el borrado espera a la fecha más tardía', async () => {
  await expiry.run();

  const mixta = db.prepare("SELECT * FROM emby_accounts WHERE username = 'mixta'").get();
  assert.equal(mixta.emby_cut, 1);
  assert.equal(mixta.xui_cut, 0);
  assert.equal(mixta.status, 'active');
  assert.equal(mixta.expires_at, mixta.xui_expires_at);
  assert.equal(calls.some((c) => c[0] === 'xui.off' && c[1] === 'line-mixta'), false);

  const reciente = db.prepare("SELECT * FROM emby_accounts WHERE username = 'reciente'").get();
  assert.equal(reciente.status, 'expired');
  assert.equal(reciente.emby_cut, 1);
  assert.equal(reciente.xui_cut, 1);

  const vieja = db.prepare("SELECT * FROM emby_accounts WHERE username LIKE 'vieja#del%'").get();
  assert.equal(vieja.status, 'deleted');
  assert.equal(vieja.xui_line_id, null);

  const viva = db.prepare("SELECT * FROM emby_accounts WHERE username = 'solo.xui'").get();
  assert.equal(viva.status, 'active');
  assert.equal(viva.xui_cut, 0);
  assert.equal(calls.some((c) => c[1] === 'line-viva'), false);
});
