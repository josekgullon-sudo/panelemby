// Único punto de contacto con el admin API de XUI.one.
// Ninguna otra parte del código debe llamar a XUI directamente.
//
// Formato confirmado por el panel: GET {XUI_API_URL}?api_key=KEY&action=ACTION&...
// Acciones de línea según la admin API de XUI.one (create_line, edit_line,
// delete_line, get_line, get_packages). enable y disable también pasan por
// edit_line: en este XUI esa acción reescribe la línea entera.

const http = require('http');
const https = require('https');
const config = require('../config');

class XuiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'XuiError';
    this.status = status || 0;
  }
}

let transportOverride = null;

function isConfigured() {
  return !!(config.xuiApiUrl && config.xuiApiKey);
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new XuiError('XUI no está configurado. Revisa XUI_API_URL y XUI_API_KEY en el .env.');
  }
}

function buildUrl(action, params) {
  const url = new URL(`${config.xuiApiUrl}/`);
  url.searchParams.set('api_key', config.xuiApiKey);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    // access_output[]=1&access_output[]=2: un array repite la clave.
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function safeUrl(url) {
  const copy = new URL(url.toString());
  if (copy.searchParams.has('api_key')) copy.searchParams.set('api_key', '***');
  return copy.toString();
}

function tlsRejectUnauthorized() {
  // true = verificar el certificado. El flag solo afloja ESTA petición.
  return !config.xuiInsecureTls;
}

// XUI rechaza el unix (STATUS_INVALID_DATE). Quiere 'YYYY-MM-DD HH:mm'
// en hora de Europa/Madrid. El reloj del servidor es UTC: no uses toISOString.
function formatMadridDateTime(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type) => {
    const part = parts.find((item) => item.type === type);
    return part ? part.value : '';
  };
  const hour = pick('hour') === '24' ? '00' : pick('hour');
  return `${pick('year')}-${pick('month')}-${pick('day')} ${hour}:${pick('minute')}`;
}

function wallMinutes(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]) / 60000;
}

