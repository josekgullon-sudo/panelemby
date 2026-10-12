// Único punto de contacto con la API pública de Max Player.
// Base https://api.maxplayer.tv/v3/api/public  ·  cabecera Api-Token.
//
// Alta de un cliente conectado a una línea XUI:
//   POST /users          (domain_id + iptv_user + iptv_pass crean usuario y lista inicial)
//   PUT  /users/list     (o POST /users/list si todavía no hay lista) para fijar la playlist
//   PUT  /users/connect  solo si el usuario ya existía y no estaba asignado (409)
// Borrado: DELETE /users/{id}

const config = require('../config');

class MaxPlayerError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'MaxPlayerError';
    this.status = status || 0;
  }
}

function hasCredentials() {
  return !!config.maxplayerApiKey;
}

function isConfigured() {
  return !!(config.maxplayerApiKey && config.maxplayerDomainId);
}

function assertConfigured() {
  if (!config.maxplayerApiKey) {
    throw new MaxPlayerError('Max Player no está configurado. Revisa MAXPLAYER_API_KEY en el .env.');
  }
}

function assertReadyToProvision() {
  assertConfigured();
  if (!config.maxplayerDomainId) {
    throw new MaxPlayerError('Falta MAXPLAYER_DOMAIN_ID: es el dominio de Max Player donde se engancha la lista XUI.');
  }
}

