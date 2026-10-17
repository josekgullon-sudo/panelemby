// Único punto de contacto con la API de reseller de HotPlayer.
// Base https://hotplayer.app/api/v1/reseller  ·  cabecera Authorization: ApiKey.
//
// Lo único que usa el panel es:
//   GET  /balance
//   POST /add-playlists/{mac}   body JSON [{ name, url }]  (máximo 5 listas)
// La url Xtream es HOST:PORT|USUARIO|PASSWORD.
//
// No se llama a /activate/{mac} (gasta créditos: la app la paga el cliente)
// ni a /delete-playlists/{mac}. No hay documentación pública de si
// add-playlists sustituye una lista con el mismo name o añade otra.
// Cada alta y cada cambio de usuario/contraseña reenvía una sola lista
// con el mismo name (TOTALFLIX) para que, si el API agrupa por nombre,
// la tele se quede con la línea nueva.

const config = require('../config');

const PLAYLIST_NAME = 'TOTALFLIX';
const RETRY_DELAYS_MS = [400, 1200, 3000];

class HotPlayerError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HotPlayerError';
    this.status = status || 0;
  }
}

let waitForRetry = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setRetryWait(fn) {
  waitForRetry = typeof fn === 'function' ? fn : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

function hasCredentials() {
  return !!config.hotplayerApiKey;
}

function isConfigured() {
  return !!config.hotplayerApiKey;
}

function assertConfigured() {
  if (!config.hotplayerApiKey) {
    throw new HotPlayerError('HotPlayer no está configurado. Revisa HOTPLAYER_API_KEY en el .env.');
  }
}

// AA:BB:CC:DD:EE:FF, también con guiones o los 12 hex seguidos. Mayúsculas.
function normalizeMac(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (!text || /[^0-9A-F\s:.-]/.test(text)) return '';
  const compact = text.replace(/[\s:.-]/g, '');
  if (!/^[0-9A-F]{12}$/.test(compact)) return '';
  return compact.match(/.{2}/g).join(':');
}

function playlistHost(host) {
  const value = String(host || config.hotplayerDomain || 'cisnerojo.click').trim();
  return value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '') || 'cisnerojo.click';
}

function playlistPort(port) {
  const n = parseInt(port == null || port === '' ? config.hotplayerPort : port, 10);
  return Number.isInteger(n) && n > 0 ? n : 80;
}

function xtreamUrl({ host, port, username, password }) {
  return `${playlistHost(host)}:${playlistPort(port)}|${username}|${password}`;
}

async function hpRequest(method, apiPath, body, options = {}) {
  assertConfigured();
  const attempt = options.attempt || 0;
  const url = `${config.hotplayerApiUrl}${apiPath}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `ApiKey ${config.hotplayerApiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new HotPlayerError(`No se pudo conectar con HotPlayer: ${err.message}`, 0);
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (res.status >= 500 && res.status <= 599 && attempt < RETRY_DELAYS_MS.length) {
    await waitForRetry(RETRY_DELAYS_MS[attempt]);
    return hpRequest(method, apiPath, body, Object.assign({}, options, { attempt: attempt + 1 }));
  }

  if (!res.ok) {
    const message = (payload && (payload.error || payload.message)) || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new HotPlayerError(`HotPlayer respondió ${res.status} en ${method} ${apiPath}: ${message}`, res.status);
  }
  if (payload && payload.status && payload.status !== 'success') {
    const message = payload.error || payload.message || 'HotPlayer rechazó la operación';
    throw new HotPlayerError(String(message), res.status || 400);
  }
  return payload;
}

async function getBalance() {
  const payload = await hpRequest('GET', '/balance');
  const balance = payload && Number(payload.balance);
  if (!payload || payload.status !== 'success' || !Number.isFinite(balance)) {
    throw new HotPlayerError('HotPlayer no devolvió el saldo.');
  }
  return { status: 'success', balance };
}

// Una lista, siempre con el mismo name. No borra las anteriores: no usamos
// /delete-playlists. Si el API acumula listas, el cliente lo verá en la tele.
async function addPlaylist(mac, fields = {}) {
  const normalized = normalizeMac(mac);
  if (!normalized) {
    throw new HotPlayerError('MAC inválida. Usa el formato XX:XX:XX:XX:XX:XX.');
  }
  const username = String(fields.username || '').trim();
  const password = fields.password == null ? '' : String(fields.password);
  if (!username || !password) {
    throw new HotPlayerError('Faltan el usuario o la contraseña de la línea XUI para cargar HotPlayer.');
  }
  const list = [
    {
      name: fields.name || PLAYLIST_NAME,
      url: xtreamUrl({
        host: fields.host,
        port: fields.port,
        username,
        password,
      }),
    },
  ];
  const payload = await hpRequest('POST', `/add-playlists/${encodeURIComponent(normalized)}`, list);
  return payload || { status: 'success' };
}

module.exports = {
  HotPlayerError,
  PLAYLIST_NAME,
  hasCredentials,
  isConfigured,
  normalizeMac,
  playlistHost,
  xtreamUrl,
  getBalance,
  addPlaylist,
  setRetryWait,
};
