// Relee get_line de las cuentas importadas (4 a la vez, con reintentos).
// Corrige is_trial y deja sin fecha las líneas cuya exp_date viene vacía.
//   npm run rellenar-xui
//   npm run rellenar-xui -- --simular
//   npm run rellenar-xui -- --aplicar

require('dotenv').config();

const { backfillImportedLines, formatBackfillReport } = require('../src/services/xuiBackfill');

const apply = process.argv.includes('--aplicar') && !process.argv.includes('--simular');

backfillImportedLines({ dryRun: !apply, concurrency: 4 })
  .then((summary) => {
    console.log(formatBackfillReport(summary));
    if (summary.errors.length) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
