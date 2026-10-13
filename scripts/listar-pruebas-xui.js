// Lista líneas creadas en el panel que aquí son de pago (is_trial=0)
// y en XUI tienen is_trial=1. No edita líneas ni escribe en la base.
//   npm run listar-pruebas-xui

require('dotenv').config();

const { listPaidLinesFlaggedTrial, formatTrialAudit } = require('../src/services/xuiTrialAudit');

if (process.argv.includes('--aplicar') || process.argv.includes('--simular')) {
  console.error('Este script solo lista. No escribe en XUI ni en el panel.');
}

listPaidLinesFlaggedTrial({ concurrency: 4 })
  .then((summary) => {
    console.log(formatTrialAudit(summary));
    if (summary.errors.length) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