// 'YYYY-MM-DD HH:mm[:ss]' leído de XUI: es hora de Madrid, no UTC.
function madridWallToDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(text || '').trim());
  if (!match) return null;
  const target = `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
  const targetMin = wallMinutes(target);
  let utc = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] || 0));
  for (let i = 0; i < 4; i += 1) {
    const shownMin = wallMinutes(formatMadridDateTime(new Date(utc)));
    if (shownMin == null || targetMin == null) return null;
    const delta = targetMin - shownMin;
    if (delta === 0) return new Date(utc);
    utc += delta * 60000;
  }
  return new Date(utc);
}

function formatExpDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new XuiError('Fecha de caducidad XUI no válida');
    return formatMadridDateTime(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatMadridDateTime(new Date(value < 1e12 ? value * 1000 : value));
  }
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return text;
  if (/^\d{10,13}$/.test(text)) return formatExpDate(Number(text));
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(text)) {
    const iso = text.replace(' ', 'T');
    const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
    if (Number.isNaN(date.getTime())) throw new XuiError('Fecha de caducidad XUI no válida');
    return formatMadridDateTime(date);
  }
  throw new XuiError(`Fecha de caducidad XUI no válida (${text.slice(0, 40)})`);
}

function parseExpToDate(value) {
  if (value == null || value === '' || value === 0 || value === '0') return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  return madridWallToDate(value);
}

function defaultTransport(url) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        rejectUnauthorized: tlsRejectUnauthorized(),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function parseBody(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new XuiError('XUI respondió vacío');
  try {
    return JSON.parse(trimmed);
  } catch {
    const obj = trimmed.indexOf('{');
    const arr = trimmed.indexOf('[');
    const start = obj === -1 ? arr : arr === -1 ? obj : Math.min(obj, arr);
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        /* sigue abajo */
      }
    }
    throw new XuiError(`XUI no devolvió JSON: ${trimmed.slice(0, 200)}`);
  }
}

function looksMissing(message) {
  const text = String(message || '').trim();
  // Este XUI responde solo {"status":"STATUS_FAILURE"} cuando el id no existe.
  // Un cuerpo vacío (503 de nginx) no es un id ausente.
  if (text === 'STATUS_FAILURE') return true;
  return /not found|no exist|does not exist|invalid id|unknown line|no line/i.test(text);
}

function unwrap(payload, action) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.status) {
    const status = String(payload.status);
    const ok = status === 'STATUS_SUCCESS' || status.toLowerCase() === 'success';
    if (!ok) {
      const message = payload.error || payload.message || payload.msg || status;
      const missing = looksMissing(message);
      throw new XuiError(`XUI ${action}: ${message}`, missing ? 404 : 400);
    }
  }
  if (payload.data !== undefined) return payload.data;
  return payload;
}

async function request(action, params) {
  assertConfigured();
  const url = buildUrl(action, params);
  let res;
  try {
    res = await (transportOverride || defaultTransport)(url);
  } catch (err) {
    throw new XuiError(`No se pudo conectar con XUI (${config.xuiApiUrl}): ${err.message}`, 0);
  }
  if (res.status >= 400) {
    const err = new XuiError(
      `XUI respondió HTTP ${res.status} en ${action}: ${String(res.body || '').slice(0, 300)}`,
      res.status
    );
    if (res.status === 404 || looksMissing(res.body)) err.status = 404;
    throw err;
  }
  try {
    return unwrap(parseBody(res.body), action);
  } catch (err) {
    if (err instanceof XuiError) throw err;
    throw new XuiError(`Respuesta inesperada de XUI en ${action} (${safeUrl(url)}): ${err.message}`);
  }
}

function truthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
}

// get_line devuelve is_trial como texto: "1" es prueba y "0" no lo es.
// En JavaScript el texto "0" es verdadero, así que no vale un if suelto.
function trialFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes' || text === 'on';
  }
  return false;
}

function asInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

function normalizeBouquets(value) {
  if (value == null || value === '') return [];
  let parsed = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed
    .map((item) => {
      if (item && typeof item === 'object') return String(item.id ?? item.bouquet_id ?? '');
      return String(item);
    })
    .filter(Boolean);
}

function normalizePackage(raw) {
  const bouquets = normalizeBouquets(raw.bouquets ?? raw.bouquet ?? raw.bouquets_selected);
  return {
    id: String(raw.id),
    package_name: String(raw.package_name || raw.name || `Paquete ${raw.id}`),
    is_trial: truthy(raw.is_trial),
    is_official: truthy(raw.is_official),
    trial_duration: asInt(raw.trial_duration),
    official_duration: asInt(raw.official_duration),
    max_connections: asInt(raw.max_connections),
    bouquets,
  };
}

function packageList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.packages)) return data.packages;
  if (data && Array.isArray(data.rows)) return data.rows;
  return [];
}

async function getPackages() {
  const data = await request('get_packages');
  const list = packageList(data);
  if (!Array.isArray(list)) throw new XuiError('get_packages no devolvió una lista');
  return list.filter((row) => row && row.id != null).map(normalizePackage);
}

async function getLine(id) {
  return request('get_line', { id });
}

function linesFromLookup(data) {
  const rows = lineList(data);
  const source = rows.length
    ? rows
    : data && typeof data === 'object' && !Array.isArray(data)
      ? [data]
      : [];
  return source.map(normalizeLine).filter((line) => line.id && line.username);
}

// Busca un usuario sin recorrer ids. get_lines en este XUI devuelve null;
// si las dos lecturas vienen vacías, el nombre se trata como libre.
async function findLineByUsername(username) {
  const name = String(username || '').trim();
  if (!name) return null;
  const queries = [
    ['get_line', { username: name }],
    ['get_lines', { search: name, username: name, limit: 50 }],
  ];
  for (const [action, params] of queries) {
    let data;
    try {
      data = await request(action, params);
    } catch (err) {
      if (err && (err.status === 404 || err.status === 400)) continue;
      if (err && /respondió vacío|no devolvió JSON/i.test(err.message || '')) continue;
      throw err;
    }
    const hit = linesFromLookup(data).find((line) => line.username.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

async function fetchLine(id) {
  const raw = await readLine(id);
  const line = lineFromPayload(raw);
  if (!line) {
    throw new XuiError(`La línea ${id} no trae usuario`, 404);
  }
  return line;
}

// Reintentos solo de lectura. create_line / edit_line no se repiten: un 503
// podría significar que la línea ya se aplicó.
const SCAN_RETRY_MS = [300, 900, 2700, 8000];
let scanWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setScanWait(fn) {
  scanWait = typeof fn === 'function' ? fn : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  if (!err || err.status === 404) return false;
  if (!err.status || err.status >= 500) return true;
  return /timeout|timed out|ECONNRESET|EAI_AGAIN|socket/i.test(err.message || '');
}

async function readLine(id) {
  const attempts = SCAN_RETRY_MS.length + 1;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await getLine(id);
    } catch (err) {
      if (err && err.status === 404) throw err;
      const again = isRetryable(err) && i < attempts - 1;
      if (!again) {
        const tried = i + 1;
        const wrapped = new XuiError(
          `La lectura de la línea ${id} falló tras ${tried} intento${tried === 1 ? '' : 's'} (${err && err.message ? err.message : err}). La importación se detiene para no saltarse líneas.`,
          (err && err.status) || 0
        );
        wrapped.lineId = String(id);
        throw wrapped;
      }
      await scanWait(SCAN_RETRY_MS[i]);
    }
  }
  return null;
}

function lineFromPayload(raw) {
  if (raw == null || raw === '') return null;
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== 'object') return null;
  const line = normalizeLine(row);
  if (!line.id || !line.username) return null;
  return line;
}

async function scanLines(options = {}) {
  const concurrency = options.concurrency || config.xuiScanConcurrency;
  const missStreak = options.missStreak || config.xuiScanMissGap;
  const maxId = options.maxId || config.xuiScanMaxId;
  const onProgress = options.onProgress;
  const lines = [];
  let nextId = 1;
  let misses = 0;
  while (nextId <= maxId && misses < missStreak) {
    const ids = [];
    const room = missStreak - misses;
    const batch = Math.min(concurrency, room, maxId - nextId + 1);
    for (let i = 0; i < batch; i += 1) {
      ids.push(nextId);
      nextId += 1;
    }
    const results = await Promise.all(ids.map(async (id) => {
      try {
        return { raw: await readLine(id) };
      } catch (err) {
        if (err && err.status === 404) return { raw: null };
        throw err;
      }
    }));
    for (const result of results) {
      const line = lineFromPayload(result.raw);
      if (!line) {
        misses += 1;
        if (misses >= missStreak) break;
      } else {
        misses = 0;
        lines.push(line);
      }
    }
    if (typeof onProgress === 'function') {
      await onProgress({ scannedId: ids[ids.length - 1], found: lines.length });
    }
  }
  return lines;
}

// Este XUI ignora allowed_outputs y output_formats. La clave que sí aplica es
// access_output[] repetida. El env es "1,2,3"; vacío también vale 1,2,3.
function allowedOutputIds(raw) {
  if (Array.isArray(raw)) {
    const numbers = raw
      .map((part) => parseInt(String(part).trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
    return numbers.length ? numbers : null;
  }
  const text = (raw == null ? '' : String(raw)).trim();
  if (!text || text === '[]' || text === 'null') return null;
  const numbers = text
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((part) => parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return numbers.length ? numbers : null;
}

function configuredOutputIds() {
  return allowedOutputIds(config.xuiAllowedOutputs) || [1, 2, 3];
}

function outputIdsFromLine(row) {
  return allowedOutputIds(row && (row.allowed_outputs ?? row.access_output)) || configuredOutputIds();
}

async function createLine({ username, password, expDate, maxConnections, packageId, isTrial, bouquets, memberId }) {
  // `package` se envía igual, pero este XUI lo ignora: la línea vuelve sin
  // paquete. El id que vale es el que guardamos en emby_accounts.xui_package_id.
  // Cualquier is_trial (también 0) enciende la prueba. Solo se manda el 1.
  const params = {
    username,
    password,
    exp_date: formatExpDate(expDate),
    max_connections: maxConnections,
    package: packageId,
    enabled: 1,
    member_id: memberId || config.xuiMemberId || undefined,
    'access_output[]': configuredOutputIds(),
  };
  if (trialFlag(isTrial)) params.is_trial = 1;
  if (bouquets && bouquets.length) params.bouquets_selected = JSON.stringify(bouquets.map(String));
  const data = await request('create_line', params);
  const row = data && !Array.isArray(data) ? data : Array.isArray(data) ? data[0] : null;
  const id = row && (row.id || row.line_id || row.user_id);
  if (!id) throw new XuiError('XUI creó la línea pero no devolvió un id');
  return { id: String(id), raw: row };
}

function lineRow(raw) {
  if (raw == null || raw === '') return null;
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== 'object') return null;
  return row;
}

function editScalar(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return undefined;
  return value;
}

function emptyBouquetList(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  const text = String(value).trim();
  return !text || text === '[]' || text === 'null';
}

function bouquetIds(value) {
  return normalizeBouquets(value).slice().sort();
}

function sameBouquetIds(left, right) {
  const a = bouquetIds(left);
  const b = bouquetIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function applyExpDate(params) {
  const value = params.exp_date;
  if (value == null || value === '' || value === 0 || value === '0') {
    if (value === 0 || value === '0') params.exp_date = '0';
    return;
  }
  params.exp_date = formatExpDate(value);
}

// edit_line sustituye la línea. Estos campos salen de get_line; el cambio
// solo pisa lo que el llamador trae. Bouquets vacíos (los de la base del
// panel, por ejemplo) no entran: borrarían los canales.
function lineToEditParams(row) {
  const bouquets = normalizeBouquets(row.bouquets_selected ?? row.bouquet ?? row.bouquets);
  const notes = row.notes != null && String(row.notes).trim() !== ''
    ? row.notes
    : row.admin_notes;
  const params = {
    username: row.username,
    password: row.password == null ? '' : row.password,
    exp_date: row.exp_date ?? row.expdate,
    max_connections: row.max_connections,
    enabled: row.enabled,
    admin_enabled: row.admin_enabled,
    member_id: row.member_id,
    'access_output[]': outputIdsFromLine(row),
  };
  if (bouquets.length) params.bouquets_selected = JSON.stringify(bouquets);
  // Un is_trial presente, aunque sea 0, deja la línea en prueba. En una de pago no se manda.
  if (trialFlag(row.is_trial)) params.is_trial = 1;
  const ips = editScalar(row.allowed_ips);
  const ua = editScalar(row.allowed_ua);
  if (ips != null && ips !== '') params.allowed_ips = ips;
  if (ua != null && ua !== '') params.allowed_ua = ua;
  if (notes != null && String(notes).trim() !== '') params.notes = notes;
  if (row.admin_notes != null && String(row.admin_notes).trim() !== '') params.admin_notes = row.admin_notes;
  if (row.reseller_notes != null && String(row.reseller_notes).trim() !== '') {
    params.reseller_notes = row.reseller_notes;
  }
  return params;
}

async function readLineForEdit(id, when) {
  try {
    return lineRow(await getLine(id));
  } catch (err) {
    throw new XuiError(
      `No se pudo leer la línea ${id} ${when} (${err && err.message ? err.message : err})`,
      (err && err.status) || 0
    );
  }
}

async function editLine(id, fields) {
  const row = await readLineForEdit(id, 'antes de editarla');
  if (!row || !row.username) {
    throw new XuiError(`get_line no devolvió la línea ${id}`, 404);
  }
  const params = lineToEditParams(row);
  for (const [key, value] of Object.entries(fields || {})) {
    if (key === 'id' || key === 'allowed_outputs' || key === 'output_formats' || value === undefined) continue;
    if (key === 'bouquets_selected' && emptyBouquetList(value)) continue;
    if (key === 'is_trial') {
      if (trialFlag(value)) params.is_trial = 1;
      else delete params.is_trial;
      continue;
    }
    params[key] = value;
  }
  params.id = String(id);
  applyExpDate(params);
  const sentUser = String(params.username || '').trim();
  const sentBouquets = params.bouquets_selected;
  const result = await request('edit_line', params);
  const after = await readLineForEdit(id, 'después de editarla');
  const gotUser = String(after && after.username || '').trim();
  const gotBouquets = after && (after.bouquets_selected ?? after.bouquet ?? after.bouquets);
  if (gotUser !== sentUser || !sameBouquetIds(sentBouquets, gotBouquets)) {
    throw new XuiError(
      `La edición de la línea ${id} no conservó el usuario o los bouquets (quedó «${gotUser || 'sin usuario'}», bouquets ${JSON.stringify(bouquetIds(gotBouquets))})`
    );
  }
  return result;
}

function lineList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.lines)) return data.lines;
  if (data && Array.isArray(data.rows)) return data.rows;
  return [];
}

function normalizeLine(raw) {
  const packageId = raw.package == null || raw.package === '' || raw.package === 0 || raw.package === '0'
    ? ''
    : String(raw.package);
  return {
    id: String(raw.id ?? raw.line_id ?? ''),
    username: String(raw.username || '').trim(),
    password: raw.password == null ? '' : String(raw.password),
    exp_date: raw.exp_date ?? raw.expdate ?? null,
    member_id: raw.member_id == null || raw.member_id === '' ? '' : String(raw.member_id),
    max_connections: asInt(raw.max_connections),
    enabled: raw.enabled === undefined ? true : truthy(raw.enabled),
    is_trial: trialFlag(raw.is_trial),
    bouquets: normalizeBouquets(raw.bouquets_selected ?? raw.bouquet ?? raw.bouquets),
    // Informativo. No sustituye al paquete guardado en el panel.
    package_id: packageId,
  };
}

// get_lines puede devolver el listado entero o un sobre con total.
// Si declara un total mayor que la página, se pide el resto con start/limit.
// En este XUI get_lines (y get_users) devuelve null: entonces se pide get_line
// por id, de pocos en pocos, y se para tras una racha larga de ids vacíos
// o al llegar al id máximo. Un fallo de red no cuenta como id vacío.
async function getLines(options = {}) {
  const first = await request('get_lines');
  const page = lineList(first).map(normalizeLine).filter((line) => line.id && line.username);
  if (!page.length) return scanLines(options);
  const total = first && !Array.isArray(first) ? asInt(first.total ?? first.recordsTotal ?? first.count) : null;
  if (!total || page.length >= total) return page;
  const all = page.slice();
  let start = page.length;
  while (all.length < total && start < 200000) {
    const next = await request('get_lines', { start, limit: 500 });
    const chunk = lineList(next).map(normalizeLine).filter((line) => line.id && line.username);
    if (!chunk.length) break;
    all.push(...chunk);
    start += chunk.length;
  }
  return all;
}

async function deleteLine(id) {
  return request('delete_line', { id });
}

async function enableLine(id) {
  return editLine(id, { enabled: 1 });
}

async function disableLine(id) {
  return editLine(id, { enabled: 0 });
}

function setTransport(fn) {
  transportOverride = fn;
}

module.exports = {
  XuiError,
  isConfigured,
  buildUrl,
  tlsRejectUnauthorized,
  formatExpDate,
  parseExpToDate,
  getPackages,
  getLine,
  findLineByUsername,
  fetchLine,
  trialFlag,
  getLines,
  scanLines,
  allowedOutputIds,
  createLine,
  editLine,
  deleteLine,
  enableLine,
  disableLine,
  normalizePackage,
  setTransport,
  setScanWait,
};
