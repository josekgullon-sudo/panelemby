// Localiza cuentas importadas de XUI a las que se les inventó una caducidad
// de 30 días porque la línea no trae exp_date. Por defecto no escribe.
// Con aplicar=true deja la línea sin fecha (ilimitada) y no llama a XUI
// para cortarla ni para reactivarla.

const db = require('../db/database');

const THIRTY_MS = 30 * 24 * 3600 * 1000;
const TOLERANCE_MS = 2 * 60 * 1000;

function sqlToMs(text) {
  if (!text) return NaN;
  return Date.parse(String(text).replace(' ', 'T') + 'Z');
}

function isImportPlusThirty(createdAt, expiresAt) {
  const delta = sqlToMs(expiresAt) - sqlToMs(createdAt);
  return Number.isFinite(delta) && Math.abs(delta - THIRTY_MS) <= TOLERANCE_MS;
}

function expDateMissing(value) {
  if (value == null) return true;
  const text = String(value).trim();
  return text === '' || text === '0';
}

function readExpDate(payload) {
  const raw = Array.isArray(payload) ? payload[0] : payload;
  if (!raw || typeof raw !== 'object') return { ok: false };
  if (!Object.prototype.hasOwnProperty.call(raw, 'exp_date') && !Object.prototype.hasOwnProperty.call(raw, 'expdate')) {
    return { ok: false };
  }
  return { ok: true, value: raw.exp_date != null ? raw.exp_date : raw.expdate };
}

async function auditInventedExpiries({ dryRun = true, xui } = {}) {
  const X = xui || require('./xui');
  const rows = db
    .prepare(
      `SELECT * FROM emby_accounts
       WHERE status != 'deleted'
         AND xui_line_id IS NOT NULL
         AND notes = 'importado de XUI'
         AND (xui_expires_at IS NOT NULL OR expires_at IS NOT NULL)`
    )
    .all();
  const candidates = rows.filter(
    (row) => isImportPlusThirty(row.created_at, row.xui_expires_at) || isImportPlusThirty(row.created_at, row.expires_at)
  );
  const matches = [];
  const errors = [];
  for (const row of candidates) {
    let payload;
    try {
      payload = await X.getLine(row.xui_line_id);
    } catch (err) {
      errors.push({
        id: row.id,
        username: row.username,
        xui_line_id: String(row.xui_line_id),
        message: err && err.message ? err.message : String(err),
      });
      continue;
    }
    const exp = readExpDate(payload);
    if (!exp.ok) {
      errors.push({
        id: row.id,
        username: row.username,
        xui_line_id: String(row.xui_line_id),
        message: 'La línea no trae el campo exp_date',
      });
      continue;
    }
    if (!expDateMissing(exp.value)) continue;
    matches.push({
      id: row.id,
      username: row.username,
      xui_line_id: String(row.xui_line_id),
      created_at: row.created_at,
      expires_at: row.expires_at,
      xui_expires_at: row.xui_expires_at,
      status: row.status,
      xui_cut: row.xui_cut,
    });
    if (!dryRun) {
      const expiresAt = row.emby_user_id && row.emby_expires_at ? row.emby_expires_at : null;
      db.prepare('UPDATE emby_accounts SET xui_expires_at = NULL, expires_at = ? WHERE id = ?').run(expiresAt, row.id);
    }
  }
  return { dryRun: !!dryRun, checked: candidates.length, matches, errors };
}

function formatAuditReport(summary) {
  const lines = [];
  lines.push(summary.dryRun ? 'Simulación: no se ha cambiado ninguna cuenta.' : 'Cuentas pasadas a sin caducidad.');
  lines.push(`Candidatas (importación + 30 días): ${summary.checked}. Sin exp_date en XUI: ${summary.matches.length}. Errores: ${summary.errors.length}.`);
  for (const row of summary.matches) {
    lines.push(
      `${row.username} · línea ${row.xui_line_id} · creada ${row.created_at} · vence ${row.expires_at || '—'} · estado ${row.status}${row.xui_cut ? ' · XUI ya cortada' : ''}`
    );
  }
  for (const err of summary.errors) {
    lines.push(`Error ${err.username || err.xui_line_id}: ${err.message}`);
  }
  if (!summary.matches.length && !summary.errors.length) {
    lines.push('Ninguna cuenta importada coincide.');
  }
  return lines.join('\n');
}

module.exports = {
  isImportPlusThirty,
  expDateMissing,
  auditInventedExpiries,
  formatAuditReport,
};
