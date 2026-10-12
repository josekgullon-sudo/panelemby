// Comprobación de solo lectura contra XUI.one.
//   node scripts/test-xui.js     o     npm run test-xui
// No crea, edita ni borra líneas. Sirve para lanzarlo en el servidor
// (esta máquina de desarrollo no puede llegar a la IP real).

require('dotenv').config();

const xui = require('../src/services/xui');

async function main() {
  if (!xui.isConfigured()) {
    console.error('Faltan XUI_API_URL y XUI_API_KEY en el .env.');
    process.exit(1);
  }
  const config = require('../src/config');
  console.log(`1. XUI en ${config.xuiApiUrl}`);
  console.log(
    `   TLS: ${config.xuiInsecureTls ? 'SIN verificar certificado (XUI_INSECURE_TLS=1)' : 'certificado verificado'}`
  );
  console.log('2. get_packages (solo lectura) ...');
  const packages = await xui.getPackages();
  console.log(`   OK — ${packages.length} paquetes`);
  for (const pack of packages.slice(0, 20)) {
    const flags = [pack.is_trial ? 'prueba' : 'oficial', pack.max_connections ? `${pack.max_connections} conex.` : null]
      .filter(Boolean)
      .join(', ');
    console.log(`   - [${pack.id}] ${pack.package_name}${flags ? ` (${flags})` : ''}`);
  }
  if (packages.length > 20) console.log(`   ... y ${packages.length - 20} más`);
  console.log('\nTodo correcto: el panel puede leer paquetes de XUI. No se ha creado ninguna línea.');
}

main().catch((err) => {
  console.error(`\nFALLO: ${err.message}`);
  process.exit(1);
});
