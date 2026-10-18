// Proceso de caducidades. En cada sistema donde la cuenta exista:
//   1. Cada servicio vencido se corta solo. Antes, get_line: si XUI tiene fecha
//      futura se adopta y no se corta.
//   1b. Las ya cortadas o caducadas también se leen. Fecha futura y línea activa:
//       se adopta. Línea parada con fecha futura: edit_line completo y se adopta.
//       Este paso no borra.
//   2. Un servicio con fecha futura se reactiva; el que sigue cortado no se toca.
//   3. 'expired' desde hace más de DELETE_AFTER_DAYS días (fecha más tardía) -> borrar (si > 0)
// Max Player no tiene "desactivar": al caducar se corta la línea XUI, que es la lista.
// Se ejecuta con el cron configurado y también una vez al arrancar el servidor
// (por si estuvo apagado a la hora del cron).

const cron = require('node-cron');
const config = require('../config');
const db = require('../db/database');
const { deleteEverywhere, expireRemotes, restoreRemotes, clockFrom, adoptRemoteXuiExpiry, driftedXuiAccounts } = require('../services/accounts');

function utcNowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function run() {
  const started = Date.now();
  let disabled = 0;
  let synced = 0;
  let reenabled = 0;
  let deleted = 0;
  let errors = 0;

  // 1) Cada servicio caduca por su fecha. Una cuenta sin fecha (línea XUI
  // ilimitada, expires_at y xui_expires_at a NULL) no entra en esta pasada.
  const due = db
    .prepare(
      `SELECT * FROM emby_accounts WHERE status != 'deleted' AND (
         (emby_user_id IS NOT NULL AND emby_cut = 0 AND emby_expires_at IS NOT NULL AND emby_expires_at <= datetime('now'))
         OR (xui_line_id IS NOT NULL AND xui_cut = 0 AND xui_expires_at IS NOT NULL AND xui_expires_at <= datetime('now'))
       )`
    )
    .all();
  for (const account of due) {
    try {
      const now = utcNowSql();
      const embyDue = account.emby_user_id && !account.emby_cut && account.emby_expires_at && account.emby_expires_at <= now;
      let xuiDue = account.xui_line_id && !account.xui_cut && account.xui_expires_at && account.xui_expires_at <= now;
      if (!embyDue && !xuiDue) continue;
      if (xuiDue && await adoptRemoteXuiExpiry(account)) {
        synced += 1;
        xuiDue = false;
      }
      let cut = false;
      if (embyDue) {
        cut = true;
        await expireRemotes(Object.assign({}, account, { xui_line_id: null, maxplayer_user_id: null }));
        db.prepare('UPDATE emby_accounts SET emby_cut = 1 WHERE id = ?').run(account.id);
      }
      if (xuiDue) {
        cut = true;
        await expireRemotes(Object.assign({}, account, { emby_user_id: null }));
        db.prepare('UPDATE emby_accounts SET xui_cut = 1 WHERE id = ?').run(account.id);
      }
      const fresh = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(account.id);
      const clock = clockFrom(fresh);
      db.prepare(
        `UPDATE emby_accounts SET expires_at = COALESCE(?, expires_at), status = CASE
           WHEN status = 'active'
             AND (emby_user_id IS NOT NULL OR xui_line_id IS NOT NULL)
             AND (emby_user_id IS NULL OR emby_cut = 1)
             AND (xui_line_id IS NULL OR xui_cut = 1)
           THEN 'expired' ELSE status END
         WHERE id = ?`
      ).run(clock || null, account.id);
      if (cut) disabled++;
    } catch (err) {
      errors++;
      console.error(`[expiry] No se pudo desactivar ${account.username}: ${err.message}`);
    }
  }

  // 1b) Cuentas que el panel ya cortó o marcó caducadas. get_line puede traer
  // una renovación hecha en XUI. Este paso no borra: el borrado es el paso 3
  // y solo corre si DELETE_AFTER_DAYS es mayor que 0.
  const drifted = driftedXuiAccounts();
  for (const account of drifted) {
    try {
      if (await adoptRemoteXuiExpiry(account)) synced += 1;
    } catch (err) {
      errors++;
      console.error(`[expiry] No se pudo leer XUI de ${account.username}: ${err.message}`);
    }
  }

  // 2) Reactivar el servicio cuya fecha volvió al futuro. El otro, si sigue cortado, no se toca.
  const toReactivate = db
    .prepare(
      `SELECT * FROM emby_accounts WHERE status = 'expired' AND (
         (emby_user_id IS NOT NULL AND emby_expires_at > datetime('now'))
         OR (xui_line_id IS NOT NULL AND xui_expires_at > datetime('now'))
         OR (emby_user_id IS NULL AND xui_line_id IS NULL AND expires_at > datetime('now'))
       )`
    )
    .all();
  for (const account of toReactivate) {
    try {
      const now = utcNowSql();
      if (account.emby_user_id && account.emby_expires_at && account.emby_expires_at > now) account.emby_cut = 0;
      if (account.xui_line_id && account.xui_expires_at && account.xui_expires_at > now) account.xui_cut = 0;
      await restoreRemotes(account);
      db.prepare(
        `UPDATE emby_accounts SET status = 'active',
           emby_cut = CASE WHEN emby_user_id IS NOT NULL AND emby_expires_at > datetime('now') THEN 0 ELSE emby_cut END,
           xui_cut = CASE WHEN xui_line_id IS NOT NULL AND xui_expires_at > datetime('now') THEN 0 ELSE xui_cut END
         WHERE id = ?`
      ).run(account.id);
      const fresh = db.prepare('SELECT * FROM emby_accounts WHERE id = ?').get(account.id);
      const clock = clockFrom(fresh);
      if (clock) db.prepare('UPDATE emby_accounts SET expires_at = ? WHERE id = ?').run(clock, account.id);
      reenabled++;
    } catch (err) {
      errors++;
      console.error(`[expiry] No se pudo reactivar ${account.username}: ${err.message}`);
    }
  }

  // 3) Borrado definitivo tras N días desde la fecha más tardía de los dos servicios.
  if (config.deleteAfterDays > 0) {
    const toDelete = db
      .prepare(
        `SELECT * FROM emby_accounts
         WHERE status = 'expired' AND COALESCE(
           CASE
             WHEN emby_expires_at IS NOT NULL AND xui_expires_at IS NOT NULL
               THEN max(emby_expires_at, xui_expires_at)
             ELSE COALESCE(emby_expires_at, xui_expires_at)
           END,
           expires_at
         ) <= datetime('now', ?)`
      )
      .all(`-${config.deleteAfterDays} days`);
    for (const account of toDelete) {
      try {
        await deleteEverywhere(account);
        deleted++;
      } catch (err) {
        errors++;
        console.error(`[expiry] No se pudo borrar ${account.username}: ${err.message}`);
      }
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[expiry] Completado en ${secs}s: ${disabled} desactivadas, ${synced} actualizadas desde XUI, ${reenabled} reactivadas, ${deleted} borradas, ${errors} errores`
  );
  return { disabled, reenabled, deleted, errors, synced };
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
