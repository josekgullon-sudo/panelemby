// Variables mínimas para poder cargar config.js sin un .env real.
// Cada proceso de test usa su propio SQLite (el pid cambia por fichero).
const os = require('os');
const path = require('path');

function fill(name, value) {
  // Siempre, no solo si falta: el proceso puede traer el .env del panel
  // (demo local) y los tests tienen que ir contra sus propios valores.
  process.env[name] = value;
}

fill('EMBY_URL', 'http://127.0.0.1:8096');
fill('EMBY_API_KEY', 'test-emby-key');
fill('EMBY_PUBLIC_URL', 'http://emby.example');
fill('SESSION_SECRET', 'test-session-secret-value');
fill('EXPIRY_MODE', 'disable');
fill('XUI_API_URL', 'https://xui.test/access');
fill('XUI_API_KEY', 'test-xui-key');
fill('XUI_ALLOWED_OUTPUTS', '');
fill('XUI_PUBLIC_URL', 'http://iptv.test:8080');
fill('MAXPLAYER_API_URL', 'https://mp.test/v3/api/public');
fill('MAXPLAYER_API_KEY', 'test-mp-key');
fill('MAXPLAYER_DOMAIN_ID', '9');
fill('DB_PATH', path.join(os.tmpdir(), `panel-test-${process.pid}.sqlite`));
