// Crea (o resetea la contraseña de) el usuario admin del panel.
// Uso: node scripts/create-admin.js <usuario> <contraseña>

const bcrypt = require('bcryptjs');

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error('Uso: node scripts/create-admin.js <usuario> <contraseña>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('La contraseña del admin debe tener al menos 8 caracteres.');
  process.exit(1);
}

const db = require('../src/db/database');
const hash = bcrypt.hashSync(password, 12);

const existing = db.prepare('SELECT id, role FROM panel_users WHERE username = ?').get(username);
if (existing) {
  if (existing.role !== 'admin') {
    console.error(`"${username}" ya existe y es ${existing.role}, no admin. Elige otro nombre.`);
    process.exit(1);
  }
  db.prepare('UPDATE panel_users SET password_hash = ?, is_active = 1 WHERE id = ?').run(hash, existing.id);
  console.log(`Contraseña del admin "${username}" actualizada.`);
} else {
  db.prepare("INSERT INTO panel_users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username, hash);
  console.log(`Admin "${username}" creado.`);
}
