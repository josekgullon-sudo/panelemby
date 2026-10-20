const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migraciones incrementales sobre BDs ya creadas.
// schema.sql usa IF NOT EXISTS, así que una instalación antigua no recibe
// columnas nuevas hasta estos ALTER.
function ensureColumn(table, name, alterSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === name)) db.exec(alterSql);
}

ensureColumn('plans', 'screens', 'ALTER TABLE plans ADD COLUMN screens INTEGER NOT NULL DEFAULT 1');

// Las cuentas borradas conservan la fila como historial pero liberan el nombre
// (sufijo #del + id). Normaliza las borradas antes de este cambio.
db.exec(
  "UPDATE emby_accounts SET username = username || '#del' || id WHERE status = 'deleted' AND username NOT LIKE '%#del%'"
);

// Contraseña cifrada reversible para poder reenviar los datos de conexión
ensureColumn('emby_accounts', 'password_enc', 'ALTER TABLE emby_accounts ADD COLUMN password_enc TEXT');

// XUI.one + Max Player. has_emby=1 en filas viejas: antes toda cuenta era Emby.
ensureColumn('emby_accounts', 'has_emby', 'ALTER TABLE emby_accounts ADD COLUMN has_emby INTEGER NOT NULL DEFAULT 1');
ensureColumn('emby_accounts', 'xui_line_id', 'ALTER TABLE emby_accounts ADD COLUMN xui_line_id TEXT');
ensureColumn('emby_accounts', 'xui_package_id', 'ALTER TABLE emby_accounts ADD COLUMN xui_package_id TEXT');
ensureColumn('emby_accounts', 'xui_package_name', 'ALTER TABLE emby_accounts ADD COLUMN xui_package_name TEXT');
ensureColumn('emby_accounts', 'xui_bouquets', 'ALTER TABLE emby_accounts ADD COLUMN xui_bouquets TEXT');
ensureColumn('emby_accounts', 'player_kind', 'ALTER TABLE emby_accounts ADD COLUMN player_kind TEXT');
ensureColumn('emby_accounts', 'maxplayer_user_id', 'ALTER TABLE emby_accounts ADD COLUMN maxplayer_user_id TEXT');
ensureColumn(
  'emby_accounts',
  'maxplayer_list_ok',
  'ALTER TABLE emby_accounts ADD COLUMN maxplayer_list_ok INTEGER NOT NULL DEFAULT 0'
);
ensureColumn('emby_accounts', 'provision_error', 'ALTER TABLE emby_accounts ADD COLUMN provision_error TEXT');
ensureColumn('emby_accounts', 'maxplayer_domain_id', 'ALTER TABLE emby_accounts ADD COLUMN maxplayer_domain_id TEXT');
ensureColumn('emby_accounts', 'hotplayer_mac', 'ALTER TABLE emby_accounts ADD COLUMN hotplayer_mac TEXT');
ensureColumn(
  'emby_accounts',
  'hotplayer_ok',
  'ALTER TABLE emby_accounts ADD COLUMN hotplayer_ok INTEGER NOT NULL DEFAULT 0'
);
ensureColumn('emby_accounts', 'emby_expires_at', 'ALTER TABLE emby_accounts ADD COLUMN emby_expires_at TEXT');
ensureColumn('emby_accounts', 'xui_expires_at', 'ALTER TABLE emby_accounts ADD COLUMN xui_expires_at TEXT');
ensureColumn('xui_packages', 'trial_duration_in', 'ALTER TABLE xui_packages ADD COLUMN trial_duration_in TEXT');
ensureColumn('xui_packages', 'official_duration_in', 'ALTER TABLE xui_packages ADD COLUMN official_duration_in TEXT');
ensureColumn('emby_accounts', 'emby_cut', 'ALTER TABLE emby_accounts ADD COLUMN emby_cut INTEGER NOT NULL DEFAULT 0');
ensureColumn('emby_accounts', 'xui_cut', 'ALTER TABLE emby_accounts ADD COLUMN xui_cut INTEGER NOT NULL DEFAULT 0');
ensureColumn('emby_accounts', 'is_trial', 'ALTER TABLE emby_accounts ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0');
ensureColumn('emby_accounts', 'screens', 'ALTER TABLE emby_accounts ADD COLUMN screens INTEGER');
ensureColumn('panel_users', 'xui_member_id', 'ALTER TABLE panel_users ADD COLUMN xui_member_id TEXT');
ensureColumn('emby_accounts', 'emby_server_key', 'ALTER TABLE emby_accounts ADD COLUMN emby_server_key TEXT');

