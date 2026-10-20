// Prueba de conexión con Emby: node scripts/test-emby.js  (o npm run test-emby)
// Recorre cada servidor configurado. No imprime la API key.
// 1) Comprueba que el servidor responde (endpoint público, sin API key)
// 2) Comprueba que la API key es válida (endpoint autenticado)
// 3) Lista cuántos usuarios hay

require('dotenv').config();

const config = require('../src/config');
const embyServers = require('../src/services/embyServers');

async function probe(server) {
  console.log(`\n${server.name} — ${server.url}`);
  console.log('1. Probando conexión ...');
  const pub = await fetch(`${server.url}/emby/System/Info/Public`, { signal: AbortSignal.timeout(10000) });
  const pubInfo = await pub.json();
  console.log(`   OK — Emby "${pubInfo.ServerName}" versión ${pubInfo.Version}`);

  console.log('2. Probando API key ...');
  const emby = embyServers.clientFor(server.key);
  const info = await emby.getSystemInfo();
  console.log(`   OK — autenticado contra "${info.ServerName}" (id ${info.Id})`);

  const users = await emby.listUsers();
  const list = Array.isArray(users) ? users : users.Items || [];
  console.log(`3. Usuarios actuales: ${list.length}`);
  for (const user of list.slice(0, 10)) {
    console.log(`   - ${user.Name}${user.Policy && user.Policy.IsDisabled ? ' (desactivado)' : ''}`);
  }
  if (list.length > 10) console.log(`   ... y ${list.length - 10} más`);
}

async function main() {
  const servers = config.embyServers || [];
  if (!servers.length) {
    console.error('No hay servidores Emby en el .env');
    process.exit(1);
  }
  for (const server of servers) {
    await probe(server);
  }
  console.log('\nTodo correcto: el panel puede hablar con los servidores Emby configurados.');
}

main().catch((err) => {
  console.error(`\nFALLO: ${err.message}`);
  process.exit(1);
});
