// Busca cuentas importadas cuya caducidad es la hora de importación + 30 días
// y cuya línea XUI no tiene exp_date. No corta ni reactiva nada en XUI.
//   npm run auditar-ilimitadas
//   npm run auditar-ilimitadas -- --simular
//   npm run auditar-ilimitadas -- --aplicar

require('dotenv').config();

const { auditInventedExpiries, formatAuditReport } = require('../src/services/unlimitedAudit');

const apply = process.argv.includes('--aplicar') && !process.argv.includes('--simular');

auditInventedExpiries({ dryRun: !apply })
  .then((summary) => {
    console.log(formatAuditReport(summary));
    if (summary.errors.length) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
