// Relee get_line de cada cuenta importada y corrige is_trial y la caducidad.
// Una exp_date vacía es ilimitada. Por defecto no escribe.
// Concurrencia 4 y los mismos reintentos de lectura que la importación.

const db = require('../db/database');
const { trialFlag } = require('./xui');
const { expDateMissing } = require('./unlimitedAudit');

function nextExpiry(row) {
  return row.emby_user_id && row.emby_expires_at ? row.emby_expires_at : null;
}

async function runPool(items, concurrency, worker) {
  const width = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  async function pull() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: width }, () => pull()));
}

async function backfillImportedLines({ dryRun = true, concurrency = 4, fetchLine } = {}) {
  const read = fetchLine || require('./xui').fetchLine;
  const rows = db
    .prepare(
      `SELECT * FROM emby_accounts
       WHERE status != 'deleted'
         AND xui_line_id IS NOT NULL
         AND notes = 'importado de XUI'
       ORDER BY id`
    )
    .all();
  const summary = {
    dryRun: !!dryRun,
    checked: rows.length,
    trials: 0,
    trialChanges: 0,
    unlimited: 0,
    expiryChanges: 0,
    unchanged: 0,
    errors: [],
  };
  const update = db.prepare(
    `UPDATE emby_accounts
     SET is_trial = ?,
         xui_expires_at = CASE WHEN ? = 1 THEN NULL ELSE xui_expires_at END,
         expires_at = CASE WHEN ? = 1 THEN ? ELSE expires_at END
     WHERE id = ?`
  );

  await runPool(rows, concurrency, async (row) => {
    let line;
    try {
      line = await read(row.xui_line_id);
    } catch (err) {
      summary.errors.push({
        id: row.id,
        username: row.username,
        xui_line_id: String(row.xui_line_id),
        message: err && err.message ? err.message : String(err),
      });
      return;
    }
    const trial = trialFlag(line && line.is_trial) ? 1 : 0;
    const unlimited = expDateMissing(line && line.exp_date);
    const kept = nextExpiry(row);
    const trialChange = trial !== (row.is_trial ? 1 : 0);
    const expiryChange = unlimited && (row.xui_expires_at != null || row.expires_at !== kept);
    if (trial) summary.trials += 1;
    if (unlimited) summary.unlimited += 1;
    if (trialChange) summary.trialChanges += 1;
    if (expiryChange) summary.expiryChanges += 1;
    if (!trialChange && !expiryChange) summary.unchanged += 1;
    if (!dryRun) {
      update.run(trial, unlimited ? 1 : 0, unlimited ? 1 : 0, kept, row.id);
    }
  });

  return summary;
}

function formatBackfillReport(summary) {
  const lines = [];
  lines.push(summary.dryRun ? 'Simulación: no se ha escrito nada.' : 'Cuentas actualizadas.');
  lines.push(`Cuentas leídas: ${summary.checked}. Errores: ${summary.errors.length}.`);
  lines.push(`Pruebas en XUI: ${summary.trials}. El panel cambiaría is_trial en ${summary.trialChanges}.`);
  lines.push(`Sin caducidad en XUI: ${summary.unlimited}. El panel quitaría la fecha en ${summary.expiryChanges}.`);
  lines.push(`Sin cambios: ${summary.unchanged}.`);
  for (const err of summary.errors.slice(0, 8)) {
    lines.push(`Error ${err.username || err.xui_line_id}: ${err.message}`);
  }
  if (summary.errors.length > 8) lines.push(`… y ${summary.errors.length - 8} errores más.`);
  return lines.join('\n');
}

module.exports = { backfillImportedLines, formatBackfillReport };
