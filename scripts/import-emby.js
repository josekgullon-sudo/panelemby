// Importa al panel los usuarios que ya existen en Emby.
//
// Uso:
//   node scripts/import-emby.js --simular         (solo muestra qué haría, no toca nada)
//   node scripts/import-emby.js                   (importa con 30 días por defecto)
//   node scripts/import-emby.js --dias 60         (importa con otra duración)
//
// Reglas:
//   - Los administradores de Emby NO se importan (el cron los desactivaría al caducar).
//   - Usuarios ya presentes en el panel se saltan.
//   - Usuarios desactivados en Emby se importan como 'expired' (siguen desactivados).
//   - Los activos entran con el plan "Mensual · 1 pantalla" y N días desde hoy.
//   - Quedan asignados al admin del panel. No se descuentan créditos.
//   - Su contraseña del panel queda inutilizable hasta que se les cambie desde el
//     panel (Cuentas -> Contraseña), porque Emby no permite leer contraseñas.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const args = process.argv.slice(2);
const dryRun = args.includes('--simular');
const diasIdx = args.indexOf('--dias');
const dias = diasIdx !== -1 ? parseInt(args[diasIdx + 1], 10) : 30;
if (!Number.isInteger(dias) || dias <= 0) {
  console.error('Valor de --dias inválido');
  process.exit(1);
}

const db = require('../src/db/database');
const emby = require('../src/services/emby');
const { toSqlDate } = require('../src/services/accounts');

(async () => {
  const admin = db.prepare("SELECT * FROM panel_users WHERE role = 'admin' AND is_active = 1 LIMIT 1").get();
  if (!admin) {
    console.error('No hay admin en el panel. Crea uno primero con: npm run create-admin');
    process.exit(1);
  }

  const plan = db.prepare("SELECT * FROM plans WHERE name = 'Mensual · 1 pantalla'").get()
    || db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY duration_days LIMIT 1').get();
  if (!plan) {
    console.error('No hay planes en el panel.');
    process.exit(1);
  }

  const raw = await emby.listUsers();
  const users = Array.isArray(raw) ? raw : raw.Items || [];
  console.log(`Usuarios en Emby: ${users.length}`);
  console.log(`Plan asignado: ${plan.name} · caducidad a ${dias} días desde hoy`);
  if (dryRun) console.log('MODO SIMULACIÓN: no se escribirá nada.\n');

  const expiresActive = toSqlDate(new Date(Date.now() + dias * 24 * 3600 * 1000));
  const expiresPast = toSqlDate(new Date());

  const insert = db.prepare(
    `INSERT INTO emby_accounts (emby_user_id, username, password_hash, owner_id, plan_id, expires_at, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'importado de Emby')`
  );

  let imported = 0;
  let skipped = 0;
  let admins = 0;

  for (const u of users) {
    const isAdmin = u.Policy && u.Policy.IsAdministrator;
    const isDisabled = u.Policy && u.Policy.IsDisabled;

    if (isAdmin) {
      admins++;
      console.log(`  [admin ] ${u.Name} — NO se importa (administrador de Emby)`);
      continue;
    }
    const exists = db
      .prepare('SELECT 1 FROM emby_accounts WHERE emby_user_id = ? OR username = ?')
      .get(u.Id, u.Name);
    if (exists) {
      skipped++;
      console.log(`  [ya    ] ${u.Name} — ya está en el panel`);
      continue;
    }

    const status = isDisabled ? 'expired' : 'active';
    const expiresAt = isDisabled ? expiresPast : expiresActive;
    console.log(`  [nuevo ] ${u.Name} — ${status === 'active' ? `activo hasta ${expiresAt.slice(0, 10)}` : 'desactivado en Emby, entra como caducado'}`);

    if (!dryRun) {
      // Hash aleatorio: nadie puede entrar con esta cuenta al panel hasta
      // que se le ponga contraseña desde Cuentas -> Contraseña.
      const unusable = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
      insert.run(u.Id, u.Name, unusable, admin.id, plan.id, expiresAt, status);
    }
    imported++;
  }

  console.log(`\n${dryRun ? 'Se importarían' : 'Importados'}: ${imported} · Ya existentes: ${skipped} · Admins excluidos: ${admins}`);
  if (dryRun) console.log('Ejecuta sin --simular para aplicarlo.');
})().catch((err) => {
  console.error('FALLO:', err.message);
  process.exit(1);
});
