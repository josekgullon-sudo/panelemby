// Reaplica en Emby el acceso a bibliotecas correcto según el estado de cada
// cuenta del panel (solo tiene efecto en modo vitrina):
//   - activas   -> todas las bibliotecas menos el cartel de caducados
//   - caducadas -> solo el cartel
// Ejecútalo tras activar el modo vitrina, o cuando añadas/quites bibliotecas
// en Emby (los cambios de bibliotecas no se propagan solos a los usuarios).
//
// Uso: npm run sync-bibliotecas

const config = require('../src/config');
const db = require('../src/db/database');
const emby = require('../src/services/emby');
const accounts = require('../src/services/accounts');

(async () => {
  if (config.expiryMode !== 'vitrina') {
    console.log('EXPIRY_MODE no es "vitrina": no hay nada que sincronizar.');
    return;
  }
  const activePatch = await accounts.activeLibrariesPatch();
  const expiredPatch = await accounts.expiredPolicyPatch();

  const list = db
    .prepare("SELECT id, username, emby_user_id, status FROM emby_accounts WHERE status IN ('active', 'expired')")
    .all();
  console.log(`Cuentas a sincronizar: ${list.length}`);

  let ok = 0;
  let errors = 0;
  for (const account of list) {
    try {
      await emby.updatePolicy(account.emby_user_id, account.status === 'active' ? activePatch : expiredPatch);
      console.log(`  [ok] ${account.username} (${account.status})`);
      ok++;
    } catch (err) {
      console.error(`  [!!] ${account.username}: ${err.message}`);
      errors++;
    }
  }
  console.log(`\nSincronizadas: ${ok} · Errores: ${errors}`);
})().catch((e) => {
  console.error('FALLO:', e.message);
  process.exit(1);
});
