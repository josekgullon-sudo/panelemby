// Único punto de contacto con la API REST de Emby.
// Ninguna otra parte del código debe hacer fetch a Emby directamente.

const config = require('../config');

class EmbyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'EmbyError';
    this.status = status;
  }
}

async function embyRequest(method, apiPath, body) {
  const url = `${config.embyUrl}/emby${apiPath}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Emby-Token': config.embyApiKey,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new EmbyError(`No se pudo conectar con Emby (${config.embyUrl}): ${err.message}`, 0);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new EmbyError(`Emby respondió ${res.status} en ${method} ${apiPath}: ${text.slice(0, 300)}`, res.status);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return null;
}

// --- Sistema ---

async function getSystemInfo() {
  return embyRequest('GET', '/System/Info');
}

// --- Usuarios ---

async function listUsers() {
  return embyRequest('GET', '/Users');
}

async function getUser(embyUserId) {
  return embyRequest('GET', `/Users/${embyUserId}`);
}

// Crea el usuario y le pone contraseña. Devuelve el UserDto de Emby.
async function createUser(name, password) {
  const user = await embyRequest('POST', '/Users/New', { Name: name });
  await setPassword(user.Id, password);
  return user;
}

async function setPassword(embyUserId, newPassword) {
  return embyRequest('POST', `/Users/${embyUserId}/Password`, {
    CurrentPw: '',
    NewPw: newPassword,
    ResetPassword: false,
  });
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

// Límite de reproducciones simultáneas (pantallas del plan). 0 = sin límite en Emby.
async function setStreamLimit(embyUserId, screens) {
  return updatePolicy(embyUserId, { SimultaneousStreamLimit: screens });
}

async function deleteUser(embyUserId) {
  return embyRequest('DELETE', `/Users/${embyUserId}`);
}

module.exports = {
  EmbyError,
  getSystemInfo,
  listUsers,
  getUser,
  createUser,
  setPassword,
  updatePolicy,
  setDisabled,
  setStreamLimit,
  deleteUser,
};
