const fs = require('fs');
const Database = require('better-sqlite3');

const config = require('../config');

// Lectura del SQLite del bot de ventas (systemd telegram-ai).
// Se abre en solo lectura y, si el fichero no existe, no se crea.
// El primer nombre de cada lista que exista en la base es el que se usa:
// si el bot nombra una columna distinto, cámbialo aquí.

const TIME_ZONE = 'Europe/Madrid';
const BOT_TEXT_LIMIT = 500;
const THREAD_LIMIT = 2000;
const IN_CHUNK = 300;

const TABLE_CANDIDATES = {
  customers: ['customers'],
  messages: ['messages'],
  payments: ['payments'],
  trials: ['trials'],
  // follow_ups va el último: si en el bot es un recordatorio comercial y no
  // soporte, quítalo de esta lista. Si hay tabla de escalados, esa gana.
  escalations: ['escalations', 'escalation', 'support_tickets', 'handoffs', 'follow_ups', 'followups'],
};

const COLUMN_CANDIDATES = {
  customers: {
    id: ['id'],
    chatId: ['chat_id', 'telegram_chat_id', 'tg_chat_id'],
    username: ['username', 'telegram_username', 'tg_username', 'user_name'],
    name: ['name', 'full_name', 'display_name', 'first_name'],
    lastName: ['last_name', 'lastname'],
    xuiUsername: ['xui_username', 'line_username', 'iptv_username', 'xtream_username', 'panel_username'],
    createdAt: ['created_at', 'created', 'joined_at', 'first_seen_at'],
  },
  messages: {
    id: ['id'],
    chatId: ['chat_id', 'telegram_chat_id', 'tg_chat_id'],
    customerId: ['customer_id'],
    role: ['role', 'sender', 'author', 'direction', 'kind'],
    text: ['text', 'content', 'body', 'message'],
    createdAt: ['created_at', 'sent_at', 'ts', 'timestamp', 'created', 'at'],
    responder: ['responder', 'admin_username', 'operator', 'answered_by'],
    isBot: ['is_bot', 'from_bot'],
  },
  payments: {
    id: ['id'],
    chatId: ['chat_id', 'telegram_chat_id', 'tg_chat_id'],
    customerId: ['customer_id'],
    // Importe en céntimos. amount_cents gana si convive con amount.
    amountCents: ['amount_cents', 'amount', 'amount_total', 'unit_amount'],
    status: ['status', 'payment_status', 'state'],
    createdAt: ['created_at', 'created', 'inserted_at'],
    paidAt: ['paid_at', 'completed_at', 'paid_on'],
    xuiUsername: ['xui_username', 'line_username'],
  },
  trials: {
    id: ['id'],
    chatId: ['chat_id', 'telegram_chat_id', 'tg_chat_id'],
    customerId: ['customer_id'],
    username: ['username', 'xui_username', 'line_username'],
    createdAt: ['created_at', 'created', 'started_at'],
  },
  escalations: {
    id: ['id'],
    chatId: ['chat_id', 'telegram_chat_id', 'tg_chat_id'],
    customerId: ['customer_id'],
    status: ['status', 'state'],
    createdAt: ['created_at', 'created', 'opened_at'],
  },
};

const PAID_STATUS = new Set(['complete', 'completed', 'paid', 'succeeded', 'success', 'paid_out']);
const PENDING_STATUS = new Set(['pending', 'open', 'unpaid', 'created', 'incomplete', 'requires_payment']);
const CLOSED_ESC = new Set(['closed', 'resolved', 'done', 'complete', 'completed', 'cancelled', 'canceled', 'sent', 'scheduled']);
const FOLLOW_OPEN = new Set(['open', 'escalated', 'human', 'support', 'waiting', 'activo', 'abierta']);

const ADMIN_ROLES = new Set(['admin', 'owner', 'operator', 'support', 'agent', 'human_agent', 'staff', 'reseller', 'responder']);
const BOT_ROLES = new Set(['assistant', 'bot', 'ai', 'model', 'out', 'outgoing', 'outbound', 'system', 'tool', 'function']);
const CUSTOMER_ROLES = new Set(['user', 'customer', 'human', 'client', 'cliente', 'in', 'incoming', 'inbound']);

const connections = new Map();

function isIdent(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function q(name) {
  if (!isIdent(name)) throw new Error('Identificador SQL no permitido');
  return `"${name}"`;
}

function maskMessageText(value) {
  if (value == null) return '';
  let text = String(value);
  text = text.replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/g, '***');
  text = text.replace(/\bwhsec_[A-Za-z0-9]+/g, '***');
  text = text.replace(
    /\b(contrase(?:ñ|n)a|password|pass|clave)\b\s*[:=]\s*\S+/gi,
    (_, label) => `${label}: ***`
  );
  text = text.replace(
    /\b(contrase(?:ñ|n)a|password|pass|clave)\b\s+(?:es|is)\s+\S+/gi,
    (_, label) => `${label}: ***`
  );
  return text;
}

