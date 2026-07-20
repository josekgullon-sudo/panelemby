const rateLimit = require('express-rate-limit');

// Anti fuerza bruta en el login: 10 intentos fallidos por IP cada 15 minutos.
// Los logins correctos no cuentan (skipSuccessfulRequests).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('login', {
      error: 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.',
    });
  },
});

module.exports = { loginLimiter };
