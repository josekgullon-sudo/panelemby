// Importa todas las líneas de XUI al panel. Idempotente: no duplica y no cobra créditos.
// El paquete que devuelve XUI no es fiable (este panel lo ignora); no pisa el que ya tenemos.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const config = require('../config');
const secret = require('./secret');
const { toSqlDate } = require('./accounts');

function namesOf(user) {
  const names = new Set();
  if (user && user.username) names.add(String(user.username).trim().toLowerCase());
  for (const list of (user && user.lists) || []) {
    const info = list.iptv_info || {};
    const iptv = info.username || info.user || info.iptv_username || list.iptv_username;
    if (iptv) names.add(String(iptv).trim().toLowerCase());
  }
  return names;
}

function domainOf(user) {
  for (const list of (user && user.lists) || []) {
    if (list.domain_id) return String(list.domain_id);
  }
  return '';
}

async function indexPlayers(maxplayer) {
  const map = new Map();
  if (!maxplayer || !maxplayer.listAllUsers) return map;
  const users = await maxplayer.listAllUsers();
  for (const user of users) {
    const id = String(user.id || user.user_id || '');
    if (!id) continue;
    const entry = { id, domainId: domainOf(user) };
    for (const name of namesOf(user)) {
      if (!map.has(name)) map.set(name, entry);
    }
  }
  return map;
}

function findPlayer(index, username) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return null;
  return index.get(key) || null;
}

function memberIds(value) {
  return [...new Set(String(value || '').split(/[,;\s]+/).map((part) => part.trim()).filter(Boolean))];
}

function normalizeMemberIds(text) {
  const ids = memberIds(text);
  if (ids.some((id) => !/^\d+$/.test(id))) {
    const err = new Error('Los member_id de XUI son números separados por comas');
    err.name = 'BusinessError';
    throw err;
  }
  return ids;
}

function importDomain(domainId) {
  const value = domainId == null ? '' : String(domainId).trim();
  if (!value) return 'sin dominio';
  if (value === String(config.maxplayerDomainPatoId)) return 'PATO';
  if (value === String(config.maxplayerDomainCisneId)) return 'CISNE';
  return 'otro servidor';
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function writtenStatus(row, timing) {
  if (!row) return timing.past ? 'expired' : 'active';
  const nowSql = toSqlDate(new Date());
  const embyAlive = !!(row.emby_user_id && row.emby_expires_at && row.emby_expires_at > nowSql && !row.emby_cut);
  return timing.past && !embyAlive ? 'expired' : 'active';
}

function trialBit(line) {
  const value = line && line.is_trial;
  if (value === true || value === 1) return 1;
  if (typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim())) return 1;
  return 0;
}

function when(line, parseExpToDate) {
  // Sin exp_date la línea es ilimitada. No se inventa una caducidad de 30 días.
  let date = null;
  try {
    date = typeof parseExpToDate === 'function' ? parseExpToDate(line.exp_date) : null;
  } catch {
    date = null;
  }
  if (!date || Number.isNaN(date.getTime())) {
    return { expiresAt: null, past: !line.enabled };
  }
  return { expiresAt: toSqlDate(date), past: !line.enabled || date.getTime() < Date.now() };
}

function mergedExpiry(embyAt, xuiAt) {
  const dates = [embyAt, xuiAt].filter(Boolean);
  if (!dates.length) return null;
  const nowSql = toSqlDate(new Date());
  const future = dates.filter((value) => value > nowSql);
  const pool = future.length ? future : dates;
  return pool.slice().sort()[future.length ? 0 : pool.length - 1];
}

function formatSyncReport(summary) {
  const owners = Object.keys(summary.owners || {}).sort((a, b) => a.localeCompare(b, 'es'));
  const domains = Object.keys(summary.domains || {}).sort((a, b) => a.localeCompare(b, 'es'));
  const errors = summary.errors || [];
  const lines = [];
  lines.push(summary.dryRun ? 'Simulación (no se ha escrito nada).' : 'Sincronización hecha.');
  lines.push(
    `Líneas en XUI: ${summary.lines}. Nuevas: ${summary.created}. Actualizadas: ${summary.updated}. Conflictos: ${summary.conflicts}. Errores: ${errors.length}.`
  );
  lines.push(`Max Player: ${summary.maxplayer}. TotalFlix: ${summary.totalflix}.`);
  lines.push(`Activas: ${summary.active || 0}. Caducadas: ${summary.expired || 0}.`);
  lines.push(`Dominios: ${domains.length ? domains.map((key) => `${key}: ${summary.domains[key]}`).join(', ') : 'ninguno'}.`);
  lines.push(`Dueños: ${owners.length ? owners.map((key) => `${key}: ${summary.owners[key]}`).join(', ') : 'ninguno'}.`);
  if (summary.indexError) {
    lines.push(`Aviso Max Player: ${summary.indexError}.`);
    lines.push('Las líneas se importan igual. El tipo de app no se ha cambiado en las que ya existían.');
  }
  for (const err of errors.slice(0, 8)) {
    lines.push(`Error ${err.username || err.id}: ${err.message}`);
  }
  if (errors.length > 8) lines.push(`… y ${errors.length - 8} errores más.`);
  return lines.join('\n');
}

