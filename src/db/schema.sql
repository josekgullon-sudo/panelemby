-- Esquema del panel. Se ejecuta en cada arranque: todo es IF NOT EXISTS.

-- Admin y resellers (los que hacen login "de gestión")
CREATE TABLE IF NOT EXISTS panel_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'reseller')),
    credits       INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Planes que define el admin
CREATE TABLE IF NOT EXISTS plans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    duration_days INTEGER NOT NULL CHECK (duration_days > 0),
    credit_cost   INTEGER NOT NULL CHECK (credit_cost >= 0),
    is_active     INTEGER NOT NULL DEFAULT 1
);

-- Clientes finales = cuentas de Emby gestionadas por el panel
CREATE TABLE IF NOT EXISTS emby_accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    emby_user_id  TEXT UNIQUE,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    owner_id      INTEGER NOT NULL REFERENCES panel_users(id),
    plan_id       INTEGER REFERENCES plans(id),
    expires_at    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'expired', 'deleted')),
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_emby_accounts_owner   ON emby_accounts(owner_id);
CREATE INDEX IF NOT EXISTS idx_emby_accounts_expires ON emby_accounts(expires_at, status);

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
