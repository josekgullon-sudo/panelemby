require('./env');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../src/db/database');
const { syncXuiLines } = require('../src/services/xuiSync');
const config = require('../src/config');

const hash = bcrypt.hashSync('secret', 4);
db.prepare("INSERT INTO panel_users (username, password_hash, role, credits) VALUES ('admin', ?, 'admin', 0)").run(hash);
db.prepare(
  "INSERT INTO panel_users (username, password_hash, role, credits, xui_member_id) VALUES ('reventa', ?, 'reseller', 40, '15')"
).run(hash);
const reseller = db.prepare("SELECT id FROM panel_users WHERE username = 'reventa'").get();
db.prepare(
  `INSERT INTO emby_accounts (emby_user_id, username, password_hash, owner_id, plan_id, expires_at, status, has_emby, emby_expires_at)
   VALUES ('emby-9', 'ya.emby', ?, 1, 1, '2030-01-01 00:00:00', 'active', 1, '2030-01-01 00:00:00')`
).run(hash);
db.prepare(
  `INSERT INTO emby_accounts (username, password_hash, owner_id, plan_id, expires_at, status, has_emby, xui_line_id, xui_package_id, player_kind, xui_expires_at)
   VALUES ('ocupado', ?, ?, 1, '2030-01-01 00:00:00', 'active', 0, '99', '7', 'totalflix', '2030-01-01 00:00:00')`
).run(hash, reseller.id);

const lines = [
  { id: '10', username: 'nuevo', password: 'abc', exp_date: '2026-08-01 12:00', member_id: '15', enabled: true, package_id: '' },
  { id: '11', username: 'en.app', password: 'abc', exp_date: '2026-08-01 12:00', member_id: '', enabled: true, package_id: '' },
  { id: '12', username: 'ya.emby', password: 'abc', exp_date: '2026-09-01 12:00', member_id: '15', enabled: true, package_id: '1' },
  { id: '13', username: 'ocupado', password: 'abc', exp_date: '2026-09-01 12:00', member_id: '', enabled: true, package_id: '' },
  { id: '14', username: 'buscado', password: 'abc', exp_date: '2026-09-01 12:00', member_id: '', enabled: true, package_id: '' },
];

const xui = {
  getLines: async () => lines,
  parseExpToDate: (value) => new Date('2026-08-01T10:00:00Z'),
};
let searches = 0;
const maxplayer = {
  listAllUsers: async () => [
    { id: '501', username: 'otro', lists: [{ domain_id: config.maxplayerDomainPatoId, iptv_info: { username: 'en.app' } }] },
  ],
  searchAll: async () => {
    searches += 1;
    return [];
  },
};

after(() => db.close());

test('la sincronización no duplica, no cobra y distingue Max Player', async () => {
  const beforeTx = db.prepare('SELECT COUNT(*) n FROM credit_transactions').get().n;
  const first = await syncXuiLines({ xui, maxplayer });
  assert.equal(first.created, 3);
  assert.equal(first.updated, 1);
  assert.equal(first.conflicts, 1);
  assert.equal(first.maxplayer, 1);
  assert.equal(searches, 0);
  const nuevo = db.prepare("SELECT * FROM emby_accounts WHERE username = 'nuevo'").get();
  assert.equal(nuevo.owner_id, reseller.id);
  assert.equal(nuevo.has_emby, 0);
  assert.equal(nuevo.player_kind, 'totalflix');
  assert.equal(nuevo.xui_line_id, '10');
  const app = db.prepare("SELECT * FROM emby_accounts WHERE username = 'en.app'").get();
  assert.equal(app.player_kind, 'maxplayer');
  assert.equal(app.maxplayer_user_id, '501');
  assert.equal(app.maxplayer_domain_id, config.maxplayerDomainPatoId);
  const emby = db.prepare("SELECT * FROM emby_accounts WHERE username = 'ya.emby'").get();
  assert.equal(emby.has_emby, 1);
  assert.equal(emby.emby_user_id, 'emby-9');
  assert.equal(emby.xui_line_id, '12');
  assert.equal(emby.xui_package_id, '1');
  const buscado = db.prepare("SELECT * FROM emby_accounts WHERE username = 'buscado'").get();
  assert.equal(buscado.player_kind, 'totalflix');
  assert.equal(buscado.maxplayer_user_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM credit_transactions').get().n, beforeTx);

  const second = await syncXuiLines({ xui, maxplayer });
  assert.equal(second.created, 0);
  assert.equal(second.updated, 4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM emby_accounts WHERE username = 'nuevo'").get().n, 1);
  assert.equal(searches, 0);
});

test('un reseller con varios member_id se queda las líneas 3 y 10', async () => {
  const { normalizeMemberIds } = require('../src/services/xuiSync');
  assert.deepEqual(normalizeMemberIds('3, 10'), ['3', '10']);
  assert.throws(() => normalizeMemberIds('3, abc'), /números/);
  db.prepare(
    "INSERT INTO panel_users (username, password_hash, role, credits, xui_member_id) VALUES ('milu', ?, 'reseller', 10, '3,10')"
  ).run(hash);
  const milu = db.prepare("SELECT id FROM panel_users WHERE username = 'milu'").get();
  const extra = [
    { id: '30', username: 'de.tres', password: 'abc', exp_date: '2030-01-01 12:00', member_id: '3', enabled: true, package_id: '' },
    { id: '31', username: 'de.diez', password: 'abc', exp_date: '2030-01-01 12:00', member_id: '10', enabled: true, package_id: '' },
    { id: '32', username: 'de.otro', password: 'abc', exp_date: '2030-01-01 12:00', member_id: '99', enabled: true, package_id: '' },
  ];
  await syncXuiLines({
    xui: { getLines: async () => extra, parseExpToDate: () => new Date('2030-01-01T00:00:00Z') },
    maxplayer: { listAllUsers: async () => [], searchAll: async () => { throw new Error('no buscar'); } },
  });
  assert.equal(db.prepare("SELECT owner_id FROM emby_accounts WHERE username = 'de.tres'").get().owner_id, milu.id);
  assert.equal(db.prepare("SELECT owner_id FROM emby_accounts WHERE username = 'de.diez'").get().owner_id, milu.id);
  const admin = db.prepare("SELECT id FROM panel_users WHERE username = 'admin'").get();
  assert.equal(db.prepare("SELECT owner_id FROM emby_accounts WHERE username = 'de.otro'").get().owner_id, admin.id);
});