function partsAt(utcMs) {
  const bag = {};
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  for (const part of formatted) bag[part.type] = part.value;
  let hour = Number(bag.hour);
  if (bag.dayPeriod) {
    const pm = /pm/i.test(bag.dayPeriod);
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function offsetMs(utcMs) {
  const got = partsAt(utcMs);
  const asUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
  return asUtc - utcMs;
}

function wallToUtc(year, month, day, hour, minute, second) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = desired;
  for (let i = 0; i < 4; i += 1) utc = desired - offsetMs(utc);
  return utc;
}

function madridDayBounds(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  const startMs = wallToUtc(y, m, d, 0, 0, 0);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const endMs = wallToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0);
  return { startMs, endMs };
}

function todayMadrid(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const bag = {};
  for (const part of parts) bag[part.type] = part.value;
  return `${bag.year}-${bag.month}-${bag.day}`;
}

function parseFecha(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return text;
}

function shiftFecha(fecha, days) {
  const [y, m, d] = fecha.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${month}-${day}`;
}

function formatTime(date) {
  if (!date || Number.isNaN(date.getTime())) return '—';
  const bag = {};
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  for (const part of formatted) bag[part.type] = part.value;
  return `${bag.hour}:${bag.minute}`;
}

function formatDayLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

function madridDateKey(date) {
  const bag = {};
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  for (const part of formatted) bag[part.type] = part.value;
  return `${bag.year}-${bag.month}-${bag.day}`;
}

function formatEur(cents) {
  const value = (Number(cents) || 0) / 100;
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value);
}

function normalizeExclude(list) {
  const ids = new Set();
  const names = new Set();
  for (const raw of list || []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    if (/^-?\d+$/.test(text)) ids.add(text);
    else names.add(text.replace(/^@/, '').toLowerCase());
  }
  return { ids, names };
}

function isExcluded(chatId, username, exclude) {
  if (chatId != null && chatId !== '' && exclude.ids.has(String(chatId))) return true;
  const name = String(username || '').replace(/^@/, '').toLowerCase();
  return Boolean(name) && exclude.names.has(name);
}

function isChatKey(value) {
  return /^(?:c:)?-?\d{1,20}$/.test(String(value || ''));
}

function normId(value) {
  if (value == null || value === '') return '';
  const text = String(value).trim();
  if (/^-?\d+\.0+$/.test(text)) return String(parseInt(text, 10));
  return text;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function emptySummary() {
  return {
    conversations: 0,
    newCustomers: null,
    trials: null,
    sales: null,
    salesCents: 0,
    salesLabel: '—',
    pendingPayments: null,
    openEscalations: null,
  };
}

function unavailable(fecha, notice, excludeConfigured) {
  return {
    available: false,
    notice,
    fecha,
    hiddenTests: 0,
    excludeConfigured,
    gapNote: null,
    summary: emptySummary(),
    conversations: [],
  };
}

function openReadOnly(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1500 });
  db.pragma('busy_timeout = 1500');
  db.pragma('query_only = ON');
  return db;
}

function closeBot(dbPath) {
  const db = connections.get(dbPath);
  if (!db) return;
  connections.delete(dbPath);
  try {
    db.close();
  } catch (_) {
    // La conexión ya estaba cerrada.
  }
}

function noticeForOpenError(err, dbPath) {
  const code = err && (err.code || err.name || '');
  const message = err && err.message ? err.message : '';
  if (code === 'SQLITE_CANTOPEN' || /EACCES|permission|unable to open/i.test(message)) {
    return `No se puede leer la base del bot de Telegram en solo lectura (${dbPath}). Revisa la ruta y los permisos del fichero.`;
  }
  return 'No se pudo leer la base del bot de Telegram. El panel sigue funcionando.';
}

function connect(dbPath) {
  const cached = connections.get(dbPath);
  if (cached) {
    try {
      cached.prepare('SELECT 1').get();
      return { ok: true, db: cached };
    } catch (_) {
      closeBot(dbPath);
    }
  }
  if (!fs.existsSync(dbPath)) {
    return {
      ok: false,
      notice: `No se encuentra la base del bot de Telegram (${dbPath}). Cuando el fichero exista, las conversaciones aparecerán aquí.`,
    };
  }
  try {
    const db = openReadOnly(dbPath);
    connections.set(dbPath, db);
    return { ok: true, db };
  } catch (err) {
    return { ok: false, notice: noticeForOpenError(err, dbPath) };
  }
}

function findTable(db, candidates) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const byLower = new Map(rows.map((row) => [String(row.name).toLowerCase(), row.name]));
  for (const cand of candidates) {
    const found = byLower.get(cand.toLowerCase());
    if (found && isIdent(found)) return found;
  }
  return null;
}

function columnSet(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${q(table)})`).all();
  const byLower = new Map();
  for (const row of rows) {
    if (isIdent(row.name)) byLower.set(String(row.name).toLowerCase(), row.name);
  }
  return byLower;
}