async function syncXuiLines({ dryRun = false, xui, maxplayer, onProgress } = {}) {
  const X = xui || require('./xui');
  const M = maxplayer || require('./maxplayer');
  const report = async (info) => {
    if (typeof onProgress === 'function') await onProgress(info);
  };
  const people = db
    .prepare("SELECT id, username, role, xui_member_id FROM panel_users WHERE is_active = 1 ORDER BY id")
    .all();
  const admin = people.find((row) => row.role === 'admin');
  if (!admin) {
    const err = new Error('No hay admin en el panel');
    err.name = 'BusinessError';
    throw err;
  }
  const byId = new Map(people.map((row) => [row.id, row]));
  const plan = db.prepare("SELECT id FROM plans WHERE name = 'Mensual · 1 pantalla'").get()
    || db.prepare('SELECT id FROM plans WHERE is_active = 1 ORDER BY duration_days LIMIT 1').get();
  if (!plan) {
    const err = new Error('No hay planes en el panel');
    err.name = 'BusinessError';
    throw err;
  }

  function resolveOwner(memberId) {
    const want = String(memberId || '').trim();
    if (!want) return admin;
    const hit = people.find((row) => row.role === 'reseller' && memberIds(row.xui_member_id).includes(want));
    return hit || admin;
  }

  await report({ phase: 'xui', scannedId: 0, found: 0 });
  const lines = await X.getLines({
    onProgress: (info) => report({ phase: 'xui', scannedId: info.scannedId, found: info.found }),
  });
  await report({ phase: 'maxplayer', scannedId: 0, found: lines.length });
  let index = new Map();
  let indexError = null;
  try {
    index = await indexPlayers(M);
  } catch (err) {
    indexError = err.message;
  }

  const summary = {
    lines: lines.length,
    created: 0,
    updated: 0,
    conflicts: 0,
    maxplayer: 0,
    totalflix: 0,
    active: 0,
    expired: 0,
    owners: {},
    domains: {},
    errors: [],
    indexError,
    dryRun,
  };

  await report({ phase: 'saving', scannedId: 0, found: lines.length });

  for (const line of lines) {
    try {
      const byIdRow = db
        .prepare("SELECT * FROM emby_accounts WHERE xui_line_id = ? AND status != 'deleted'")
        .get(line.id);
      const byName = byIdRow
        ? null
        : db.prepare("SELECT * FROM emby_accounts WHERE username = ? COLLATE NOCASE AND status != 'deleted'").get(line.username);
      if (byName && byName.xui_line_id && String(byName.xui_line_id) !== String(line.id)) {
        summary.conflicts += 1;
        continue;
      }
      const row = byIdRow || byName;
      let player = null;
      if (!indexError) {
        player = findPlayer(index, line.username);
      } else if (row && row.maxplayer_user_id) {
        player = { id: row.maxplayer_user_id, domainId: row.maxplayer_domain_id || '' };
      }
      const kind = player ? 'maxplayer' : 'totalflix';
      const storedKind = row && indexError && row.player_kind ? row.player_kind : kind;
      const timing = when(line, X.parseExpToDate || (() => null));
      const status = writtenStatus(row, timing);
      const mapped = resolveOwner(line.member_id);
      const owner = !row || (line.member_id && mapped.id !== admin.id) ? mapped : (byId.get(row.owner_id) || { id: row.owner_id, username: 'admin' });
      const domain = row && indexError ? importDomain(row.maxplayer_domain_id) : importDomain(player && player.domainId);

      if (!dryRun && !row) {
        const password = line.password || crypto.randomBytes(12).toString('hex');
        db.prepare(
          `INSERT INTO emby_accounts (
             username, password_hash, password_enc, owner_id, plan_id, expires_at, status, notes,
             has_emby, xui_line_id, xui_package_id, player_kind, maxplayer_user_id, maxplayer_list_ok,
             maxplayer_domain_id, xui_expires_at, xui_cut, is_trial
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'importado de XUI', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          line.username,
          bcrypt.hashSync(password, 10),
          line.password ? secret.encrypt(line.password) : null,
          owner.id,
          plan.id,
          timing.expiresAt,
          status,
          line.id,
          line.package_id || null,
          kind,
          player ? player.id : null,
          player ? 1 : 0,
          player && player.domainId ? player.domainId : null,
          timing.expiresAt,
          timing.past ? 1 : 0,
          trialBit(line)
        );
      } else if (!dryRun) {
        const packageId = row.xui_package_id || line.package_id || null;
        const keepKind = storedKind;
        const mpId = indexError ? row.maxplayer_user_id : player ? player.id : null;
        const domainId = indexError ? row.maxplayer_domain_id : player && player.domainId ? player.domainId : null;
        const embyAt = row.emby_user_id ? row.emby_expires_at : null;
        const expiresAt = mergedExpiry(embyAt, timing.expiresAt);
        db.prepare(
          `UPDATE emby_accounts
           SET xui_line_id = ?, xui_expires_at = ?, expires_at = ?, status = ?,
               player_kind = ?, maxplayer_user_id = ?, maxplayer_domain_id = ?, maxplayer_list_ok = ?,
               xui_package_id = ?, xui_cut = ?, owner_id = ?, is_trial = ?,
               password_enc = COALESCE(password_enc, ?)
           WHERE id = ?`
        ).run(
          line.id,
          timing.expiresAt,
          expiresAt,
          status,
          keepKind,
          mpId,
          domainId,
          mpId ? 1 : 0,
          packageId,
          timing.past ? 1 : 0,
          owner.id,
          trialBit(line),
          line.password ? secret.encrypt(line.password) : null,
          row.id
        );
      }

      if (storedKind === 'maxplayer') summary.maxplayer += 1;
      else summary.totalflix += 1;
      if (status === 'expired') summary.expired += 1;
      else summary.active += 1;
      bump(summary.owners, owner.username || 'admin');
      bump(summary.domains, domain);
      if (row) summary.updated += 1;
      else summary.created += 1;
    } catch (err) {
      summary.errors.push({
        id: line && line.id != null ? String(line.id) : '',
        username: line && line.username ? String(line.username) : '',
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  return summary;
}

let syncRunner = null;

function setSyncRunner(fn) {
  syncRunner = typeof fn === 'function' ? fn : null;
}

function emptyJob() {
  return {
    running: false,
    phase: 'idle',
    scannedId: 0,
    found: 0,
    dryRun: false,
    error: null,
    summary: null,
    startedAt: null,
    finishedAt: null,
  };
}

let job = emptyJob();

function jobSnapshot() {
  return {
    running: job.running,
    phase: job.phase,
    scannedId: job.scannedId,
    found: job.found,
    dryRun: job.dryRun,
    error: job.error,
    summary: job.summary,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    text: job.summary ? formatSyncReport(job.summary) : (job.error || ''),
  };
}

function startSyncInBackground({ dryRun = false } = {}) {
  if (job.running) return { started: false };
  job = {
    running: true,
    phase: 'xui',
    scannedId: 0,
    found: 0,
    dryRun: !!dryRun,
    error: null,
    summary: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const runner = syncRunner || syncXuiLines;
  Promise.resolve()
    .then(() => runner({
      dryRun: !!dryRun,
      onProgress(info) {
        if (!job.running) return;
        if (info && info.phase) job.phase = info.phase;
        if (info && info.scannedId != null) job.scannedId = info.scannedId;
        if (info && info.found != null) job.found = info.found;
      },
    }))
    .then((summary) => {
      job.running = false;
      job.phase = 'done';
      job.summary = summary || null;
      job.finishedAt = new Date().toISOString();
      if (summary && summary.lines != null) job.found = summary.lines;
    })
    .catch((err) => {
      job.running = false;
      job.phase = 'error';
      job.error = err && err.message ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
    });
  return { started: true };
}

module.exports = {
  syncXuiLines,
  memberIds,
  normalizeMemberIds,
  formatSyncReport,
  startSyncInBackground,
  jobSnapshot,
  setSyncRunner,
};
