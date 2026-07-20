// Proceso diario de caducidades. Tres pasadas:
//   1. Cuentas activas con fecha vencida  -> IsDisabled=true en Emby + status 'expired'
//   2. Cuentas 'expired' con fecha futura -> renovadas por otra vía; reactivar (red de seguridad)
//   3. Cuentas 'expired' desde hace más de DELETE_AFTER_DAYS días -> borrar de Emby (si > 0)
// Se ejecuta con el cron configurado y también una vez al arrancar el servidor
// (por si estuvo apagado a la hora del cron).

const cron = require('node-cron');
const config = require('../config');
const db = require('../db/database');
const emby = require('../services/emby');
const { markDeleted, expiredPolicyPatch, restoredPolicyPatch } = require('../services/accounts');

async function run() {
  const started = Date.now();
  let disabled = 0;
  let reenabled = 0;
  let deleted = 0;
  let errors = 0;

  // 1) Desactivar caducadas
  const toExpire = db
    .prepare("SELECT * FROM emby_accounts WHERE status = 'active' AND expires_at <= datetime('now')")
    .all();
  for (const account of toExpire) {
    try {
      await emby.updatePolicy(account.emby_user_id, await expiredPolicyPatch());
      db.prepare("UPDATE emby_accounts SET status = 'expired' WHERE id = ?").run(account.id);
      disabled++;
    } catch (err) {
      errors++;
      console.error(`[expiry] No se pudo desactivar ${account.username}: ${err.message}`);
    }
  }

  // 2) Reactivar las que figuran caducadas pero tienen fecha futura
  const toReactivate = db
    .prepare("SELECT * FROM emby_accounts WHERE status = 'expired' AND expires_at > datetime('now')")
    .all();
  for (const account of toReactivate) {
    try {
      await emby.updatePolicy(account.emby_user_id, await restoredPolicyPatch());
      db.prepare("UPDATE emby_accounts SET status = 'active' WHERE id = ?").run(account.id);
      reenabled++;
    } catch (err) {
      errors++;
      console.error(`[expiry] No se pudo reactivar ${account.username}: ${err.message}`);
    }
  }

  // 3) Borrado definitivo tras N días caducada (opcional)
  if (config.deleteAfterDays > 0) {
    const toDelete = db
      .prepare(
        `SELECT * FROM emby_accounts
         WHERE status = 'expired' AND expires_at <= datetime('now', ?)`
      )
      .all(`-${config.deleteAfterDays} days`);
    for (const account of toDelete) {
      try {
        await emby.deleteUser(account.emby_user_id).catch((err) => {
          if (err.status !== 404) throw err; // si Emby ya no la tiene, seguimos
        });
        markDeleted(account.id);
        deleted++;
      } catch (err) {
        errors++;
        console.error(`[expiry] No se pudo borrar ${account.username}: ${err.message}`);
      }
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[expiry] Completado en ${secs}s: ${disabled} desactivadas, ${reenabled} reactivadas, ${deleted} borradas, ${errors} errores`
  );
  return { disabled, reenabled, deleted, errors };
}

function schedule() {
  if (!cron.validate(config.expiryCron)) {
    console.error(`[expiry] EXPIRY_CRON inválido: "${config.expiryCron}". El cron NO está activo.`);
    return;
  }
  cron.schedule(config.expiryCron, () => {
    run().catch((err) => console.error('[expiry] Fallo inesperado:', err));
  });
  console.log(`[expiry] Cron activo (${config.expiryCron}); pasada inicial en 15 segundos`);
  // Pasada al arrancar, con margen para que el servidor termine de levantar
  setTimeout(() => {
    run().catch((err) => console.error('[expiry] Fallo inesperado en la pasada inicial:', err));
  }, 15000);
}

module.exports = { run, schedule };
