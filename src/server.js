const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);

const config = require('./config');
const db = require('./db/database');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // por si en producción va detrás de un proxy/nginx

app.use(express.urlencoded({ extended: false }));
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000,
    },
  })
);

// Mensajes flash de un solo uso (se muestran tras un redirect)
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.currentUser = null;
  req.setFlash = (type, message) => {
    req.session.flash = { type, message };
  };
  next();
});

app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/reseller', require('./routes/reseller'));
app.use('/mi-cuenta', require('./routes/client'));

app.use((req, res) => {
  res.status(404).render('error', { code: 404, message: 'Página no encontrada' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { code: 500, message: 'Error interno del servidor' });
});

app.listen(config.port, () => {
  console.log(`Panel Emby escuchando en http://localhost:${config.port}`);
  console.log(`Emby configurado en ${config.embyUrl}`);
});

// El cron de caducidades se engancha aquí cuando exista (src/jobs/expiry.js)
try {
  require('./jobs/expiry').schedule();
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
  console.log('[jobs] expiry.js aún no existe; el cron de caducidades no está activo');
}
