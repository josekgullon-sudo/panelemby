require('./env');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const ejs = require('ejs');
const conv = require('../src/services/telegramConversations');

const files = [];

function fixture(setup) {
  const file = path.join(os.tmpdir(), `tg-bot-${process.pid}-${Math.random().toString(16).slice(2)}.sqlite`);
  files.push(file);
  const db = new Database(file);
  setup(db);
  db.close();
  return file;
}

after(() => {
  for (const file of files) {
    conv.closeBot(file);
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

function unixSchema(db) {
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      xui_username TEXT,
      xui_password TEXT,
      created_at INTEGER
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      chat_id INTEGER,
      customer_id INTEGER,
      role TEXT,
      text TEXT,
      created_at INTEGER
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY,
      chat_id INTEGER,
      amount INTEGER,
      status TEXT,
      stripe_secret TEXT,
      created_at INTEGER,
      paid_at INTEGER
    );
    CREATE TABLE trials (
      id INTEGER PRIMARY KEY,
      chat_id INTEGER,
      username TEXT,
      created_at INTEGER
    );
    CREATE TABLE escalations (
      id INTEGER PRIMARY KEY,
      chat_id INTEGER,
      status TEXT,
      created_at INTEGER,
      reason TEXT
    );
  `);
}

test('el día de Madrid cubre invierno, verano y los cambios de hora', () => {
  const summer = conv.madridDayBounds('2026-07-15');
  assert.equal(new Date(summer.startMs).toISOString(), '2026-07-14T22:00:00.000Z');
  assert.equal(new Date(summer.endMs).toISOString(), '2026-07-15T22:00:00.000Z');

  const winter = conv.madridDayBounds('2026-01-15');
  assert.equal(new Date(winter.startMs).toISOString(), '2026-01-14T23:00:00.000Z');
  assert.equal(new Date(winter.endMs).toISOString(), '2026-01-15T23:00:00.000Z');

  const spring = conv.madridDayBounds('2026-03-29');
  assert.equal(new Date(spring.startMs).toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(new Date(spring.endMs).toISOString(), '2026-03-29T22:00:00.000Z');

  const autumn = conv.madridDayBounds('2026-10-25');
  assert.equal(new Date(autumn.startMs).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(new Date(autumn.endMs).toISOString(), '2026-10-25T23:00:00.000Z');

  assert.equal(conv.todayMadrid(new Date('2026-07-14T22:30:00.000Z')), '2026-07-15');
  assert.equal(conv.todayMadrid(new Date('2026-07-14T21:30:00.000Z')), '2026-07-14');
  assert.equal(conv.parseFecha('2026-02-31'), null);
  assert.equal(conv.shiftFecha('2026-07-15', -1), '2026-07-14');
});

test('enmascara contraseñas y secretos de Stripe, y deja el resto del mensaje', () => {
  const masked = conv.maskMessageText(
    'Hola Ana\nUsuario: ana\nContraseña: ClaveLinea999\npassword=otra\npass: hunter2\nLa clave es abc\n¿Cuál es tu password?\ncompass: norte\nsk_live_51AbcDEF\nwhsec_abc123\nrk_test_ZZZ'
  );
  assert.match(masked, /Usuario: ana/);
  assert.match(masked, /Contraseña: \*\*\*/);
  assert.match(masked, /password: \*\*\*/);
  assert.match(masked, /pass: \*\*\*/);
  assert.match(masked, /clave: \*\*\*/);
  assert.match(masked, /¿Cuál es tu password\?/);
  assert.match(masked, /compass: norte/);
  assert.doesNotMatch(masked, /ClaveLinea999|hunter2|sk_live_|whsec_|rk_test_/);
});

test('si falta el fichero no se crea y la pestaña no rompe', () => {
  const missing = path.join(os.tmpdir(), `tg-missing-${process.pid}-${Date.now()}.sqlite`);
  const day = conv.getDay('2026-07-15', { dbPath: missing });
  assert.equal(day.available, false);
  assert.match(day.notice, /No se encuentra/);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(day.conversations.length, 0);
});

test('la base del bot se abre en solo lectura', () => {
  const file = fixture((db) => {
    unixSchema(db);
  });
  const db = conv.openReadOnly(file);
  assert.equal(db.readonly, true);
  assert.equal(db.pragma('query_only', { simple: true }), 1);
  assert.throws(() => {
    db.prepare("INSERT INTO messages (chat_id, role, text, created_at) VALUES (1, 'user', 'no', 1)").run();
  });
  db.close();
});

test('el día resume ventas, pruebas, pagos, escalados y oculta los chats de prueba', () => {
  const { startMs, endMs } = conv.madridDayBounds('2026-07-15');
  const at = (minutes) => Math.floor(startMs / 1000) + minutes * 60;
  const before = Math.floor(startMs / 1000) - 3600;
  const afterEnd = Math.floor(endMs / 1000) + 60;

  const file = fixture((db) => {
    unixSchema(db);
    const customer = db.prepare(
      'INSERT INTO customers (chat_id, username, first_name, last_name, xui_username, xui_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const message = db.prepare('INSERT INTO messages (chat_id, role, text, created_at) VALUES (?, ?, ?, ?)');
    const payment = db.prepare('INSERT INTO payments (chat_id, amount, status, stripe_secret, created_at, paid_at) VALUES (?, ?, ?, ?, ?, ?)');
    const trial = db.prepare('INSERT INTO trials (chat_id, username, created_at) VALUES (?, ?, ?)');
    const escalation = db.prepare('INSERT INTO escalations (chat_id, status, created_at, reason) VALUES (?, ?, ?, ?)');

    customer.run(101, 'ana', 'Ana', 'López', 'linea77', 'ClaveLinea999', at(1));
    customer.run(102, 'bruno', 'Bruno', null, null, null, at(2));
    customer.run(103, 'cesar', 'César', null, null, null, before);
    customer.run(104, 'dina', 'Dina', null, null, null, at(3));
    customer.run(105, 'eva', 'Eva', null, null, null, at(4));
    customer.run(106, 'TotalPlayerTV', 'Dueño', null, 'lineatest', 'NoDebeSalir', at(5));
    customer.run(107, 'gala', 'Gala', null, null, null, before);
    customer.run(108, 'hugo', 'Hugo', null, null, null, at(6));

    const secretLine = 'Contraseña: ClaveLinea999 y sk_live_51Secreto ';
    message.run(101, 'user', 'Hola, quiero una línea', at(30));
    message.run(101, 'assistant', secretLine + 'x'.repeat(500 - secretLine.length), at(40));
    message.run(101, 'user', 'Mensaje de ayer', before);
    message.run(101, 'user', 'Mensaje de mañana', afterEnd);
    message.run(102, 'user', '¿Hay prueba?', at(50));
    message.run(103, 'user', 'Te pago luego', at(60));
    message.run(104, 'user', 'Necesito a una persona', at(70));
    message.run(105, 'user', 'Solo miro', at(80));
    message.run(106, 'user', 'Soy el dueño', at(90));
    message.run(107, 'user', 'Ayer empecé', at(100));
    message.run(108, 'assistant', 'x'.repeat(500), at(110));

    payment.run(101, 1990, 'complete', 'sk_live_ENCOLUMNA', at(20), at(45));
    payment.run(103, 990, 'pending', 'sk_test_NO', at(60), null);
    payment.run(106, 5000, 'complete', 'sk_live_TESTDUENO', at(90), at(95));
    payment.run(107, 1500, 'complete', null, before, at(15));
    payment.run(105, 100, 'complete', null, before, before);

    trial.run(102, 'prueba_bruno', at(55));
    trial.run(101, 'prueba_ana', at(10));
    escalation.run(104, 'open', at(70), 'no entiende el precio');
    escalation.run(105, 'closed', at(80), 'ya resuelto');
    escalation.run(103, 'open', before, 'de ayer');
  });

  const hidden = conv.getDay('2026-07-15', {
    dbPath: file,
    hideTests: true,
    exclude: ['999', '@TotalPlayerTV'],
  });
  assert.equal(hidden.available, true);
  assert.equal(hidden.hiddenTests, 1);
  assert.equal(hidden.summary.newCustomers, 5);
  assert.equal(hidden.summary.trials, 2);
  assert.equal(hidden.summary.sales, 2);
  assert.equal(hidden.summary.salesCents, 1990 + 1500);
  assert.match(hidden.summary.salesLabel, /34,90/);
  assert.match(hidden.summary.salesLabel, /€/);
  assert.equal(hidden.summary.pendingPayments, 1);
  assert.equal(hidden.summary.openEscalations, 1);
  assert.equal(hidden.summary.conversations, 7);

  const byId = new Map(hidden.conversations.map((row) => [row.chatId, row]));
  assert.equal(byId.has('106'), false);
  assert.equal(byId.get('101').outcome, 'venta');
  assert.match(byId.get('101').outcomeDetail, /19,90/);
  assert.match(byId.get('101').outcomeDetail, /linea77/);
  assert.equal(byId.get('101').messageCount, 2);
  assert.equal(byId.get('101').name, 'Ana López');
  assert.equal(byId.get('101').usernameLabel, '@ana');
  assert.equal(byId.get('102').outcome, 'prueba');
  assert.match(byId.get('102').outcomeDetail, /prueba_bruno/);
  assert.equal(byId.get('103').outcome, 'pago_pendiente');
  assert.equal(byId.get('104').outcome, 'escalado');
  assert.equal(byId.get('105').outcome, 'sin_resultado');
  assert.equal(byId.get('107').outcome, 'venta');
  assert.equal(byId.get('108').outcome, 'sin_resultado');

  const dumped = JSON.stringify(hidden);
  assert.equal(dumped.includes('ClaveLinea999'), false);
  assert.equal(dumped.includes('NoDebeSalir'), false);
  assert.equal(dumped.includes('sk_live_'), false);
  assert.equal(dumped.includes('sk_test_'), false);

  const shown = conv.getDay('2026-07-15', {
    dbPath: file,
    hideTests: false,
    exclude: ['@TotalPlayerTV'],
  });
  const own = shown.conversations.find((row) => row.chatId === '106');
  assert.ok(own);
  assert.equal(own.isTest, true);
  assert.equal(shown.summary.sales, 3);

  const early = conv.getDay('2026-07-14', { dbPath: file, hideTests: true, exclude: ['@TotalPlayerTV'] });
  assert.equal(early.summary.sales, 1);
  assert.equal(early.summary.conversations, 3);
  assert.equal(early.conversations.find((row) => row.chatId === '105').outcome, 'venta');

  const thread = conv.getThread('101', { dbPath: file, fecha: '2026-07-15', exclude: [] });
  assert.equal(thread.available, true);
  assert.equal(thread.outcome, 'venta');
  assert.equal(thread.messages.length, 4);
  assert.equal(thread.messages.filter((item) => item.selectedDay).length, 2);
  const bot = thread.messages.find((item) => item.kind === 'bot');
  assert.ok(bot);
  assert.equal(bot.cut, true);
  assert.match(bot.text, /Contraseña: \*\*\*/);
  assert.equal(bot.text.includes('sk_live_'), false);
  assert.equal(JSON.stringify(thread).includes('ClaveLinea999'), false);
  const boundary = thread.messages.find((item) => item.selectedDay && item.kind === 'customer');
  assert.equal(boundary.time, '00:30');
});

test('acepta otro nombre de columna y follow_ups solo si está abierto a soporte', () => {
  const { startMs } = conv.madridDayBounds('2026-07-15');
  const stamp = new Date(startMs + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const file = fixture((db) => {
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        telegram_chat_id TEXT,
        telegram_username TEXT,
        full_name TEXT,
        line_username TEXT,
        joined_at TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        telegram_chat_id TEXT,
        sender TEXT,
        content TEXT,
        sent_at TEXT,
        responder TEXT
      );
      CREATE TABLE payments (
        id INTEGER PRIMARY KEY,
        telegram_chat_id TEXT,
        amount_cents INTEGER,
        status TEXT,
        created_at TEXT,
        completed_at TEXT
      );
      CREATE TABLE follow_ups (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER,
        status TEXT,
        created_at TEXT
      );
    `);
    db.prepare(
      'INSERT INTO customers (telegram_chat_id, telegram_username, full_name, line_username, joined_at) VALUES (?, ?, ?, ?, ?)'
    ).run('501', 'nora', 'Nora', 'lineanora', stamp);
    db.prepare(
      'INSERT INTO customers (telegram_chat_id, telegram_username, full_name, joined_at) VALUES (?, ?, ?, ?)'
    ).run('502', 'oleo', 'Oleo', stamp);
    db.prepare(
      'INSERT INTO messages (telegram_chat_id, sender, content, sent_at, responder) VALUES (?, ?, ?, ?, ?)'
    ).run('501', 'user', 'Quiero comprar', stamp, null);
    db.prepare(
      'INSERT INTO messages (telegram_chat_id, sender, content, sent_at, responder) VALUES (?, ?, ?, ?, ?)'
    ).run('501', 'assistant', 'Te paso el enlace', stamp, 'jose');
    db.prepare(
      'INSERT INTO messages (telegram_chat_id, sender, content, sent_at) VALUES (?, ?, ?, ?)'
    ).run('502', 'user', 'sigo', stamp);
    db.prepare(
      'INSERT INTO payments (telegram_chat_id, amount_cents, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?)'
    ).run('501', 2500, 'COMPLETE', stamp, stamp);
    db.prepare('INSERT INTO follow_ups (chat_id, status, created_at) VALUES (?, ?, ?)').run(501, 'pending', stamp);
    db.prepare('INSERT INTO follow_ups (chat_id, status, created_at) VALUES (?, ?, ?)').run(502, 'open', stamp);
  });

  const day = conv.getDay('2026-07-15', { dbPath: file, hideTests: true, exclude: [] });
  assert.equal(day.summary.sales, 1);
  assert.equal(day.summary.salesCents, 2500);
  assert.equal(day.summary.openEscalations, 1);
  assert.equal(day.summary.newCustomers, 2);
  const nora = day.conversations.find((row) => row.chatId === '501');
  assert.equal(nora.outcome, 'venta');
  assert.match(nora.outcomeDetail, /lineanora/);
  assert.equal(nora.name, 'Nora');
  const oleo = day.conversations.find((row) => row.chatId === '502');
  assert.equal(oleo.outcome, 'escalado');

  const thread = conv.getThread('501', { dbPath: file, fecha: '2026-07-15' });
  assert.equal(thread.messages[0].kind, 'customer');
  assert.equal(thread.messages[1].kind, 'admin');
  assert.match(thread.messages[1].who, /jose/);
});

