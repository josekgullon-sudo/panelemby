// Lista líneas creadas en el panel que aquí son de pago y en XUI están
// como prueba. Solo lee get_line. No edita la línea ni escribe en la base.

const db = require('../db/database');
const { trialFlag } = require('./xui');

async function runPool(items, concurrency, worker) {
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  let cursor = 0;
  async function pull() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  }
  if (!items.length) return;
  await Promise.all(Array.from({ length: width }, () => pull()));
}

function panelPaidLines() {
  return db
    .prepare(
      `SELECT a.id, a.username, a.xui_line_id, a.xui_package_name, p.username AS owner
       FROM emby_accounts a
       JOIN panel_users p ON p.id = a.owner_id
       WHERE a.status != 'deleted'
         AND a.xui_line_id IS NOT NULL
         AND a.is_trial = 0
         AND IFNULL(a.notes, '') != 'importado de XUI'
       ORDER BY a.id`
    )
    .all();
}

async function listPaidLinesFlaggedTrial({ concurrency = 4, fetchLine } = {}) {
  const read = fetchLine || require('./xui').fetchLine;
  const rows = panelPaidLines();
  const summary = { checked: rows.length, flagged: [], errors: [] };
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
    if (!trialFlag(line && line.is_trial)) return;
    summary.flagged.push({
      id: row.id,
      username: row.username,
      xui_line_id: String(row.xui_line_id),
      owner: row.owner,
      packageName: row.xui_package_name || '',
    });
  });
  return summary;
}

function formatTrialAudit(summary) {
  const lines = [
    'Solo lectura: no se ha modificado nada en XUI ni en el panel.',
    `Cuentas de pago creadas en el panel: ${summary.checked}. En XUI como prueba: ${summary.flagged.length}. Errores de lectura: ${summary.errors.length}.`,
  ];
  for (const row of summary.flagged) {
    const pack = row.packageName ? ` · ${row.packageName}` : '';
    lines.push(`${row.username} · línea ${row.xui_line_id} · ${row.owner}${pack}`);
  }
  for (const err of summary.errors) {
    lines.push(`Error ${err.username || err.xui_line_id}: ${err.message}`);
  }
  return lines.join('\n');
}

module.exports = { listPaidLinesFlaggedTrial, formatTrialAudit, panelPaidLines };
