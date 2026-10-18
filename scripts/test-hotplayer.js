// Comprobación de solo lectura contra HotPlayer.
//   node scripts/test-hotplayer.js     o     npm run test-hotplayer
// Llama a GET /balance. No carga listas, no activa y no borra.
// No imprime la API key ni credenciales.

require('dotenv').config();

const config = require('../src/config');
const hotplayer = require('../src/services/hotplayer');

async function main() {
  if (!hotplayer.hasCredentials()) {
    console.error('Falta HOTPLAYER_API_KEY en el .env.');
    process.exit(1);
  }
  console.log(`1. HotPlayer en ${config.hotplayerApiUrl}`);
  console.log(`   dominio de las listas: ${config.hotplayerDomain}:${config.hotplayerPort}`);

  console.log('2. GET /balance ...');
  const balance = await hotplayer.getBalance();
  console.log(`   OK — saldo ${balance.balance}`);

  console.log('\nTodo correcto: el panel puede leer HotPlayer. No se ha cargado ninguna lista.');
}

main().catch((err) => {
  console.error(`\nFALLO: ${err.message}`);
  process.exit(1);
});
