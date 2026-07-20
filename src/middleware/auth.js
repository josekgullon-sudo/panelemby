const db = require('../db/database');

// La sesión guarda { kind: 'panel'|'client', id, role }.
// En cada petición se recarga el usuario desde la BD: así una suspensión
// o un cambio de créditos surte efecto inmediato, sin esperar a re-login.

function requirePanelRole(...roles) {
  return (req, res, next) => {
    const s = req.session.user;
    if (!s || s.kind !== 'panel' || !roles.includes(s.role)) {
      return res.redirect('/login');
    }
    const user = db.prepare('SELECT * FROM panel_users WHERE id = ? AND is_active = 1 AND role = ?').get(s.id, s.role);
    if (!user) {
      req.session.destroy(() => {});
      return res.redirect('/login');
    }
    req.user = user;
    res.locals.currentUser = { username: user.username, role: user.role, credits: user.credits };
    next();
  };
}

function requireClient(req, res, next) {
  const s = req.session.user;
  if (!s || s.kind !== 'client') {
    return res.redirect('/login');
  }
  const account = db.prepare("SELECT * FROM emby_accounts WHERE id = ? AND status != 'deleted'").get(s.id);
  if (!account) {
    req.session.destroy(() => {});
    return res.redirect('/login');
  }
  req.account = account;
  res.locals.currentUser = { username: account.username, role: 'client' };
  next();
}

module.exports = { requirePanelRole, requireClient };
