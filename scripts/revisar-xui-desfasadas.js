// Revisa cuentas que el panel tiene cortadas o caducadas y las compara con get_line.
// Por defecto es una prueba: no escribe en XUI ni en el panel, y nunca borra.
//
//   node scripts/revisar-xui-desfasadas.js
//   node scripts/revisar-xui-desfasadas.js --aplicar
//
// No lo ejecutes con --aplicar hasta revisar la lista. DELETE_AFTER_DAYS=0
// deja el borrado automático parado; este script no borra en ningún caso.

require('dotenv').config();

const config = require('../src/config');
const accounts = require('../src/services/accounts');

function describe(result) {
  if (result.action === 'adopt') return 'adoptar fecha y dejar activa (XUI ya está encendida)';
  if (result.action === 'enable') return 'reactivar con edit_line y adoptar la fecha';
  if (result.action === 'past') return 'XUI sigue caducada: no se toca';
  if (result.action === 'skip') return 'sin línea';
  return result.action || 'sin cambios';
}

async function main() {
  const apply = process.argv.includes('--aplicar');
  const rows = accounts.driftedXuiAccounts();
  console.log(`DELETE_AFTER_DAYS=${config.deleteAfterDays}. Este script no borra cuentas.`);
  if (config.deleteAfterDays === 0) {
    console.log('El borrado automático está parado.');
  } else {
    console.log('El cron sí puede borrar caducadas viejas. Esta revisión no lo hace.');
  }
  console.log(apply ? 'Modo aplicar.' : 'Modo prueba: no se cambia nada.');
  console.log(`Cuentas cortadas o caducadas con línea XUI: ${rows.length}`);

  let adopt = 0;
  let enable = 0;
  let past = 0;
  let failed = 0;
  for (const account of rows) {
    try {
      const result = await accounts.reconcileAccountXui(account, { apply });
      if (result.action === 'adopt') adopt += 1;
      else if (result.action === 'enable') enable += 1;
      else past += 1;
      const when = result.xuiExpiresAt || (result.action === 'past' ? 'fecha pasada' : 'sin caducidad');
      console.log(`- ${account.username} (${account.xui_line_id}): ${describe(result)} · ${when}`);
    } catch (err) {
      failed += 1;
      console.log(`- ${account.username} (${account.xui_line_id}): no se pudo leer (${err.message})`);
    }
  }
  console.log(`Resumen: ${adopt} a adoptar, ${enable} a reactivar, ${past} siguen caducadas, ${failed} sin lectura.`);
  if (!apply) console.log('No se ha aplicado ningún cambio.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