function pickColumn(columns, candidates) {
  if (!columns || !candidates) return null;
  for (const cand of candidates) {
    const found = columns.get(cand.toLowerCase());
    if (found) return found;
  }
  return null;
}

function resolveTable(db, key) {
  const table = findTable(db, TABLE_CANDIDATES[key]);
  if (!table) return null;
  const columns = columnSet(db, table);
  const picked = { table, columns };
  for (const [field, candidates] of Object.entries(COLUMN_CANDIDATES[key])) {
    picked[field] = pickColumn(columns, candidates);
  }
  return picked;
}

function detectTimeKind(db, table, column) {
  if (!table || !column) return null;
  const row = db.prepare(
    `SELECT typeof(${q(column)}) AS t, ${q(column)} AS v FROM ${q(table)} WHERE ${q(column)} IS NOT NULL AND CAST(${q(column)} AS TEXT) != '' LIMIT 1`
  ).get();
  if (!row || row.v == null || row.v === '') return null;
  const text = String(row.v).trim();
  if (row.t === 'integer' || row.t === 'real' || /^-?\d+(\.\d+)?$/.test(text)) {
    return Math.abs(Number(text)) > 1e12 ? 'unix_ms' : 'unix_s';
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) return 'iso';
  if (text.includes('T')) return 'iso_naive';
  return 'text_utc';
}

function boundsFor(kind, startMs, endMs) {
  if (kind === 'unix_ms') return [startMs, endMs];
  if (kind === 'unix_s') return [Math.floor(startMs / 1000), Math.floor(endMs / 1000)];
  if (kind === 'iso') return [new Date(startMs).toISOString(), new Date(endMs).toISOString()];
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  if (kind === 'iso_naive') {
    return [new Date(startMs).toISOString().slice(0, 19), new Date(endMs).toISOString().slice(0, 19)];
  }
  return [fmt(startMs), fmt(endMs)];
}

function toDate(value, kind) {
  if (value == null || value === '') return null;
  if (kind === 'unix_ms') return new Date(Number(value));
  if (kind === 'unix_s') return new Date(Number(value) * 1000);
  const text = String(value).trim();
  if (!text) return null;
  if (kind === 'iso' || /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) return new Date(text);
  const iso = text.includes('T') ? text : text.replace(' ', 'T');
  return new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
}

function inRange(value, kind, startMs, endMs) {
  const date = toDate(value, kind);
  if (!date || Number.isNaN(date.getTime())) return false;
  const ms = date.getTime();
  return ms >= startMs && ms < endMs;
}

function selectAlias(column, alias) {
  if (!column) return `NULL AS ${alias}`;
  return `${q(column)} AS ${alias}`;
}

function escalationCounts(status, tableName) {
  const value = String(status ?? '').trim().toLowerCase();
  if (/follow/i.test(tableName || '')) return FOLLOW_OPEN.has(value);
  if (!value) return true;
  return !CLOSED_ESC.has(value);
}

