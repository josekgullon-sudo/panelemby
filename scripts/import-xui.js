// Trae al panel todas las líneas de XUI. No cobra créditos y se puede repetir.
//   npm run import-xui
//   npm run import-xui -- --simular

require('dotenv').config();

const { syncXuiLines } = require('../src/services/xuiSync');

const dryRun = process.argv.includes('--simular');

syncXuiLines({ dryRun })
  .then((summary) => {
    console.log(dryRun ? 'Simulación (no se ha escrito nada)' : 'Sincronización hecha');
    console.log(`Líneas en XUI: ${summary.lines}`);
    console.log(`Nuevas: ${summary.created}`);
    console.log(`Actualizadas: ${summary.updated}`);
    console.log(`Max Player: ${summary.maxplayer}`);
    console.log(`TotalFlix: ${summary.totalflix}`);
    console.log(`Conflictos de usuario: ${summary.conflicts}`);
    if (summary.indexError) {
      console.log(`Aviso Max Player: ${summary.indexError}`);
      console.log('Las líneas se importan igual. El tipo de app no se ha cambiado en las que ya existían.');
    }
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
