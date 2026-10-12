// Comprobación de solo lectura contra Max Player.
//   node scripts/test-maxplayer.js     o     npm run test-maxplayer
// Llama a GET /info y a una página de GET /users. No crea ni borra usuarios.
// No imprime contraseñas ni datos de playlist.

require('dotenv').config();

const config = require('../src/config');
const maxplayer = require('../src/services/maxplayer');

async function main() {
  if (!maxplayer.hasCredentials()) {
    console.error('Falta MAXPLAYER_API_KEY en el .env.');
    process.exit(1);
  }
  console.log(`1. Max Player en ${config.maxplayerApiUrl}`);
  if (!config.maxplayerDomainId) {
    console.log('   Aviso: falta MAXPLAYER_DOMAIN_ID. Leer funciona; crear usuarios no.');
  } else {
    console.log(`   domain_id configurado: ${config.maxplayerDomainId}`);
  }

  console.log('2. GET /info ...');
  const info = await maxplayer.getInfo();
  const name = info && (info.name || info.provider || info.username);
  const users = info && (info.users ?? info.user_count);
  const maxUsers = info && (info.max_users ?? info.maxUsers);
  console.log(
    `   OK — ${name ? `cuenta "${name}"` : 'autenticado'}` +
      (users != null ? `, usuarios ${users}` : '') +
      (maxUsers != null ? ` / ${maxUsers}` : '')
  );

  console.log('3. GET /users?limit=1 ...');
  const page = await maxplayer.listUsers({ limit: 1 });
  const list = Array.isArray(page) ? page : (page && page.users) || [];
  console.log(`   OK — la API de usuarios responde (${list.length} en esta página)`);
  for (const user of list) {
    console.log(`   - id ${user.id || user.user_id || '?'}${user.username ? ` · ${user.username}` : ''}`);
  }

  console.log('\nTodo correcto: el panel puede leer Max Player. No se ha creado ningún usuario.');
}

main().catch((err) => {
  console.error(`\nFALLO: ${err.message}`);
  process.exit(1);
});
