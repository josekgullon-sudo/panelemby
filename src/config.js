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

// Vacío si no está o sigue siendo un marcador. XUI y Max Player son opcionales:
// el panel arranca solo con Emby y esas altas se rechazan hasta configurarlas.
function optional(name) {
  const value = process.env[name];
  if (!value || value.trim() === '' || value.includes('PON_AQUI') || value.includes('cambia_esto')) return '';
  return value.trim();
}

function flag(name) {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] || '').trim().toLowerCase());
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return fallback;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
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

  // XUI.one admin API. Base con el código de acceso, sin query:
  //   https://149.62.187.37/qArcBQyi
  xuiApiUrl: optional('XUI_API_URL').replace(/\/+$/, ''),
  xuiApiKey: optional('XUI_API_KEY'),
  // Certificado autofirmado (IP directa). Solo afecta a las peticiones XUI.
  xuiInsecureTls: flag('XUI_INSECURE_TLS'),
  xuiMemberId: optional('XUI_MEMBER_ID'),
  // URL Xtream/M3U que ve el cliente. No es la URL del admin.
  xuiPublicUrl: optional('XUI_PUBLIC_URL').replace(/\/+$/, ''),
  // get_lines viene vacío en este XUI. Nginx responde 503 con ~10 peticiones
  // a la vez: 4 en paralelo, con reintentos. Hay unas 3500 líneas y los ids
  // pasan de 4700, así que el hueco de parada cubre una racha larga de ids
  // vacíos y el tope llega más allá del id más alto visto.
  xuiScanConcurrency: intEnv('XUI_SCAN_CONCURRENCY', 4),
  xuiScanMissGap: intEnv('XUI_SCAN_MISS_GAP', 2000),
  xuiScanMaxId: intEnv('XUI_SCAN_MAX_ID', 10000),

  maxplayerApiUrl: (optional('MAXPLAYER_API_URL') || 'https://api.maxplayer.tv/v3/api/public').replace(/\/+$/, ''),
  maxplayerApiKey: optional('MAXPLAYER_API_KEY'),
  maxplayerDomainId: optional('MAXPLAYER_DOMAIN_ID'),
  maxplayerResellerId: optional('MAXPLAYER_RESELLER_ID'),
  // Servidores que alterna «Reparar». Se pueden cambiar por env.
  maxplayerDomainPatoId: optional('MAXPLAYER_DOMAIN_PATO_ID') || '1788037663857452993',
  maxplayerDomainCisneId: optional('MAXPLAYER_DOMAIN_CISNE_ID') || '1761067741584705224',
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
