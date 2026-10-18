-- Esquema del panel. Se ejecuta en cada arranque: todo es IF NOT EXISTS.

-- Admin y resellers (los que hacen login "de gestión")
CREATE TABLE IF NOT EXISTS panel_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'reseller')),
    credits       INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    xui_member_id TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Planes que define el admin
CREATE TABLE IF NOT EXISTS plans (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    name                   TEXT NOT NULL UNIQUE,
    duration_days          INTEGER NOT NULL CHECK (duration_days > 0),
    credit_cost            INTEGER NOT NULL CHECK (credit_cost >= 0),
    is_active              INTEGER NOT NULL DEFAULT 1,
    screens                INTEGER NOT NULL DEFAULT 1,
    xui_credit_cost        INTEGER NOT NULL DEFAULT 0,
    maxplayer_credit_cost  INTEGER NOT NULL DEFAULT 0
);

-- Clientes finales. El nombre de la tabla se mantiene por las instalaciones
-- ya creadas; una fila puede existir en Emby, en XUI y/o en Max Player.
CREATE TABLE IF NOT EXISTS emby_accounts (
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
    screens             INTEGER
);

-- Catálogo XUI cacheado (get_packages). credit_cost NULL = usar el del plan.
CREATE TABLE IF NOT EXISTS xui_packages (
    id                TEXT PRIMARY KEY,
    package_name      TEXT NOT NULL,
    is_trial          INTEGER NOT NULL DEFAULT 0,
    is_official       INTEGER NOT NULL DEFAULT 0,
    trial_duration    INTEGER,
    trial_duration_in TEXT,
    official_duration INTEGER,
    official_duration_in TEXT,
    max_connections   INTEGER,
    bouquets          TEXT,
    credit_cost       INTEGER,
    is_listed         INTEGER NOT NULL DEFAULT 1,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_emby_accounts_owner   ON emby_accounts(owner_id);
CREATE INDEX IF NOT EXISTS idx_emby_accounts_expires ON emby_accounts(expires_at, status);
-- Listado paginado: el filtro habitual es «no borradas» y el orden, la caducidad.
CREATE INDEX IF NOT EXISTS idx_emby_accounts_open_expires
  ON emby_accounts(expires_at, id) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_emby_accounts_open_owner
  ON emby_accounts(owner_id, expires_at, id) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_emby_accounts_open_created
  ON emby_accounts(created_at, id) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_emby_accounts_status_expires
  ON emby_accounts(status, expires_at, id);

-- Libro mayor de créditos: cada movimiento queda registrado, nunca se edita
CREATE TABLE IF NOT EXISTS credit_transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id   INTEGER NOT NULL REFERENCES panel_users(id),
    amount        INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason        TEXT NOT NULL CHECK (reason IN ('recharge', 'create_account', 'renew', 'adjustment')),
    account_id    INTEGER REFERENCES emby_accounts(id),
    performed_by  INTEGER NOT NULL REFERENCES panel_users(id),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_tx_reseller ON credit_transactions(reseller_id, created_at);
