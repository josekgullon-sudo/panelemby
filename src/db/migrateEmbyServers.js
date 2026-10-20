// Asigna al Servidor 1 las cuentas Emby que ya existían antes de poder
// elegir servidor. Idempotente: no pisa una clave ya guardada.

function ensureEmbyServerColumn(db) {
  const cols = db.prepare('PRAGMA table_info(emby_accounts)').all();
  if (!cols.some((col) => col.name === 'emby_server_key')) {
    db.exec('ALTER TABLE emby_accounts ADD COLUMN emby_server_key TEXT');
  }
}

function assignExistingEmbyAccounts(db) {
  ensureEmbyServerColumn(db);
  const cols = db.prepare('PRAGMA table_info(emby_accounts)').all();
  const hasEmby = cols.some((col) => col.name === 'has_emby');
  const where = hasEmby
    ? "(emby_server_key IS NULL OR emby_server_key = '') AND (has_emby = 1 OR emby_user_id IS NOT NULL)"
    : "(emby_server_key IS NULL OR emby_server_key = '')";
  return db.prepare(`UPDATE emby_accounts SET emby_server_key = '1' WHERE ${where}`).run().changes;
}

module.exports = {
  ensureEmbyServerColumn,
  assignExistingEmbyAccounts,
};
