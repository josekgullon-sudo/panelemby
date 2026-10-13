require('./env');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../src/db/database');
const {
  syncXuiLines,
  formatSyncReport,
  startSyncInBackground,
  jobSnapshot,
  setSyncRunner,
} = require('../src/services/xuiSync');
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
  const preview = await syncXuiLines({ dryRun: true, xui, maxplayer });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.created, 3);
  assert.equal(preview.updated, 1);
  assert.equal(preview.conflicts, 1);
  assert.equal(preview.maxplayer, 1);
  assert.equal(preview.totalflix, 3);
  assert.equal(preview.active, 1);
  assert.equal(preview.expired, 3);
  assert.equal(preview.owners.reventa, 2);
  assert.equal(preview.owners.admin, 2);
  assert.equal(preview.domains.PATO, 1);
  assert.equal(preview.domains['sin dominio'], 3);
  assert.deepEqual(preview.errors, []);
  const report = formatSyncReport(preview);
  assert.match(report, /reventa/);
  assert.match(report, /admin/);
  assert.match(report, /Simulación/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM emby_accounts WHERE username = 'nuevo'").get().n, 0);

  const first = await syncXuiLines({ xui, maxplayer });
  assert.equal(first.created, 3);
  assert.equal(first.updated, 1);
  assert.equal(first.conflicts, 1);
  assert.equal(first.maxplayer, 1);
  assert.equal(first.totalflix, 3);
  assert.equal(first.active, 1);
  assert.equal(first.expired, 3);
  assert.equal(first.owners.reventa, 2);
  assert.equal(first.owners.admin, 2);
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

test('el informe separa CISNE, otro servidor y un error de guardado', async () => {
  const preview = await syncXuiLines({
    dryRun: true,
    xui: {
      getLines: async () => [
        { id: '80', username: 'cisne.user', password: 'abc', exp_date: '2030-01-01 12:00', member_id: '', enabled: true, package_id: '' },
        { id: '81', username: 'otro.srv', password: 'abc', exp_date: '2030-01-01 12:00', member_id: '', enabled: true, package_id: '' },
      ],
      parseExpToDate: () => new Date('2030-01-01T00:00:00Z'),
    },
    maxplayer: {
      listAllUsers: async () => [
        { id: '9', lists: [{ domain_id: config.maxplayerDomainCisneId, iptv_info: { username: 'cisne.user' } }] },
        { id: '10', lists: [{ domain_id: '999', iptv_info: { username: 'otro.srv' } }] },
      ],
    },
  });
  assert.equal(preview.domains.CISNE, 1);
  assert.equal(preview.domains['otro servidor'], 1);
  assert.equal(preview.active, 2);
  assert.match(formatSyncReport(preview), /CISNE/);

  db.prepare(
    `INSERT INTO emby_accounts (username, password_hash, owner_id, plan_id, expires_at, status, has_emby)
     VALUES ('fantasma', ?, 1, 1, '2030-01-01 00:00:00', 'deleted', 0)`
  ).run(hash);
  const saved = await syncXuiLines({
    xui: {
      getLines: async () => [
        { id: '70', username: 'fantasma', password: 'abc', exp_date: '2030-01-01 12:00', member_id: '', enabled: true, package_id: '' },
        { id: '71', username: 'sigue', password: 'abc', exp_date: '2030-01-01 12:00', member_id: '', enabled: true, package_id: '' },
      ],
      parseExpToDate: () => new Date('2030-01-01T00:00:00Z'),
    },
    maxplayer: { listAllUsers: async () => [] },
  });
  assert.equal(saved.errors.length, 1);
  assert.equal(saved.errors[0].username, 'fantasma');
  assert.equal(saved.created, 1);
  assert.ok(db.prepare("SELECT id FROM emby_accounts WHERE username = 'sigue' AND status != 'deleted'").get());
});

test('la sincronización del admin arranca en segundo plano y publica el avance', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  setSyncRunner(async ({ onProgress }) => {
    await onProgress({ phase: 'xui', scannedId: 12, found: 3 });
    await pending;
    return {
      lines: 3, created: 1, updated: 0, conflicts: 0, maxplayer: 0, totalflix: 1,
      active: 1, expired: 0, owners: { admin: 1 }, domains: {}, errors: [], dryRun: false,
    };
  });
  try {
    assert.equal(startSyncInBackground().started, true);
    assert.equal(startSyncInBackground().started, false);
    for (let i = 0; i < 10 && jobSnapshot().scannedId !== 12; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(jobSnapshot().running, true);
    assert.equal(jobSnapshot().phase, 'xui');
    assert.equal(jobSnapshot().found, 3);
    release();
    for (let i = 0; i < 10 && jobSnapshot().phase !== 'done'; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const done = jobSnapshot();
    assert.equal(done.running, false);
    assert.equal(done.phase, 'done');
    assert.equal(done.summary.created, 1);
    assert.match(done.text, /admin/);
  } finally {
    release();
    setSyncRunner(null);
  }

  const view = require('fs').readFileSync(require('path').join(__dirname, '../src/views/admin/accounts.ejs'), 'utf8');
  const route = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/admin.js'), 'utf8');
  assert.match(view, /sincronizar-xui\/estado/);
  assert.match(view, /data-running/);
  assert.match(view, /location\.reload/);
  assert.match(route, /startSyncInBackground/);
  assert.doesNotMatch(route, /await syncXuiLines/);
});