// Una instalación antigua tiene expires_at NOT NULL. Las líneas XUI sin fecha
// se guardan con NULL (sin caducidad), así que hay que poder dejarlo vacío.
function relaxExpiresNotNull() {
  const cols = db.prepare('PRAGMA table_info(emby_accounts)').all();
  const expires = cols.find((col) => col.name === 'expires_at');
  if (!expires || !expires.notnull) return;
  const names = cols.map((col) => col.name);
  const kept = [
    'id', 'emby_user_id', 'username', 'password_hash', 'password_enc', 'owner_id', 'plan_id',
    'expires_at', 'status', 'notes', 'created_at', 'has_emby', 'xui_line_id', 'xui_package_id',
    'xui_package_name', 'xui_bouquets', 'player_kind', 'maxplayer_user_id', 'maxplayer_list_ok',
    'maxplayer_domain_id', 'hotplayer_mac', 'hotplayer_ok', 'provision_error', 'emby_expires_at',
    'xui_expires_at', 'emby_cut', 'xui_cut', 'is_trial', 'screens', 'emby_server_key',
  ];
  const extra = names.filter((name) => !kept.includes(name));
  if (extra.length) {
    throw new Error(`No se puede dejar expires_at vacío: columnas sin copiar (${extra.join(', ')})`);
  }
  const list = names.join(', ');
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE emby_accounts_new (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          emby_user_id        TEXT UNIQUE,
          username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash       TEXT NOT NULL,
          password_enc        TEXT,
          owner_id            INTEGER NOT NULL REFERENCES panel_users(id),
          plan_id             INTEGER REFERENCES plans(id),
          expires_at          TEXT,
          status              TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'expired', 'deleted')),
          notes               TEXT,
          created_at          TEXT NOT NULL DEFAULT (datetime('now')),
          has_emby            INTEGER NOT NULL DEFAULT 1,
          xui_line_id         TEXT,
          xui_package_id      TEXT,
          xui_package_name    TEXT,
          xui_bouquets        TEXT,
          player_kind         TEXT,
          maxplayer_user_id   TEXT,
          maxplayer_list_ok   INTEGER NOT NULL DEFAULT 0,
          maxplayer_domain_id TEXT,
          hotplayer_mac       TEXT,
          hotplayer_ok        INTEGER NOT NULL DEFAULT 0,
          provision_error     TEXT,
          emby_expires_at     TEXT,
          xui_expires_at      TEXT,
          emby_cut            INTEGER NOT NULL DEFAULT 0,
          xui_cut             INTEGER NOT NULL DEFAULT 0,
          is_trial            INTEGER NOT NULL DEFAULT 0,
          screens             INTEGER,
          emby_server_key     TEXT
        );
        INSERT INTO emby_accounts_new (${list}) SELECT ${list} FROM emby_accounts;
        DROP TABLE emby_accounts;
        ALTER TABLE emby_accounts_new RENAME TO emby_accounts;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

relaxExpiresNotNull();

