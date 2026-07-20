// Lanza a mano una pasada del proceso de caducidades (sin esperar al cron).
// Uso: npm run expiry
require('../src/jobs/expiry')
  .run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
