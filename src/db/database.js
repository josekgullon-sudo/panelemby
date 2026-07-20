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

// Migraciones incrementales sobre BDs ya creadas
const planCols = db.prepare('PRAGMA table_info(plans)').all();
if (!planCols.some((c) => c.name === 'screens')) {
  db.exec('ALTER TABLE plans ADD COLUMN screens INTEGER NOT NULL DEFAULT 1');
}

// Catálogo inicial de planes (solo si la tabla está vacía)
if (db.prepare('SELECT COUNT(*) AS n FROM plans').get().n === 0) {
  const seed = db.prepare('INSERT INTO plans (name, duration_days, credit_cost, screens) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    seed.run('Demo 24 horas', 1, 0, 1);
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
