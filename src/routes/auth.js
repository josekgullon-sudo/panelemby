const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { loginLimiter } = require('../middleware/rateLimit');

const router = express.Router();

function homeFor(sessionUser) {
  if (!sessionUser) return '/login';
  if (sessionUser.kind === 'client') return '/mi-cuenta';
  return sessionUser.role === 'admin' ? '/admin' : '/reseller';
}

router.get('/', (req, res) => {
  res.redirect(homeFor(req.session.user));
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(homeFor(req.session.user));
  res.render('login', { error: null });
});

// Un único formulario de login para los tres roles:
// primero se busca en panel_users (admin/reseller) y luego en emby_accounts (cliente).
router.post('/login', loginLimiter, (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (!username || !password) {
    return res.status(400).render('login', { error: 'Usuario y contraseña son obligatorios' });
  }

  const panelUser = db.prepare('SELECT * FROM panel_users WHERE username = ? AND is_active = 1').get(username);
  if (panelUser && bcrypt.compareSync(password, panelUser.password_hash)) {
    req.session.regenerate((err) => {
      if (err) return res.status(500).render('login', { error: 'Error de sesión, inténtalo de nuevo' });
      req.session.user = { kind: 'panel', id: panelUser.id, role: panelUser.role };
      res.redirect(panelUser.role === 'admin' ? '/admin' : '/reseller');
    });
    return;
  }

  const account = db.prepare("SELECT * FROM emby_accounts WHERE username = ? AND status != 'deleted'").get(username);
  if (account && bcrypt.compareSync(password, account.password_hash)) {
    req.session.regenerate((err) => {
      if (err) return res.status(500).render('login', { error: 'Error de sesión, inténtalo de nuevo' });
      req.session.user = { kind: 'client', id: account.id };
      res.redirect('/mi-cuenta');
    });
    return;
  }

  res.status(401).render('login', { error: 'Usuario o contraseña incorrectos' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