function classifyRole(roleRaw, responder, isBotFlag) {
  if (responder) return 'admin';
  const flag = String(isBotFlag ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return 'bot';
  const role = String(roleRaw || '').trim().toLowerCase();
  if (ADMIN_ROLES.has(role)) return 'admin';
  if (BOT_ROLES.has(role)) return 'bot';
  if (CUSTOMER_ROLES.has(role)) return 'customer';
  if (role === 'system') return 'bot';
  return 'customer';
}

function bubbleWho(kind, roleRaw, responder) {
  if (kind === 'admin') return responder ? `Admin · ${responder}` : 'Admin';
  const role = String(roleRaw || '').trim().toLowerCase();
  if (kind === 'bot' && (role === 'system' || role === 'tool' || role === 'function')) return 'Sistema';
  if (kind === 'bot') return 'Bot';
  return 'Cliente';
}

function responderName(value) {
  if (value == null) return '';
  const text = maskMessageText(String(value).trim());
  if (!text || text === '0' || text === 'false' || text === 'null') return '';
  return text.slice(0, 40);
}

function gapNote(summary) {
  const bits = [];
  if (summary.newCustomers == null) bits.push('clientes nuevos');
  if (summary.trials == null) bits.push('pruebas');
  if (summary.sales == null) bits.push('ventas');
  if (summary.openEscalations == null) bits.push('escalados');
  if (!bits.length) return null;
  return `No hay tabla para ${bits.join(', ')}. Esas cifras salen como —.`;
}

function outcomeOf(bucket) {
  if (bucket.salesCount > 0) return 'venta';
  if (bucket.trialCount > 0) return 'prueba';
  if (bucket.pending > 0) return 'pago_pendiente';
  if (bucket.escalationCount > 0) return 'escalado';
  return 'sin_resultado';
}

function presentOutcome(outcome, bucket) {
  if (outcome === 'venta') {
    const bits = [formatEur(bucket.salesCents)];
    if (bucket.xui) bits.push(bucket.xui);
    return { outcome, outcomeLabel: 'Venta', outcomeDetail: bits.join(' · '), badgeClass: 'badge badge-ok badge-wrap' };
  }
  if (outcome === 'prueba') {
    return {
      outcome,
      outcomeLabel: 'Prueba',
      outcomeDetail: bucket.trialUser || '',
      badgeClass: 'badge svc-max badge-wrap',
    };
  }
  if (outcome === 'pago_pendiente') {
    return { outcome, outcomeLabel: 'Pago pendiente', outcomeDetail: '', badgeClass: 'badge badge-warn badge-wrap' };
  }
  if (outcome === 'escalado') {
    return { outcome, outcomeLabel: 'Escalado', outcomeDetail: '', badgeClass: 'badge badge-err badge-wrap' };
  }
  return { outcome, outcomeLabel: 'Sin resultado', outcomeDetail: '', badgeClass: 'badge badge-muted badge-wrap' };
}

function loadCustomers(db, spec, chatIds, customerIds) {
  const byChat = new Map();
  const byId = new Map();
  if (!spec) return { byChat, byId };
  const sqlCols = [
    selectAlias(spec.id, 'id'),
    selectAlias(spec.chatId, 'chat_id'),
    selectAlias(spec.username, 'username'),
    selectAlias(spec.name, 'name'),
    selectAlias(spec.lastName, 'last_name'),
    selectAlias(spec.xuiUsername, 'xui_username'),
  ].join(', ');

  function remember(row) {
    const item = {
      id: normId(row.id),
      chatId: normId(row.chat_id),
      username: row.username ? String(row.username).replace(/^@/, '') : '',
      name: [row.name, row.last_name].filter((part) => part != null && String(part).trim() !== '').join(' ').trim(),
      xui: row.xui_username ? maskMessageText(String(row.xui_username)).slice(0, 64) : '',
    };
    if (item.id) byId.set(item.id, item);
    if (item.chatId) byChat.set(item.chatId, item);
  }

  if (spec.chatId) {
    for (const chunk of chunks([...new Set(chatIds.filter(Boolean))], IN_CHUNK)) {
      const marks = chunk.map(() => '?').join(', ');
      const rows = db.prepare(
        `SELECT ${sqlCols} FROM ${q(spec.table)} WHERE CAST(${q(spec.chatId)} AS TEXT) IN (${marks})`
      ).all(...chunk);
      rows.forEach(remember);
    }
  }
  if (spec.id) {
    for (const chunk of chunks([...new Set(customerIds.filter(Boolean))], IN_CHUNK)) {
      const marks = chunk.map(() => '?').join(', ');
      const rows = db.prepare(
        `SELECT ${sqlCols} FROM ${q(spec.table)} WHERE CAST(${q(spec.id)} AS TEXT) IN (${marks})`
      ).all(...chunk);
      rows.forEach(remember);
    }
  }
  return { byChat, byId };
}

function canonicalKey(chatId, customerId, byId) {
  const chat = normId(chatId);
  if (chat) return chat;
  const customer = normId(customerId);
  if (!customer) return '';
  const known = byId.get(customer);
  if (known && known.chatId) return known.chatId;
  return `c:${customer}`;
}

function queryRange(db, spec, startMs, endMs, extraCols) {
  if (!spec || (!spec.createdAt && !spec.paidAt)) return [];
  const pieces = [];
  const params = [];
  const timeCols = [];
  if (spec.createdAt) timeCols.push({ column: spec.createdAt, kind: detectTimeKind(db, spec.table, spec.createdAt), alias: 'created_at' });
  if (spec.paidAt && spec.paidAt !== spec.createdAt) {
    timeCols.push({ column: spec.paidAt, kind: detectTimeKind(db, spec.table, spec.paidAt), alias: 'paid_at' });
  }
  const usable = timeCols.filter((col) => col.kind);
  if (!usable.length) return [];
  for (const col of usable) {
    const [from, to] = boundsFor(col.kind, startMs, endMs);
    pieces.push(`(${q(col.column)} >= ? AND ${q(col.column)} < ?)`);
    params.push(from, to);
  }
  const select = [
    selectAlias(spec.chatId, 'chat_id'),
    selectAlias(spec.customerId, 'customer_id'),
    ...extraCols,
    selectAlias(spec.createdAt, 'created_at'),
    selectAlias(spec.paidAt, 'paid_at'),
  ].join(', ');
  return db.prepare(
    `SELECT ${select} FROM ${q(spec.table)} WHERE ${pieces.join(' OR ')}`
  ).all(...params).map((row) => ({ row, createdKind: usable.find((col) => col.alias === 'created_at')?.kind || usable[0].kind, paidKind: usable.find((col) => col.alias === 'paid_at')?.kind || null }));
}

function collectActivity(db, schema, fecha, startMs, endMs) {
  const messages = schema.messages;
  const msgKind = detectTimeKind(db, messages.table, messages.createdAt);
  let messageGroups = [];
  if (msgKind && messages.createdAt && (messages.chatId || messages.customerId)) {
    const [from, to] = boundsFor(msgKind, startMs, endMs);
    const chatExpr = messages.chatId ? `CAST(${q(messages.chatId)} AS TEXT)` : 'NULL';
    const custExpr = messages.customerId ? `CAST(${q(messages.customerId)} AS TEXT)` : 'NULL';
    messageGroups = db.prepare(
      `SELECT ${chatExpr} AS chat_id, ${custExpr} AS customer_id, COUNT(*) AS n,
              MIN(${q(messages.createdAt)}) AS first_at, MAX(${q(messages.createdAt)}) AS last_at
       FROM ${q(messages.table)}
       WHERE ${q(messages.createdAt)} >= ? AND ${q(messages.createdAt)} < ?
       GROUP BY ${chatExpr}, ${custExpr}`
    ).all(from, to);
  }

  const paymentSpec = schema.payments;
  const payments = paymentSpec
    ? queryRange(db, paymentSpec, startMs, endMs, [
      selectAlias(paymentSpec.amountCents, 'amount_cents'),
      selectAlias(paymentSpec.status, 'status'),
      selectAlias(paymentSpec.xuiUsername, 'xui_username'),
    ])
    : [];

  const trialSpec = schema.trials;
  const trials = trialSpec
    ? queryRange(db, trialSpec, startMs, endMs, [selectAlias(trialSpec.username, 'username')])
    : [];

  const escSpec = schema.escalations;
  const escalations = escSpec
    ? queryRange(db, escSpec, startMs, endMs, [selectAlias(escSpec.status, 'status')])
    : [];

  let newCustomerRows = [];
  let customerKind = null;
  if (schema.customers && schema.customers.createdAt) {
    customerKind = detectTimeKind(db, schema.customers.table, schema.customers.createdAt);
    if (customerKind) {
      const [from, to] = boundsFor(customerKind, startMs, endMs);
      const cols = [
        selectAlias(schema.customers.id, 'id'),
        selectAlias(schema.customers.chatId, 'chat_id'),
        selectAlias(schema.customers.username, 'username'),
        selectAlias(schema.customers.name, 'name'),
        selectAlias(schema.customers.lastName, 'last_name'),
        selectAlias(schema.customers.xuiUsername, 'xui_username'),
        selectAlias(schema.customers.createdAt, 'created_at'),
      ].join(', ');
      newCustomerRows = db.prepare(
        `SELECT ${cols} FROM ${q(schema.customers.table)} WHERE ${q(schema.customers.createdAt)} >= ? AND ${q(schema.customers.createdAt)} < ?`
      ).all(from, to);
    }
  }

  return { msgKind, messageGroups, payments, trials, escalations, newCustomerRows, customerKind };
}

function buildDay(db, fecha, options) {
  const schema = {
    customers: resolveTable(db, 'customers'),
    messages: resolveTable(db, 'messages'),
    payments: resolveTable(db, 'payments'),
    trials: resolveTable(db, 'trials'),
    escalations: resolveTable(db, 'escalations'),
  };
  const exclude = normalizeExclude(options.exclude ?? config.telegramBotExcludeChatIds);
  const hideTests = options.hideTests !== false;
  const excludeConfigured = exclude.ids.size > 0 || exclude.names.size > 0;

  if (!schema.messages || !schema.messages.createdAt || (!schema.messages.chatId && !schema.messages.customerId)) {
    return unavailable(
      fecha,
      'La base del bot se abrió, pero no está la tabla de mensajes (messages) con fecha y chat. El mapeo de columnas está al inicio del servicio de conversaciones.',
      excludeConfigured
    );
  }

  const { startMs, endMs } = madridDayBounds(fecha);
  const activity = collectActivity(db, schema, fecha, startMs, endMs);

  const chatIds = [];
  const customerIds = [];
  function takeIds(chatId, customerId) {
    const chat = normId(chatId);
    const customer = normId(customerId);
    if (chat) chatIds.push(chat);
    if (customer) customerIds.push(customer);
  }
  for (const row of activity.messageGroups) takeIds(row.chat_id, row.customer_id);
  for (const item of activity.payments) takeIds(item.row.chat_id, item.row.customer_id);
  for (const item of activity.trials) takeIds(item.row.chat_id, item.row.customer_id);
  for (const item of activity.escalations) takeIds(item.row.chat_id, item.row.customer_id);
  for (const row of activity.newCustomerRows) takeIds(row.chat_id, row.id);

  const customers = loadCustomers(db, schema.customers, chatIds, customerIds);

  function customerFor(key) {
    if (customers.byChat.has(key)) return customers.byChat.get(key);
    if (key.startsWith('c:')) return customers.byId.get(key.slice(2)) || null;
    return null;
  }

  const buckets = new Map();
  function bucketFor(key) {
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        messages: 0,
        firstMs: null,
        lastMs: null,
        salesCount: 0,
        salesCents: 0,
        pending: 0,
        trialCount: 0,
        trialUser: '',
        escalationCount: 0,
        xui: '',
      });
    }
    return buckets.get(key);
  }
  function touch(bucket, ms) {
    if (ms == null || Number.isNaN(ms)) return;
    if (bucket.firstMs == null || ms < bucket.firstMs) bucket.firstMs = ms;
    if (bucket.lastMs == null || ms > bucket.lastMs) bucket.lastMs = ms;
  }

  for (const row of activity.messageGroups) {
    const key = canonicalKey(row.chat_id, row.customer_id, customers.byId);
    if (!key) continue;
    const bucket = bucketFor(key);
    bucket.messages += Number(row.n) || 0;
    const first = toDate(row.first_at, activity.msgKind);
    const last = toDate(row.last_at, activity.msgKind);
    if (first) touch(bucket, first.getTime());
    if (last) touch(bucket, last.getTime());
  }

  for (const item of activity.payments) {
    const key = canonicalKey(item.row.chat_id, item.row.customer_id, customers.byId);
    if (!key) continue;
    const status = String(item.row.status ?? '').trim().toLowerCase();
    const paidValue = item.row.paid_at != null && item.row.paid_at !== '' ? item.row.paid_at : item.row.created_at;
    const paidKind = item.row.paid_at != null && item.row.paid_at !== '' && item.paidKind ? item.paidKind : item.createdKind;
    const createdOk = inRange(item.row.created_at, item.createdKind, startMs, endMs);
    const paidOk = inRange(paidValue, paidKind, startMs, endMs);
    const hasStatus = schema.payments.status != null;
    const isPaid = hasStatus ? PAID_STATUS.has(status) : paidOk;
    const isPending = hasStatus ? PENDING_STATUS.has(status) : false;
    if (isPaid && paidOk) {
      const bucket = bucketFor(key);
      const cents = Math.round(Number(item.row.amount_cents) || 0);
      bucket.salesCount += 1;
      if (cents > 0) bucket.salesCents += cents;
      const line = item.row.xui_username ? maskMessageText(String(item.row.xui_username)).slice(0, 64) : '';
      if (line) bucket.xui = line;
      touch(bucket, toDate(paidValue, paidKind)?.getTime());
    } else if (isPending && createdOk) {
      const bucket = bucketFor(key);
      bucket.pending += 1;
      touch(bucket, toDate(item.row.created_at, item.createdKind)?.getTime());
    }
  }

  for (const item of activity.trials) {
    if (!inRange(item.row.created_at, item.createdKind, startMs, endMs)) continue;
    const key = canonicalKey(item.row.chat_id, item.row.customer_id, customers.byId);
    if (!key) continue;
    const bucket = bucketFor(key);
    bucket.trialCount += 1;
    if (!bucket.trialUser && item.row.username) bucket.trialUser = maskMessageText(String(item.row.username)).slice(0, 64);
    touch(bucket, toDate(item.row.created_at, item.createdKind)?.getTime());
  }

  for (const item of activity.escalations) {
    if (!inRange(item.row.created_at, item.createdKind, startMs, endMs)) continue;
    if (!escalationCounts(item.row.status, schema.escalations.table)) continue;
    const key = canonicalKey(item.row.chat_id, item.row.customer_id, customers.byId);
    if (!key) continue;
    const bucket = bucketFor(key);
    bucket.escalationCount += 1;
    touch(bucket, toDate(item.row.created_at, item.createdKind)?.getTime());
  }

  let newCustomers = schema.customers && schema.customers.createdAt ? 0 : null;
  if (newCustomers === 0) {
    for (const row of activity.newCustomerRows) {
      if (!inRange(row.created_at, activity.customerKind, startMs, endMs)) continue;
      const key = canonicalKey(row.chat_id, row.id, customers.byId);
      const customer = customerFor(key) || {
        chatId: normId(row.chat_id),
        username: row.username ? String(row.username).replace(/^@/, '') : '',
      };
      if (hideTests && isExcluded(customer.chatId || key, customer.username, exclude)) continue;
      newCustomers += 1;
    }
  }

  let hiddenTests = 0;
  const conversations = [];
  let sales = schema.payments ? 0 : null;
  let salesCents = 0;
  let pendingPayments = schema.payments ? 0 : null;
  let trials = schema.trials ? 0 : null;
  let openEscalations = schema.escalations ? 0 : null;

  for (const bucket of buckets.values()) {
    const customer = customerFor(bucket.key);
    const username = customer ? customer.username : '';
    const chatId = customer && customer.chatId ? customer.chatId : (bucket.key.startsWith('c:') ? '' : bucket.key);
    const test = isExcluded(chatId || bucket.key, username, exclude);
    if (test && hideTests) {
      hiddenTests += 1;
      continue;
    }
    if (customer && customer.xui) bucket.xui = bucket.xui || customer.xui;
    const outcome = presentOutcome(outcomeOf(bucket), bucket);
    const first = bucket.firstMs == null ? null : new Date(bucket.firstMs);
    const last = bucket.lastMs == null ? null : new Date(bucket.lastMs);
    const firstLabel = formatTime(first);
    const lastLabel = formatTime(last);
    const name = maskMessageText(customer && customer.name ? customer.name : '').trim();
    conversations.push({
      chatId: bucket.key,
      name: name || (username ? `@${username}` : `Chat ${bucket.key}`),
      username,
      usernameLabel: username ? `@${username}` : '',
      messageCount: bucket.messages,
      firstLabel,
      lastLabel,
      when: !first ? '—' : firstLabel === lastLabel ? firstLabel : `${firstLabel} – ${lastLabel}`,
      lastMs: bucket.lastMs || 0,
      isTest: test,
      xuiUsername: bucket.xui,
      ...outcome,
    });
    if (sales != null) sales += bucket.salesCount;
    salesCents += bucket.salesCents;
    if (pendingPayments != null) pendingPayments += bucket.pending;
    if (trials != null) trials += bucket.trialCount;
    if (openEscalations != null) openEscalations += bucket.escalationCount;
  }

  conversations.sort((a, b) => b.lastMs - a.lastMs || b.messageCount - a.messageCount);

  const summary = {
    conversations: conversations.length,
    newCustomers,
    trials,
    sales,
    salesCents,
    salesLabel: sales == null ? '—' : formatEur(salesCents),
    pendingPayments,
    openEscalations,
  };

  return {
    available: true,
    notice: null,
    fecha,
    hiddenTests,
    excludeConfigured,
    gapNote: gapNote(summary),
    summary,
    conversations,
  };
}

