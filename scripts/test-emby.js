// Prueba de conexión con Emby: node scripts/test-emby.js  (o npm run test-emby)
// 1) Comprueba que el servidor responde (endpoint público, sin API key)
// 2) Comprueba que la API key es válida (endpoint autenticado)
// 3) Lista cuántos usuarios hay

require('dotenv').config();

const baseUrl = (process.env.EMBY_URL || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('Falta EMBY_URL en el .env');
  process.exit(1);
}

async function main() {
  // Paso 1: endpoint público
  console.log(`1. Probando conexión con ${baseUrl} ...`);
  const pub = await fetch(`${baseUrl}/emby/System/Info/Public`, { signal: AbortSignal.timeout(10000) });
  const pubInfo = await pub.json();
  console.log(`   OK — Emby "${pubInfo.ServerName}" versión ${pubInfo.Version}`);

  // Paso 2: endpoint autenticado
  const apiKey = process.env.EMBY_API_KEY;
  if (!apiKey || apiKey.includes('PON_AQUI')) {
    console.log('2. EMBY_API_KEY no está configurada en el .env — pon tu API key y vuelve a ejecutar.');
    process.exit(1);
  }
  console.log('2. Probando API key ...');
  const emby = require('../src/services/emby');
  const info = await emby.getSystemInfo();
  console.log(`   OK — autenticado contra "${info.ServerName}" (id ${info.Id})`);

  // Paso 3: listar usuarios
  const users = await emby.listUsers();
  const list = Array.isArray(users) ? users : users.Items || [];
  console.log(`3. Usuarios actuales en Emby: ${list.length}`);
  for (const u of list.slice(0, 10)) {
    console.log(`   - ${u.Name}${u.Policy && u.Policy.IsDisabled ? ' (desactivado)' : ''}`);
  }
  if (list.length > 10) console.log(`   ... y ${list.length - 10} más`);

  console.log('\nTodo correcto: el panel puede hablar con Emby.');
}

main().catch((err) => {
  console.error(`\nFALLO: ${err.message}`);
  process.exit(1);
});