const RETRY_DELAYS_MS = [400, 1200, 3000];
let waitForRetry = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setRetryWait(fn) {
  waitForRetry = typeof fn === 'function' ? fn : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

async function mpRequest(method, apiPath, body, options = {}) {
  assertConfigured();
  const attempt = options.attempt || 0;
  const url = `${config.maxplayerApiUrl}${apiPath}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Api-Token': config.maxplayerApiKey,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new MaxPlayerError(`No se pudo conectar con Max Player: ${err.message}`, 0);
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

  // El panel real responde 503 "Could not verify public API allowance. Please retry."
  // Un 503 con applied=true ya guardó el cambio: no se repite.
  if (res.status === 503 && !(payload && payload.applied === true) && attempt < RETRY_DELAYS_MS.length) {
    await waitForRetry(RETRY_DELAYS_MS[attempt]);
    return mpRequest(method, apiPath, body, Object.assign({}, options, { attempt: attempt + 1 }));
  }

  if (res.status === 429) {
    const retry = res.headers.get('retry-after');
    throw new MaxPlayerError(
      `Max Player limitó las peticiones${retry ? `. Reintenta en ${retry} s` : ''}.`,
      429
    );
  }
  if (!res.ok) {
    const message = (payload && payload.error) || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new MaxPlayerError(`Max Player respondió ${res.status} en ${method} ${apiPath}: ${message}`, res.status);
  }
  if (payload && payload.success === 0) {
    throw new MaxPlayerError(payload.error || 'Max Player rechazó la operación', 400);
  }
  if (options.raw) return { payload, headers: res.headers };
  return payload;
}

async function getInfo() {
  return mpRequest('GET', '/info');
}

async function listUsers({ limit = 100, afterId } = {}) {
  const page = await listUsersPage({ limit, afterId });
  return page.users;
}

async function listUsersPage({ limit = 100, afterId } = {}) {
  const qs = new URLSearchParams({ limit: String(Math.min(100, limit)) });
  if (afterId) qs.set('after_id', String(afterId));
  const { payload, headers } = await mpRequest('GET', `/users?${qs.toString()}`, undefined, { raw: true });
  const users = Array.isArray(payload) ? payload : (payload && (payload.users || payload.data)) || [];
  const headerMore = headers && headers.get ? headers.get('x-has-more') : null;
  const headerCursor = headers && headers.get ? headers.get('x-next-cursor') : '';
  const hasMore = headerMore != null
    ? ['1', 'true'].includes(String(headerMore).toLowerCase())
    : !!(payload && payload.has_more);
  const nextCursor = headerCursor || (payload && payload.next_cursor) || '';
  return { users, hasMore: !!(hasMore && nextCursor), nextCursor };
}

async function listAllUsers() {
  const all = [];
  let afterId = '';
  for (let page = 0; page < 40; page += 1) {
    const batch = await listUsersPage({ limit: 100, afterId: afterId || undefined });
    all.push(...batch.users);
    if (!batch.hasMore) break;
    afterId = batch.nextCursor;
  }
  return all;
}

async function createUser(body) {
  return mpRequest('POST', '/users', body);
}

async function deleteUser(userId) {
  return mpRequest('DELETE', `/users/${encodeURIComponent(userId)}`);
}

async function connectUser(userEmail) {
  return mpRequest('PUT', '/users/connect', { user_email: userEmail });
}

async function addList(body) {
  return mpRequest('POST', '/users/list', body);
}

async function updateList(body) {
  return mpRequest('PUT', '/users/list', body);
}

async function changePassword(userId, password) {
  return mpRequest('PUT', '/users/password', { user_id: String(userId), password });
}

async function searchUsers(username, options = {}) {
  const qs = new URLSearchParams();
  if (options.limit) qs.set('limit', String(options.limit));
  if (options.afterId) qs.set('after_id', String(options.afterId));
  const query = qs.toString();
  return mpRequest('POST', `/users/search${query ? `?${query}` : ''}`, { username });
}

async function searchAll(username) {
  const users = [];
  let afterId = '';
  for (let page = 0; page < 40; page += 1) {
    const found = await searchUsers(username, { limit: 100, afterId: afterId || undefined });
    const batch = (found && found.users) || [];
    users.push(...batch);
    if (!found || !found.has_more || !found.next_cursor) break;
    afterId = found.next_cursor;
  }
  return users;
}

async function deleteDevices(userId) {
  return mpRequest('DELETE', `/users/devices/${encodeURIComponent(userId)}`);
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.devices)) return payload.devices;
  if (Array.isArray(payload.lists)) return payload.lists;
  if (payload.data && Array.isArray(payload.data.devices)) return payload.data.devices;
  if (payload.data && Array.isArray(payload.data.lists)) return payload.data.lists;
  return [];
}

async function listCustomerDevices(userId) {
  const payload = await mpRequest('GET', `/customers/${encodeURIComponent(userId)}/devices`);
  return asList(payload);
}

async function deleteCustomerDevice(userId, deviceId) {
  return mpRequest(
    'DELETE',
    `/customers/${encodeURIComponent(userId)}/devices/${encodeURIComponent(deviceId)}`
  );
}

async function listCustomerPlaylists(userId) {
  const payload = await mpRequest('GET', `/customers/${encodeURIComponent(userId)}/lists`);
  return asList(payload);
}

// DELETE /users/devices/{id} borra todos los dispositivos. Si esa ruta falla,
// se listan en /customers/{id}/devices y se borra cada uno.
async function deleteAllDevices(userId) {
  try {
    await deleteDevices(userId);
    return { method: 'bulk' };
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
    let devices = [];
    try {
      devices = await listCustomerDevices(userId);
    } catch (listErr) {
      throw err;
    }
    for (const device of devices) {
      const id = device && (device.id || device.device_id);
      if (id) await deleteCustomerDevice(userId, id);
    }
    return { method: 'customers', count: devices.length };
  }
}

async function setDeviceLimit(userId, deviceLimit) {
  return mpRequest('PUT', `/users/${encodeURIComponent(userId)}/device-limit`, {
    device_limit: deviceLimit,
  });
}

function listBody({ userId, domainId, iptvUsername, iptvPassword }) {
  return {
    user_id: String(userId),
    domain_id: String(domainId),
    iptv_username: iptvUsername,
    iptv_password: iptvPassword,
  };
}

// La lista inicial viaja en POST /users (iptv_user / iptv_pass).
// PUT /users/list actualiza esa playlist; si aún no existe, POST /users/list la crea.
async function attachPlaylist(userId, creds) {
  const body = listBody({ userId, ...creds });
  try {
    return await updateList(body);
  } catch (err) {
    if (err.status === 404) return addList(body);
    throw err;
  }
}

async function findUserId(username) {
  const found = await searchUsers(username);
  const users = (found && found.users) || [];
  const exact = users.find((user) => user.username === username);
  return exact ? String(exact.id) : null;
}

// Crea el usuario de Max Player y deja la playlist apuntando a la línea XUI.
// Si el usuario ya existe (reintento tras un 409), lo busca, lo conecta si hace
// falta y vuelve a fijar la lista. No crea una segunda cuenta.
async function provisionUser({ username, password, iptvUser, iptvPass, domainId }) {
  assertReadyToProvision();
  const domain = String(domainId || config.maxplayerDomainId);
  const body = {
    domain_id: domain,
    iptv_user: iptvUser,
    iptv_pass: iptvPass,
    username,
    user_password: password,
  };
  if (config.maxplayerResellerId) body.reseller_id = config.maxplayerResellerId;

  let userId;
  try {
    const created = await createUser(body);
    userId = created && (created.user_id || created.id);
    if (!userId) throw new MaxPlayerError('Max Player creó el usuario pero no devolvió user_id');
  } catch (err) {
    if (err.status !== 409) throw err;
    await connectUser(username).catch((connectErr) => {
      if (connectErr.status !== 404 && connectErr.status !== 409) throw connectErr;
    });
    userId = await findUserId(username);
    if (!userId) throw err;
  }

  await attachPlaylist(userId, { domainId: domain, iptvUsername: iptvUser, iptvPassword: iptvPass });
  return { userId: String(userId) };
}

module.exports = {
  MaxPlayerError,
  hasCredentials,
  isConfigured,
  getInfo,
  listUsers,
  createUser,
  deleteUser,
  connectUser,
  addList,
  updateList,
  changePassword,
  searchUsers,
  searchAll,
  deleteDevices,
  deleteAllDevices,
  listCustomerDevices,
  deleteCustomerDevice,
  listCustomerPlaylists,
  listUsersPage,
  listAllUsers,
  setRetryWait,
  setDeviceLimit,
  attachPlaylist,
  provisionUser,
};
