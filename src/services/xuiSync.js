// Importa todas las líneas de XUI al panel. Idempotente: no duplica y no cobra créditos.
// El paquete que devuelve XUI no es fiable (este panel lo ignora); no pisa el que ya tenemos.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
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

function ownerFor(memberId, adminId) {
  const want = String(memberId || '').trim();
  if (!want) return adminId;
  const resellers = db
    .prepare("SELECT id, xui_member_id FROM panel_users WHERE role = 'reseller' AND is_active = 1 AND xui_member_id IS NOT NULL")
    .all();
  const hit = resellers.find((row) => memberIds(row.xui_member_id).includes(want));
  return hit ? hit.id : adminId;
}

function when(line, parseExpToDate) {
  const date = parseExpToDate(line.exp_date);
  if (!date || Number.isNaN(date.getTime())) {
    return {
      expiresAt: toSqlDate(new Date(Date.now() + 30 * 24 * 3600 * 1000)),
      past: !line.enabled,
    };
  }
  return { expiresAt: toSqlDate(date), past: !line.enabled || date.getTime() < Date.now() };
}

async function syncXuiLines({ dryRun = false, xui, maxplayer } = {}) {
  const X = xui || require('./xui');
  const M = maxplayer || require('./maxplayer');
  const admin = db.prepare("SELECT id FROM panel_users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1").get();
  if (!admin) {
    const err = new Error('No hay admin en el panel');
    err.name = 'BusinessError';
    throw err;
  }
  const plan = db.prepare("SELECT id FROM plans WHERE name = 'Mensual · 1 pantalla'").get()
    || db.prepare('SELECT id FROM plans WHERE is_active = 1 ORDER BY duration_days LIMIT 1').get();
  if (!plan) {
    const err = new Error('No hay planes en el panel');
    err.name = 'BusinessError';
    throw err;
  }

  const lines = await X.getLines();
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
    indexError,
    dryRun,
  };

  for (const line of lines) {
    const byId = db
      .prepare("SELECT * FROM emby_accounts WHERE xui_line_id = ? AND status != 'deleted'")
      .get(line.id);
    const byName = byId
      ? null
      : db.prepare("SELECT * FROM emby_accounts WHERE username = ? COLLATE NOCASE AND status != 'deleted'").get(line.username);
    if (byName && byName.xui_line_id && String(byName.xui_line_id) !== String(line.id)) {
      summary.conflicts += 1;
      continue;
    }
    const row = byId || byName;
    let player = null;
    if (!indexError) {
      player = findPlayer(index, line.username);
    } else if (row && row.maxplayer_user_id) {
      player = { id: row.maxplayer_user_id, domainId: row.maxplayer_domain_id || '' };
    }
    const kind = player ? 'maxplayer' : 'totalflix';
    if (kind === 'maxplayer') summary.maxplayer += 1;
    else summary.totalflix += 1;
    const timing = when(line, X.parseExpToDate || (() => null));
    const status = timing.past ? 'expired' : 'active';
    const ownerId = ownerFor(line.member_id, admin.id);

    if (dryRun) {
      if (row) summary.updated += 1;
      else summary.created += 1;
      continue;
    }

    if (!row) {
      const password = line.password || crypto.randomBytes(12).toString('hex');
      db.prepare(
        `INSERT INTO emby_accounts (
           username, password_hash, password_enc, owner_id, plan_id, expires_at, status, notes,
           has_emby, xui_line_id, xui_package_id, player_kind, maxplayer_user_id, maxplayer_list_ok,
           maxplayer_domain_id, xui_expires_at, xui_cut
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'importado de XUI', 0, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        line.username,
        bcrypt.hashSync(password, 10),
        line.password ? secret.encrypt(line.password) : null,
        ownerId,
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
        timing.past ? 1 : 0
      );
      summary.created += 1;
      continue;
    }

    const packageId = row.xui_package_id || line.package_id || null;
    const keepKind = indexError && row.player_kind ? row.player_kind : kind;
    const mpId = indexError ? row.maxplayer_user_id : player ? player.id : null;
    const domainId = indexError ? row.maxplayer_domain_id : player && player.domainId ? player.domainId : null;
    const nextOwner = line.member_id && ownerId !== admin.id ? ownerId : row.owner_id;
    const nowSql = toSqlDate(new Date());
    const embyAlive = !!(row.emby_user_id && row.emby_expires_at && row.emby_expires_at > nowSql && !row.emby_cut);
    const nextStatus = timing.past && !embyAlive ? 'expired' : 'active';
    const expiresAt = embyAlive && row.emby_expires_at < timing.expiresAt ? row.emby_expires_at : timing.expiresAt;
    db.prepare(
      `UPDATE emby_accounts
       SET xui_line_id = ?, xui_expires_at = ?, expires_at = ?, status = ?,
           player_kind = ?, maxplayer_user_id = ?, maxplayer_domain_id = ?, maxplayer_list_ok = ?,
           xui_package_id = ?, xui_cut = ?, owner_id = ?,
           password_enc = COALESCE(password_enc, ?)
       WHERE id = ?`
    ).run(
      line.id,
      timing.expiresAt,
      expiresAt,
      nextStatus,
      keepKind,
      mpId,
      domainId,
      mpId ? 1 : 0,
      packageId,
      timing.past ? 1 : 0,
      nextOwner,
      line.password ? secret.encrypt(line.password) : null,
      row.id
    );
    summary.updated += 1;
  }

  return summary;
}

module.exports = { syncXuiLines, memberIds, normalizeMemberIds };