db.exec(`
  UPDATE emby_accounts SET emby_expires_at = expires_at
   WHERE emby_expires_at IS NULL AND expires_at IS NOT NULL AND (has_emby = 1 OR emby_user_id IS NOT NULL);
  -- xui_expires_at vacío es una línea sin caducidad. No se copia expires_at.
  UPDATE emby_accounts SET emby_cut = 1
   WHERE status = 'expired' AND emby_user_id IS NOT NULL AND emby_cut = 0;
  UPDATE emby_accounts SET xui_cut = 1
   WHERE status = 'expired' AND xui_line_id IS NOT NULL AND xui_cut = 0;
  UPDATE emby_accounts SET is_trial = 1
   WHERE is_trial = 0 AND xui_package_id IN (SELECT id FROM xui_packages WHERE is_trial = 1);
`);
ensureColumn('plans', 'xui_credit_cost', 'ALTER TABLE plans ADD COLUMN xui_credit_cost INTEGER NOT NULL DEFAULT 0');
ensureColumn(
  'plans',
  'maxplayer_credit_cost',
  'ALTER TABLE plans ADD COLUMN maxplayer_credit_cost INTEGER NOT NULL DEFAULT 0'
);

// Índices de los ids externos: después de los ALTER, porque en una BD antigua
// las columnas aún no existían cuando se ejecutó schema.sql.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_emby_accounts_xui_line
    ON emby_accounts(xui_line_id) WHERE xui_line_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_emby_accounts_mp_user
    ON emby_accounts(maxplayer_user_id) WHERE maxplayer_user_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_panel_users_xui_member
    ON panel_users(xui_member_id) WHERE xui_member_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_emby_accounts_owner ON emby_accounts(owner_id);
  CREATE INDEX IF NOT EXISTS idx_emby_accounts_expires ON emby_accounts(expires_at, status);
  CREATE INDEX IF NOT EXISTS idx_emby_accounts_open_expires
    ON emby_accounts(expires_at, id) WHERE status != 'deleted';
  CREATE INDEX IF NOT EXISTS idx_emby_accounts_open_owner
    ON emby_accounts(owner_id, expires_at, id) WHERE status != 'deleted';
  CREATE INDEX IF NOT EXISTS idx_emby_accounts_open_created
    ON emby_accounts(created_at, id) WHERE status != 'deleted';
  CREATE INDEX IF NOT EXISTS idx_emby_accounts_status_expires
    ON emby_accounts(status, expires_at, id);
  CREATE INDEX IF NOT EXISTS idx_emby_accounts_open_kind
    ON emby_accounts(player_kind, expires_at) WHERE status != 'deleted' AND player_kind IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_emby_accounts_open_domain
    ON emby_accounts(maxplayer_domain_id, expires_at) WHERE status != 'deleted' AND maxplayer_domain_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_emby_accounts_hot_mac
    ON emby_accounts(hotplayer_mac) WHERE hotplayer_mac IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_emby_accounts_emby_server
    ON emby_accounts(emby_server_key) WHERE emby_server_key IS NOT NULL;
`);

const { assignExistingEmbyAccounts } = require('./migrateEmbyServers');
assignExistingEmbyAccounts(db);
require('../services/embyServers').syncTable(db);

// El plan demo del catálogo inicial pasó de 24 horas a 6. Solo se toca si sigue
// exactamente con los valores originales del seed (no pisa cambios manuales).
db.exec(
  "UPDATE plans SET name = 'Demo 6 horas', duration_days = 0.25 WHERE name = 'Demo 24 horas' AND duration_days = 1 AND credit_cost = 0"
);

// Catálogo inicial de planes (solo si la tabla está vacía)
if (db.prepare('SELECT COUNT(*) AS n FROM plans').get().n === 0) {
  const seed = db.prepare('INSERT INTO plans (name, duration_days, credit_cost, screens) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    seed.run('Demo 6 horas', 0.25, 0, 1);
    seed.run('Mensual · 1 pantalla', 30, 1, 1);
    seed.run('Mensual · 2 pantallas', 30, 2, 2);
    seed.run('Trimestral · 1 pantalla', 90, 3, 1);
    seed.run('Trimestral · 2 pantallas', 90, 6, 2);
    seed.run('Semestral · 1 pantalla', 180, 6, 1);
    seed.run('Semestral · 2 pantallas', 180, 12, 2);
    seed.run('Anual · 1 pantalla', 365, 12, 1);
    seed.run('Anual · 2 pantallas', 365, 24, 2);
  })();
}

module.exports = db;
