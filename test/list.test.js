require('./env');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../src/db/database');
const config = require('../src/config');
const { listAccounts, dueServices } = require('../src/services/accounts');

const hash = bcrypt.hashSync('secret', 4);
const adminId = db.prepare(
  "INSERT INTO panel_users (username, password_hash, role, credits) VALUES ('admin', ?, 'admin', 0)"
).run(hash).lastInsertRowid;
const resellerId = db.prepare(
  "INSERT INTO panel_users (username, password_hash, role, credits) VALUES ('reventa', ?, 'reseller', 10)"
).run(hash).lastInsertRowid;
const planId = db.prepare('SELECT id FROM plans ORDER BY id LIMIT 1').get().id;

const insert = db.prepare(
  `INSERT INTO emby_accounts (
     username, password_hash, owner_id, plan_id, expires_at, created_at, status,
     has_emby, player_kind, maxplayer_domain_id
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
);

for (let i = 1; i <= 60; i += 1) {
  const day = new Date(Date.UTC(2030, 0, i));
  const expires = day.toISOString().replace('T', ' ').slice(0, 19);
  const created = new Date(Date.UTC(2024, 0, 61 - i)).toISOString().replace('T', ' ').slice(0, 19);
  insert.run(
    `u${String(i).padStart(2, '0')}`,
    hash,
    i % 2 === 0 ? resellerId : adminId,
    planId,
    expires,
    created,
    i % 5 === 0 ? 'expired' : 'active',
    i % 3 === 0 ? 'totalflix' : null,
    i % 7 === 0 ? String(config.maxplayerDomainPatoId) : null
  );
}
insert.run('borrada', hash, adminId, planId, '2030-01-01 00:00:00', '2024-01-01 00:00:00', 'deleted', null, null);

after(() => db.close());

test('la página corta en SQL y no repite filas', () => {
  const first = listAccounts({ tam: '25', pagina: '1' });
  const second = listAccounts({ tam: '25', pagina: '2' });
  assert.equal(first.total, 60);
  assert.equal(first.pageSize, 25);
  assert.equal(first.list.length, 25);
  assert.equal(second.list.length, 25);
  assert.equal(first.from, 1);
  assert.equal(second.from, 26);
  const seen = new Set(first.list.map((row) => row.id));
  assert.ok(second.list.every((row) => !seen.has(row.id)));
  assert.ok(first.list.every((row) => row.status !== 'deleted'));
  assert.ok(first.list[0].expires_at < second.list[0].expires_at);
});

test('un tamaño inválido vuelve a 50 y una página de más cae en la última', () => {
  const page = listAccounts({ tam: '999', pagina: '9' });
  assert.equal(page.pageSize, 50);
  assert.equal(page.pages, 2);
  assert.equal(page.page, 2);
  assert.equal(page.list.length, 10);
  assert.equal(page.to, 60);
});

test('reseller, servicio, estado y servidor filtran el total, no solo la página', () => {
  const owned = listAccounts({ reseller: String(resellerId) });
  assert.equal(owned.total, 30);
  assert.ok(owned.list.every((row) => row.owner_id === resellerId));

  const expired = listAccounts({ estado: 'expired', tam: '100' });
  assert.equal(expired.total, 12);
  assert.ok(expired.list.every((row) => row.status === 'expired'));

  const flix = listAccounts({ servicio: 'totalflix', tam: '100' });
  assert.equal(flix.total, 20);
  assert.ok(flix.list.every((row) => row.player_kind === 'totalflix'));

  const pato = listAccounts({ dominio: 'pato', tam: '100' });
  assert.equal(pato.total, 8);
  assert.ok(pato.list.every((row) => row.maxplayer_domain_id === String(config.maxplayerDomainPatoId)));
});

test('el orden por cuenta cubre todas las del reseller y el enlace guarda los filtros', () => {
  const page = listAccounts({
    q: 'u',
    estado: 'active',
    servicio: 'emby',
    dominio: 'pato',
    reseller: String(resellerId),
    tam: '25',
    orden: 'cuenta',
    dir: 'desc',
    pagina: '1',
  }, { base: '/admin/cuentas' });
  const names = page.list.map((row) => row.username);
  const sorted = names.slice().sort((a, b) => b.localeCompare(a));
  assert.deepEqual(names, sorted);
  assert.ok(page.list.every((row) => row.owner_id === resellerId && row.status === 'active'));
  const link = page.href(2);
  for (const bit of ['q=u', 'estado=active', 'servicio=emby', 'dominio=pato', `reseller=${resellerId}`, 'tam=25', 'orden=cuenta', 'dir=desc', 'pagina=2']) {
    assert.ok(link.includes(bit), bit);
  }
  assert.match(link, /^\/admin\/cuentas\?/);
});

test('un reseller solo ve sus cuentas y no puede ordenar ni filtrar por otro', () => {
  const own = listAccounts(
    { reseller: String(adminId), orden: 'reseller', tam: '100' },
    { ownerId: resellerId, base: '/reseller/cuentas' }
  );
  assert.equal(own.total, 30);
  assert.equal(own.sort, 'vence');
  assert.equal(own.reseller, '');
  assert.ok(own.list.every((row) => row.owner_id === resellerId));
  assert.doesNotMatch(own.href(2), /reseller=/);
  assert.match(own.href(2), /^\/reseller\/cuentas\?/);
});

test('la primera página son activas aunque haya caducadas más antiguas', () => {
  const page = listAccounts({ tam: '25' });
  assert.equal(page.sort, 'activas');
  assert.equal(page.list[0].username, 'u01');
  assert.ok(page.list.every((row) => row.status === 'active'));
  assert.equal(page.href(2).includes('orden='), false);
});

test('el filtro de tipo separa prueba y normal', () => {
  db.prepare("UPDATE emby_accounts SET is_trial = 1 WHERE username IN ('u02', 'u04')").run();
  const trials = listAccounts({ tipo: 'prueba', tam: '100' });
  assert.equal(trials.total, 2);
  assert.ok(trials.list.every((row) => row.is_trial === 1));
  const normals = listAccounts({ tipo: 'normal', tam: '100' });
  assert.equal(normals.total, 58);
  assert.match(trials.href(1), /tipo=prueba/);
});

test('una cuenta solo XUI no marca Emby por tener la fecha vacía', () => {
  const soon = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  assert.deepEqual(dueServices({
    has_emby: 0,
    emby_user_id: null,
    emby_expires_at: null,
    emby_cut: 0,
    xui_line_id: '9',
    xui_expires_at: soon,
    is_trial: 1,
  }), ['XUI']);
  assert.deepEqual(dueServices({
    has_emby: 0,
    emby_user_id: null,
    emby_expires_at: null,
    xui_line_id: '9',
    xui_expires_at: '2027-01-08 13:04:14',
  }), []);
  assert.deepEqual(dueServices({
    emby_user_id: 'e1',
    emby_expires_at: soon,
    xui_line_id: '9',
    xui_expires_at: '2027-01-08 13:04:14',
  }), ['Emby']);
});

test('hay índices para el listado abierto', () => {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
  assert.ok(names.includes('idx_emby_accounts_open_expires'));
  assert.ok(names.includes('idx_emby_accounts_open_owner'));
  assert.ok(names.includes('idx_emby_accounts_status_expires'));
});