function readDay(fecha, options = {}) {
  const dbPath = options.dbPath || config.telegramBotDbPath;
  const excludeConfigured = normalizeExclude(options.exclude ?? config.telegramBotExcludeChatIds);
  const opened = connect(dbPath);
  if (!opened.ok) {
    return unavailable(fecha, opened.notice, excludeConfigured.ids.size > 0 || excludeConfigured.names.size > 0);
  }
  try {
    return buildDay(opened.db, fecha, options);
  } catch (err) {
    console.error('[conversaciones] no se pudo leer el día:', err.message);
    closeBot(dbPath);
    return unavailable(fecha, 'No se pudo leer la base del bot de Telegram. El panel sigue funcionando.', false);
  }
}

function getDay(fecha, options = {}) {
  const parsed = parseFecha(fecha) || todayMadrid();
  return readDay(parsed, options);
}

function loadThreadMessages(db, schema, chatKey) {
  const messages = schema.messages;
  const kind = detectTimeKind(db, messages.table, messages.createdAt);
  if (!kind) return { kind: null, rows: [], total: 0 };
  const params = [];
  let where = '0';
  if (chatKey.startsWith('c:')) {
    if (!messages.customerId) return { kind, rows: [], total: 0 };
    where = `CAST(${q(messages.customerId)} AS TEXT) = ?`;
    params.push(chatKey.slice(2));
  } else if (messages.chatId && messages.customerId && schema.customers && schema.customers.id && schema.customers.chatId) {
    where = `CAST(${q(messages.chatId)} AS TEXT) = ? OR CAST(${q(messages.customerId)} AS TEXT) IN (SELECT CAST(${q(schema.customers.id)} AS TEXT) FROM ${q(schema.customers.table)} WHERE CAST(${q(schema.customers.chatId)} AS TEXT) = ?)`;
    params.push(chatKey, chatKey);
  } else if (messages.chatId) {
    where = `CAST(${q(messages.chatId)} AS TEXT) = ?`;
    params.push(chatKey);
  } else if (messages.customerId) {
    where = `CAST(${q(messages.customerId)} AS TEXT) = ?`;
    params.push(chatKey);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${q(messages.table)} WHERE ${where}`).get(...params).n;
  const cols = [
    selectAlias(messages.id, 'id'),
    selectAlias(messages.role, 'role'),
    selectAlias(messages.text, 'text'),
    selectAlias(messages.createdAt, 'created_at'),
    selectAlias(messages.responder, 'responder'),
    selectAlias(messages.isBot, 'is_bot'),
  ].join(', ');
  const orderId = messages.id ? `, ${q(messages.id)} DESC` : '';
  const orderIdAsc = messages.id ? `, id ASC` : '';
  const rows = db.prepare(
    `SELECT * FROM (
       SELECT ${cols}
       FROM ${q(messages.table)}
       WHERE ${where}
       ORDER BY ${q(messages.createdAt)} DESC${orderId}
       LIMIT ${THREAD_LIMIT}
     ) ORDER BY created_at ASC${orderIdAsc}`
  ).all(...params);
  return { kind, rows, total };
}

function getThread(chatKey, options = {}) {
  const key = String(chatKey || '');
  const fecha = parseFecha(options.fecha) || todayMadrid();
  if (!isChatKey(key)) return null;
  const day = readDay(fecha, { ...options, hideTests: false });
  if (!day.available) return day;

  const dbPath = options.dbPath || config.telegramBotDbPath;
  const opened = connect(dbPath);
  if (!opened.ok) return unavailable(fecha, opened.notice, day.excludeConfigured);
  try {
    const schema = {
      customers: resolveTable(opened.db, 'customers'),
      messages: resolveTable(opened.db, 'messages'),
    };
    if (!schema.messages) return unavailable(fecha, day.notice, day.excludeConfigured);
    const loaded = loadThreadMessages(opened.db, schema, key);
    const row = day.conversations.find((item) => item.chatId === key) || null;
    const customers = loadCustomers(
      opened.db,
      schema.customers,
      key.startsWith('c:') ? [] : [key],
      key.startsWith('c:') ? [key.slice(2)] : []
    );
    const customer = key.startsWith('c:') ? customers.byId.get(key.slice(2)) : customers.byChat.get(key);
    if (!row && loaded.total === 0 && !customer) return null;

    const exclude = normalizeExclude(options.exclude ?? config.telegramBotExcludeChatIds);
    const username = customer ? customer.username : row ? row.username : '';
    const isTest = isExcluded(customer && customer.chatId ? customer.chatId : key, username, exclude);
    const outcome = row
      ? {
        outcome: row.outcome,
        outcomeLabel: row.outcomeLabel,
        outcomeDetail: row.outcomeDetail,
        badgeClass: row.badgeClass,
        xuiUsername: row.xuiUsername,
      }
      : presentOutcome('sin_resultado', {});

    const messages = loaded.rows.map((item) => {
      const responder = responderName(item.responder);
      const kind = classifyRole(item.role, responder, item.is_bot);
      const date = toDate(item.created_at, loaded.kind);
      const raw = item.text == null ? '' : String(item.text);
      const dateKey = date && !Number.isNaN(date.getTime()) ? madridDateKey(date) : '';
      return {
        kind,
        who: bubbleWho(kind, item.role, responder),
        text: maskMessageText(raw) || '(mensaje vacío)',
        time: formatTime(date),
        dateKey,
        dateLabel: dateKey ? formatDayLabel(dateKey) : '',
        selectedDay: dateKey === fecha,
        cut: kind === 'bot' && raw.length >= BOT_TEXT_LIMIT,
      };
    });

    const name = customer && customer.name
      ? maskMessageText(customer.name).trim()
      : row ? row.name : `Chat ${key}`;

    return {
      available: true,
      notice: null,
      fecha,
      chatId: key,
      name: name || `Chat ${key}`,
      username,
      usernameLabel: username ? `@${username}` : '',
      isTest,
      hitLimit: loaded.total > THREAD_LIMIT,
      hint: 'Los mensajes del bot se guardan recortados a 500 caracteres.',
      messages,
      ...outcome,
    };
  } catch (err) {
    console.error('[conversaciones] no se pudo leer el hilo:', err.message);
    closeBot(dbPath);
    return unavailable(fecha, 'No se pudo leer la base del bot de Telegram. El panel sigue funcionando.', false);
  }
}

module.exports = {
  BOT_TEXT_LIMIT,
  TIME_ZONE,
  maskMessageText,
  madridDayBounds,
  todayMadrid,
  parseFecha,
  shiftFecha,
  getDay,
  getThread,
  openReadOnly,
  closeBot,
};
