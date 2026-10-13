// Trae al panel todas las líneas de XUI. No cobra créditos y se puede repetir.
//   npm run import-xui
//   npm run import-xui -- --simular

require('dotenv').config();

const { syncXuiLines, formatSyncReport } = require('../src/services/xuiSync');

const dryRun = process.argv.includes('--simular');

syncXuiLines({ dryRun })
  .then((summary) => {
    console.log(formatSyncReport(summary));
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
