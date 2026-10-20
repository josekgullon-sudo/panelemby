// Simula una BD creada antes de XUI/Max Player y comprueba que el arranque
// añade las columnas sin tocar las filas que ya había.
const fs = require('fs');
const Database = require('better-sqlite3');

process.env.DB_PATH = '';
require('./env');

const dbPath = process.env.DB_PATH;
fs.rmSync(dbPath, { force: true });

const old = new Database(dbPath);
old.exec(`
  CREATE TABLE panel_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    duration_days INTEGER NOT NULL,
    credit_cost INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE emby_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emby_user_id TEXT UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    plan_id INTEGER,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO panel_users (username, password_hash, role, credits) VALUES ('admin', 'x', 'admin', 0);
  INSERT INTO plans (name, duration_days, credit_cost) VALUES ('Mensual', 30, 1);
  INSERT INTO emby_accounts (emby_user_id, username, password_hash, owner_id, plan_id, expires_at, status)
  VALUES ('emby-old', 'cliente', 'hash', 1, 1, '2030-01-01 00:00:00', 'active');
`);
old.close();

const db = require('../src/db/database');
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('la migración añade ids externos y costes sin perder la cuenta vieja', () => {
  const accountCols = db.prepare('PRAGMA table_info(emby_accounts)').all().map((c) => c.name);
  for (const name of [
    'password_enc',
    'has_emby',
    'xui_line_id',
    'xui_package_id',
    'xui_package_name',
    'xui_bouquets',
    'player_kind',
    'maxplayer_user_id',
    'maxplayer_list_ok',
    'provision_error',
    'maxplayer_domain_id',
    'hotplayer_mac',
    'hotplayer_ok',
    'emby_expires_at',
    'xui_expires_at',
    'emby_server_key',
  ]) {
    assert.ok(accountCols.includes(name), name);
  }
  const account = db.prepare('SELECT * FROM emby_accounts WHERE username = ?').get('cliente');
  assert.equal(account.emby_user_id, 'emby-old');
  assert.equal(account.has_emby, 1);
  assert.equal(account.emby_server_key, '1');
  assert.equal(account.xui_line_id, null);
  assert.equal(account.maxplayer_user_id, null);

  const planCols = db.prepare('PRAGMA table_info(plans)').all().map((c) => c.name);
  assert.ok(planCols.includes('screens'));
  assert.ok(planCols.includes('xui_credit_cost'));
  assert.ok(planCols.includes('maxplayer_credit_cost'));
  const plan = db.prepare('SELECT * FROM plans WHERE name = ?').get('Mensual');
  assert.equal(plan.credit_cost, 1);
  assert.equal(plan.xui_credit_cost, 0);
  assert.equal(plan.maxplayer_credit_cost, 0);
  assert.equal(plan.screens, 1);

  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'xui_packages'").get());

  const expires = db.prepare('PRAGMA table_info(emby_accounts)').all().find((col) => col.name === 'expires_at');
  assert.equal(expires.notnull, 0);
  db.prepare(
    "INSERT INTO emby_accounts (username, password_hash, owner_id, plan_id, expires_at, status) VALUES ('sinfecha', 'h', 1, 1, NULL, 'active')"
  ).run();
  assert.equal(db.prepare("SELECT expires_at FROM emby_accounts WHERE username = 'sinfecha'").get().expires_at, null);
});
