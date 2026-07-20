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
};

module.exports = config;
