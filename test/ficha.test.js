require('./env');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('path');

const views = path.join(__dirname, '..', 'src', 'views');

function account(extra) {
  return Object.assign(
    {
      id: 9,
      username: 'cliente.uno',
      status: 'active',
      owner_name: 'milu',
      created_at: '2026-01-01 00:00:00',
      plan: 'Mensual',
      plan_id: 1,
      screens: 1,
      plan_screens: 1,
      emby_user_id: 'e1',
      has_emby: 1,
      emby_expires_at: '2026-02-01 00:00:00',
      emby_cut: 0,
      xui_line_id: 'line-1',
      player_kind: 'maxplayer',
      xui_expires_at: '2026-02-01 00:00:00',
      xui_cut: 0,
      xui_package_name: 'Full',
      maxplayer_user_id: 'mp-1',
      maxplayer_list_ok: 1,
      maxplayer_domain_id: null,
      hotplayer_mac: null,
      hotplayer_ok: 0,
      notes: null,
      provision_error: null,
    },
    extra
  );
}

function locals(extra) {
  return Object.assign(
    {
      account: account(),
      access: {
        username: 'cliente.uno',
        password: 'clave<1>&2',
        message: 'Usuario: cliente.uno\nContraseña: clave<1>&2',
      },
      pending: [],
      xuiSyncNote: null,
      listUrl: '/reseller/cuentas',
      base: '/reseller/cuentas',
      plans: [{ id: 1, name: 'Mensual', duration_days: 30, credit_cost: 1, screens: 1 }],
      packages: [],
      formatClientDate: (value) => String(value || ''),
      formatDuration: (days) => `${days} d`,
      domainLabel: () => 'PATO',
      nextDomainLabel: () => 'CISNE',
      xuiOptionMeta: () => ({ days: 30, fallbackDays: null, fallbackCost: 0, maxCost: 0 }),
      currentUser: { role: 'reseller', username: 'milu', credits: 12 },
      flash: null,
      embyDevices: [],
      embyDevicesError: null,
      mpDevices: [],
      mpDevicesError: null,
      suggestedEmbyPlanId: null,
      suggestedXuiPackageId: null,
      maxplayerConfigured: true,
      hotplayerConfigured: true,
      newAccount: null,
    },
    extra
  );
}

function copied(html) {
  const match = html.match(/id="access-copy">([\s\S]*?)<\/script>/);
  assert.ok(match, 'falta el bloque de copia');
  return JSON.parse(match[1]);
}

test('la ficha enseña usuario y contraseña y copia el texto plano', async () => {
  const html = await ejs.renderFile(path.join(views, 'account-detail.ejs'), locals(), { views });
  assert.match(html, /Datos para el cliente/);
  assert.match(html, /Copiar mensaje de bienvenida/);
  assert.match(html, /clave&lt;1&gt;&amp;2/);
  const data = copied(html);
  assert.equal(data.username, 'cliente.uno');
  assert.equal(data.password, 'clave<1>&2');
  assert.equal(data.message, 'Usuario: cliente.uno\nContraseña: clave<1>&2');
  assert.equal(html.includes('Reintentar lo que falta'), false);
});

test('la ficha ofrece reintentar solo cuando falta un servicio', async () => {
  const pendingHtml = await ejs.renderFile(
    path.join(views, 'account-detail.ejs'),
    locals({
      account: account({
        maxplayer_user_id: null,
        provision_error: 'No se completó Max Player: cupo. Pulsa Reintentar lo que falta: no se crea otra línea y no se vuelve a cobrar.',
      }),
      pending: ['Max Player'],
    }),
    { views }
  );
  assert.match(pendingHtml, /Falta por terminar/);
  assert.match(pendingHtml, /Reintentar lo que falta/);
  assert.match(pendingHtml, /name="next" value="ficha"/);
  assert.match(pendingHtml, /No se crea otra línea y no se cobran créditos otra vez/);

  const stale = await ejs.renderFile(
    path.join(views, 'partials', 'account-row.ejs'),
    {
      a: account({ provision_error: 'fallo al borrar', id: 4, expires_at: '2026-02-01 00:00:00', duration_days: 30, owner_id: 2 }),
      actionBase: '/reseller/cuentas',
      showOwner: false,
      canMove: false,
      daysLeft: () => 10,
      domainLabel: () => 'PATO',
      nextDomainLabel: () => 'CISNE',
    },
    { views }
  );
  assert.equal(stale.includes('data-retry="1"'), false);

  const missing = await ejs.renderFile(
    path.join(views, 'partials', 'account-row.ejs'),
    {
      a: account({
        maxplayer_user_id: null,
        expires_at: '2026-02-01 00:00:00',
        duration_days: 30,
        owner_id: 2,
      }),
      actionBase: '/reseller/cuentas',
      showOwner: false,
      canMove: false,
      daysLeft: () => 10,
      domainLabel: () => 'PATO',
      nextDomainLabel: () => 'CISNE',
    },
    { views }
  );
  assert.match(missing, /data-retry="1"/);
});
