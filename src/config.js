require('dotenv').config();

const path = require('path');

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '' || value.includes('PON_AQUI') || value.includes('cambia_esto')) {
    console.error(`[config] Falta la variable ${name} en el .env (o sigue con el valor de ejemplo).`);
    process.exit(1);
  }
  return value.trim();
}

const config = {
  embyUrl: required('EMBY_URL').replace(/\/+$/, ''),
  embyApiKey: required('EMBY_API_KEY'),
  embyPublicUrl: (process.env.EMBY_PUBLIC_URL || process.env.EMBY_URL).trim().replace(/\/+$/, ''),

  port: parseInt(process.env.PORT || '3000', 10),
  sessionSecret: required('SESSION_SECRET'),
  dbPath: path.resolve(process.cwd(), process.env.DB_PATH || './data/panel.sqlite'),

  deleteAfterDays: parseInt(process.env.DELETE_AFTER_DAYS || '7', 10),
  expiryCron: process.env.EXPIRY_CRON || '30 4 * * *',

  // Qué pasa en Emby al caducar una cuenta:
  //   disable  -> se desactiva (no puede iniciar sesión)
  //   vitrina  -> sigue entrando, pero solo ve la biblioteca-cartel (EXPIRY_LIBRARY)
  expiryMode: (process.env.EXPIRY_MODE || 'disable').trim(),
  expiryLibrary: (process.env.EXPIRY_LIBRARY || '').trim(),
};

if (!['disable', 'vitrina'].includes(config.expiryMode)) {
  console.error(`[config] EXPIRY_MODE debe ser "disable" o "vitrina" (vale: "${config.expiryMode}")`);
  process.exit(1);
}
if (config.expiryMode === 'vitrina' && !config.expiryLibrary) {
  console.error('[config] EXPIRY_MODE=vitrina necesita EXPIRY_LIBRARY con el nombre exacto de la biblioteca-cartel de Emby');
  process.exit(1);
}

module.exports = config;