test('sin tabla de mensajes avisa y una base vacía de esas tablas no cuenta de más', () => {
  const bare = fixture((db) => {
    db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, chat_id INTEGER)');
  });
  const missing = conv.getDay('2026-07-15', { dbPath: bare });
  assert.equal(missing.available, false);
  assert.match(missing.notice, /messages/);

  const quiet = fixture((db) => unixSchema(db));
  const day = conv.getDay('2026-07-15', { dbPath: quiet });
  assert.equal(day.available, true);
  assert.equal(day.summary.conversations, 0);
  assert.equal(day.summary.sales, 0);
  assert.equal(day.summary.trials, 0);
  assert.equal(day.gapNote, null);
});

test('la pestaña solo está en el menú de admin y el chat escapa el HTML', async () => {
  const view = path.join(__dirname, '../src/views/admin/conversaciones.ejs');
  const threadView = path.join(__dirname, '../src/views/admin/conversacion.ejs');
  const day = {
    available: true,
    notice: null,
    hiddenTests: 0,
    excludeConfigured: true,
    gapNote: null,
    summary: {
      conversations: 1,
      newCustomers: 0,
      trials: 0,
      sales: 1,
      salesCents: 1990,
      salesLabel: '19,90 €',
      pendingPayments: 0,
      openEscalations: 0,
    },
    conversations: [{
      chatId: '101',
      name: 'Ana',
      username: 'ana',
      usernameLabel: '@ana',
      messageCount: 2,
      when: '00:30 – 00:40',
      isTest: false,
      outcome: 'venta',
      outcomeLabel: 'Venta',
      outcomeDetail: '19,90 € · linea77',
      badgeClass: 'badge badge-ok badge-wrap',
    }],
  };
  const locals = {
    flash: null,
    fecha: '2026-07-15',
    ocultar: true,
    day,
    today: '2026-07-15',
    prevFecha: '2026-07-14',
    nextFecha: '2026-07-16',
  };
  const adminHtml = await ejs.renderFile(view, { ...locals, currentUser: { username: 'admin', role: 'admin', credits: 0 } });
  const adminNav = adminHtml.split('<nav class="side-nav"')[1].split('</nav>')[0];
  assert.match(adminNav, /href="\/admin\/conversaciones"/);
  assert.match(adminHtml, /19,90 € · linea77/);

  const resellerHtml = await ejs.renderFile(view, { ...locals, currentUser: { username: 'reventa', role: 'reseller', credits: 3 } });
  const resellerNav = resellerHtml.split('<nav class="side-nav"')[1].split('</nav>')[0];
  assert.doesNotMatch(resellerNav, /conversaciones/);
  assert.match(resellerNav, /\/reseller/);

  const threadHtml = await ejs.renderFile(threadView, {
    flash: null,
    fecha: '2026-07-15',
    ocultar: true,
    currentUser: { username: 'admin', role: 'admin', credits: 0 },
    thread: {
      available: true,
      name: 'Ana',
      username: 'ana',
      usernameLabel: '@ana',
      chatId: '101',
      outcomeLabel: 'Venta',
      outcomeDetail: '19,90 €',
      badgeClass: 'badge badge-ok',
      xuiUsername: 'linea77',
      isTest: false,
      hitLimit: false,
      hint: 'Los mensajes del bot se guardan recortados a 500 caracteres.',
      messages: [{
        kind: 'customer',
        who: 'Cliente',
        text: '<script>alert(1)</script>',
        time: '00:30',
        dateKey: '2026-07-15',
        dateLabel: '15 jul 2026',
        selectedDay: true,
        cut: false,
      }],
    },
  });
  assert.match(threadHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(threadHtml, /<script>alert/);
});

test('sin @username sale el nombre y la venta confirmada de 59,99 € cae el 1 de noviembre', () => {
  const file = fixture((db) => {
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        username TEXT,
        name TEXT,
        first_name TEXT,
        last_name TEXT,
        nombre TEXT,
        xui_user TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER,
        role TEXT,
        text TEXT,
        created_at TEXT
      );
      CREATE TABLE payments (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        amount REAL,
        status TEXT,
        created_at TEXT,
        confirmed_at TEXT
      );
      CREATE TABLE trials (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER,
        created_at TEXT
      );
      CREATE TABLE escalations (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER,
        status TEXT,
        created_at TEXT
      );
    `);
    db.prepare(
      `INSERT INTO customers (user_id, username, name, first_name, last_name, nombre, xui_user)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(857995722, null, null, 'ana', 'ruiz marcos', null, 'Anuska1796');
    db.prepare(
      `INSERT INTO customers (user_id, username, name, first_name, last_name, nombre)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(857995723, null, null, null, null, 'luis garcía');
    db.prepare(
      `INSERT INTO customers (user_id, username, first_name) VALUES (?, ?, ?)`
    ).run(857995724, null, 'Pablo');
    db.prepare(
      'INSERT INTO messages (chat_id, role, text, created_at) VALUES (?, ?, ?, ?)'
    ).run(857995722, 'user', 'Ya pagué', '2026-11-01 10:00:00');
    db.prepare(
      'INSERT INTO messages (chat_id, role, text, created_at) VALUES (?, ?, ?, ?)'
    ).run(857995723, 'user', 'Hola', '2026-11-01 11:00:00');
    db.prepare(
      'INSERT INTO messages (chat_id, role, text, created_at) VALUES (?, ?, ?, ?)'
    ).run(857995724, 'user', 'Otro pago', '2026-11-01 12:00:00');
    // 59.99 es euros. confirmed_at en UTC cae a las 00:30 del 1 de noviembre en Madrid.
    db.prepare(
      'INSERT INTO payments (user_id, amount, status, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(857995722, 59.99, 'confirmed', '2026-10-31 18:00:00', '2026-10-31 23:30:00');
    // 5999 entero sigue siendo céntimos.
    db.prepare(
      'INSERT INTO payments (user_id, amount, status, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(857995724, 5999, 'paid', '2026-11-01 12:00:00', '2026-11-01 12:00:00');
  });

  const day = conv.getDay('2026-11-01', { dbPath: file, hideTests: true, exclude: [] });
  assert.equal(day.available, true);
  assert.equal(day.summary.sales, 2);
  assert.equal(day.summary.salesCents, 5999 + 5999);
  assert.match(day.summary.salesLabel, /119,98/);

  const ana = day.conversations.find((row) => row.chatId === '857995722');
  assert.ok(ana);
  assert.equal(ana.name, 'ana ruiz marcos');
  assert.equal(ana.username, '');
  assert.equal(ana.outcome, 'venta');
  assert.match(ana.outcomeDetail, /59,99/);
  assert.match(ana.outcomeDetail, /Anuska1796/);
  assert.equal(ana.name.includes('857995722'), false);

  const luis = day.conversations.find((row) => row.chatId === '857995723');
  assert.equal(luis.name, 'luis garcía');
  assert.equal(luis.outcome, 'sin_resultado');

  const pablo = day.conversations.find((row) => row.chatId === '857995724');
  assert.equal(pablo.name, 'Pablo');
  assert.equal(pablo.outcome, 'venta');
  assert.match(pablo.outcomeDetail, /59,99/);

  const previous = conv.getDay('2026-10-31', { dbPath: file, hideTests: true, exclude: [] });
  assert.equal(previous.summary.sales, 0);

  const thread = conv.getThread('857995722', { dbPath: file, fecha: '2026-11-01', exclude: [] });
  assert.equal(thread.name, 'ana ruiz marcos');
  assert.equal(thread.outcome, 'venta');
  assert.match(thread.outcomeDetail, /Anuska1796/);
});
