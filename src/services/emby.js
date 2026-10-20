// Único punto de contacto con la API REST de Emby.
// Cada servidor tiene su cliente (URL interna + API key). El cliente por
// defecto sigue siendo el servidor 1, el de EMBY_URL / EMBY_API_KEY.

const config = require('../config');

class EmbyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'EmbyError';
    this.status = status;
  }
}

function createClient(server) {
  const baseUrl = String((server && server.url) || '').replace(/\/+$/, '');
  const apiKey = server && server.apiKey;
  const label = (server && server.name) || 'Emby';

  async function embyRequest(method, apiPath, body) {
    const url = `${baseUrl}/emby${apiPath}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'X-Emby-Token': apiKey,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new EmbyError(`No se pudo conectar con ${label} (${baseUrl}): ${err.message}`, 0);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new EmbyError(
        `${label} respondió ${res.status} en ${method} ${apiPath}: ${text.slice(0, 300)}`,
        res.status
      );
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return null;
  }

  async function getSystemInfo() {
    return embyRequest('GET', '/System/Info');
  }

  async function getVirtualFolders() {
    return embyRequest('GET', '/Library/VirtualFolders');
  }

  async function getDevices() {
    return embyRequest('GET', '/Devices');
  }

  async function deleteDevice(deviceId) {
    return embyRequest('DELETE', `/Devices?Id=${encodeURIComponent(deviceId)}`);
  }

  async function getSessions() {
    return embyRequest('GET', '/Sessions');
  }

  async function listUsers() {
    return embyRequest('GET', '/Users');
  }

  async function getUser(embyUserId) {
    return embyRequest('GET', `/Users/${embyUserId}`);
  }

  async function setPassword(embyUserId, newPassword) {
    return embyRequest('POST', `/Users/${embyUserId}/Password`, {
      CurrentPw: '',
      NewPw: newPassword,
      ResetPassword: false,
    });
  }

  // Crea el usuario y le pone contraseña. Devuelve el UserDto de Emby.
  async function createUser(name, password) {
    const user = await embyRequest('POST', '/Users/New', { Name: name });
    await setPassword(user.Id, password);
    return user;
  }

  async function renameUser(embyUserId, name) {
    const user = await getUser(embyUserId);
    const next = Object.assign({}, user, { Name: name });
    return embyRequest('POST', `/Users/${embyUserId}`, next);
  }

  // Emby reemplaza la Policy completa en cada POST: hay que leerla,
  // aplicar solo los cambios y reenviarla entera.
  async function updatePolicy(embyUserId, patch) {
    const user = await getUser(embyUserId);
    const policy = Object.assign(user.Policy || {}, patch);
    return embyRequest('POST', `/Users/${embyUserId}/Policy`, policy);
  }

  async function setDisabled(embyUserId, disabled) {
    return updatePolicy(embyUserId, { IsDisabled: disabled });
  }

  async function setStreamLimit(embyUserId, screens) {
    return updatePolicy(embyUserId, { SimultaneousStreamLimit: screens });
  }

  async function deleteUser(embyUserId) {
    return embyRequest('DELETE', `/Users/${embyUserId}`);
  }

  return {
    key: server && server.key,
    name: label,
    getSystemInfo,
    getVirtualFolders,
    getDevices,
    deleteDevice,
    getSessions,
    listUsers,
    getUser,
    createUser,
    setPassword,
    renameUser,
    updatePolicy,
    setDisabled,
    setStreamLimit,
    deleteUser,
  };
}

const primary = (config.embyServers && config.embyServers[0]) || {
  key: '1',
  name: 'Servidor 1',
  url: config.embyUrl,
  apiKey: config.embyApiKey,
};

module.exports = Object.assign(createClient(primary), {
  EmbyError,
  createClient,
});
