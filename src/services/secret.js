// Cifrado reversible para las contraseñas de las cuentas de Emby, de modo que
// el panel pueda reenviar los datos de conexión a un cliente que los perdió.
// AES-256-GCM con clave derivada del SESSION_SECRET. El hash bcrypt sigue
// siendo lo que valida el login del panel; esto es solo para el reenvío.

const crypto = require('crypto');
const config = require('../config');

const KEY = crypto.createHash('sha256').update(`${config.sessionSecret}:emby-pw`).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob) {
  try {
    const [iv, tag, data] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null; // formato corrupto o SESSION_SECRET distinto: mejor "no guardada" que romper
  }
}

module.exports = { encrypt, decrypt };
