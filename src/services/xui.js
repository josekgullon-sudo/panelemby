// Único punto de contacto con el admin API de XUI.one.
// Ninguna otra parte del código debe llamar a XUI directamente.
//
// Formato confirmado por el panel: GET {XUI_API_URL}?api_key=KEY&action=ACTION&...
// Acciones de línea según la admin API de XUI.one (create_line, edit_line,
// delete_line, enable_line, disable_line, get_line, get_packages).

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
  return /not found|no exist|does not exist|invalid id|unknown line|no line/i.test(String(message || ''));
}

function unwrap(payload, action) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.status) {
    const status = String(payload.status);
    const ok = status === 'STATUS_SUCCESS' || status.toLowerCase() === 'success';
    if (!ok) {
      const message = payload.error || payload.message || payload.msg || status;
      const err = new XuiError(`XUI ${action}: ${message}`);
      if (looksMissing(message)) err.status = 404;
      throw err;
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

async function createLine({ username, password, expDate, maxConnections, packageId, isTrial, bouquets, memberId }) {
  const params = {
    username,
    password,
    exp_date: expDate,
    max_connections: maxConnections,
    package: packageId,
    is_trial: isTrial ? 1 : 0,
    enabled: 1,
    member_id: memberId || config.xuiMemberId || undefined,
  };
  if (bouquets && bouquets.length) params.bouquets_selected = JSON.stringify(bouquets.map(String));
  const data = await request('create_line', params);
  const row = data && !Array.isArray(data) ? data : Array.isArray(data) ? data[0] : null;
  const id = row && (row.id || row.line_id || row.user_id);
  if (!id) throw new XuiError('XUI creó la línea pero no devolvió un id');
  return { id: String(id), raw: row };
}

async function editLine(id, fields) {
  return request('edit_line', Object.assign({ id }, fields));
}

async function deleteLine(id) {
  return request('delete_line', { id });
}

async function enableLine(id) {
  return request('enable_line', { id });
}

async function disableLine(id) {
  return request('disable_line', { id });
}

function setTransport(fn) {
  transportOverride = fn;
}

module.exports = {
  XuiError,
  isConfigured,
  buildUrl,
  tlsRejectUnauthorized,
  getPackages,
  getLine,
  createLine,
  editLine,
  deleteLine,
  enableLine,
  disableLine,
  normalizePackage,
  setTransport,
};
