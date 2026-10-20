// Registro de servidores Emby. La fuente es el .env (config.embyServers).
// La tabla emby_servers guarda nombre y URLs para la ficha; nunca la API key.

const config = require('../config');
const { createClient, EmbyError } = require('./emby');

const clients = new Map();

function list() {
  return (config.embyServers || []).slice();
}

function publicView(server) {
  if (!server) return null;
  return {
    key: server.key,
    name: server.name,
    publicUrl: server.publicUrl,
    internalUrl: server.url,
  };
}

function get(key) {
  const id = String(key || '1');
  return (config.embyServers || []).find((server) => server.key === id) || null;
}

function resolveKey(raw) {
  const id = String(raw || '').trim() || '1';
  const server = get(id);
  if (!server) {
    throw new Error(`No existe el servidor Emby "${id}".`);
  }
  return server.key;
}

function clientFor(key) {
  const id = String(key || '1');
  const server = get(id);
  if (!server) {
    throw new EmbyError(
      `El servidor Emby "${id}" no está configurado. Revisa el .env. No se ha modificado la cuenta.`,
      0
    );
  }
  if (!clients.has(server.key)) clients.set(server.key, createClient(server));
  return clients.get(server.key);
}

function publicList() {
  return list().map(publicView);
}

function publicByKey(key) {
  return (
    publicView(get(key || '1')) || {
      key: String(key || '1'),
      name: `Servidor ${key || '1'}`,
      publicUrl: '',
      internalUrl: '',
    }
  );
}

function syncTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS emby_servers (
      server_key   TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      public_url   TEXT NOT NULL,
      internal_url TEXT NOT NULL,
      is_active    INTEGER NOT NULL DEFAULT 1,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const upsert = db.prepare(`
    INSERT INTO emby_servers (server_key, name, public_url, internal_url, is_active, updated_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(server_key) DO UPDATE SET
      name = excluded.name,
      public_url = excluded.public_url,
      internal_url = excluded.internal_url,
      is_active = 1,
      updated_at = datetime('now')
  `);
  const keys = list().map((server) => server.key);
  const tx = db.transaction(() => {
    for (const server of list()) {
      upsert.run(server.key, server.name, server.publicUrl, server.url);
    }
    if (keys.length) {
      db.prepare(
        `UPDATE emby_servers SET is_active = 0 WHERE server_key NOT IN (${keys.map(() => '?').join(',')})`
      ).run(...keys);
    }
  });
  tx();
}

module.exports = {
  list,
  get,
  resolveKey,
  clientFor,
  publicList,
  publicByKey,
  syncTable,
};
