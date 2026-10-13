# Totalflix EMBY

Panel web de gestión de usuarios con tres roles:

- **Admin**: control total — resellers, créditos, planes, todas las cuentas, estadísticas.
- **Reseller**: cartera de créditos, crea y renueva cuentas (solo ve las suyas).
- **Cliente final**: ve su caducidad, días restantes y datos de conexión.

Al dar de alta una cuenta se elige, con dos interruptores, dónde se crea:

- **Emby**: el usuario de Emby, igual que hasta ahora.
- **XUI**: una línea en XUI.one. Dentro de XUI se elige **TotalFlix** (solo la línea) o **Max Player** (la línea y, además, el usuario en la app, con la playlist ya conectada).

Los dos pueden ir activados a la vez. Renovar, caducar y borrar se aplican en cada sistema donde esa cuenta exista.

Stack: Node.js + Express + SQLite (better-sqlite3) + EJS. Sin build step.

## Desarrollo en local

```bash
git clone https://github.com/josekgullon-sudo/panelemby.git
cd panelemby
npm install
cp .env.example .env        # edítalo: API key de Emby, SESSION_SECRET, etc.
npm run test-emby           # comprueba conexión y API key contra Emby
npm run create-admin -- admin TuContraseñaSegura
npm run dev                 # http://localhost:3000, recarga al guardar
```

## Scripts

| Comando | Qué hace |
|---|---|
| `npm start` | Arranca el panel |
| `npm run dev` | Arranca con recarga automática |
| `npm run create-admin -- <usuario> <contraseña>` | Crea el admin (o resetea su contraseña) |
| `npm test` | Tests del panel con Emby, XUI y Max Player simulados |
| `npm run test-emby` | Prueba la conexión y la API key de Emby |
| `npm run test-xui` | Lee los paquetes de XUI (no crea líneas). Lánzalo en el servidor |
| `npm run test-maxplayer` | Lee `/info` y una página de usuarios (no crea nada). Lánzalo en el servidor |
| `npm run expiry` | Lanza a mano una pasada de caducidades |
| `npm run import-xui` | Trae todas las líneas de XUI. No cobra créditos. `-- --simular` no escribe. Una línea sin `exp_date` queda sin caducidad |
| `npm run auditar-ilimitadas` | Lista las importadas cuya caducidad es la hora de importación + 30 días y XUI no tiene `exp_date`. `-- --aplicar` les quita esa fecha; no corta líneas |
| `npm run rellenar-xui` | Relee `get_line` de cada cuenta importada (4 a la vez, con reintentos) y cuenta pruebas y líneas sin fecha. `-- --aplicar` guarda `is_trial` y deja ilimitadas las que no traen `exp_date` |

## Emby, XUI y Max Player

En **Cuentas → Nueva cuenta** (admin y reseller) el usuario y la contraseña van arriba. Debajo, dos interruptores. Cada servicio solo se muestra si su interruptor está encendido: Emby (plan, duración y fecha de caducidad) y XUI (paquete, TotalFlix o Max Player, duración y su propia fecha). Emby viene activado. Si activas XUI:

- **TotalFlix** crea solo la línea en XUI.
- **Max Player** crea la línea y después el usuario en Max Player, con esa línea como playlist.

Cada servicio tiene su fecha. En XUI se escribe `exp_date` como `YYYY-MM-DD HH:mm` en hora de Europa/Madrid (el servidor está en UTC; un unix da `STATUS_INVALID_DATE`). Este XUI ignora el parámetro `package`: el id del paquete se guarda en el panel. El paquete aporta canales, si es prueba y el tope de conexiones.

Al crear la cuenta, o al añadir un servicio que faltaba, se abre el aviso de siempre con **Copiar**. El texto sigue siendo «¡Bienvenido a Totalflix!»: bloque Emby (servidor, puerto, usuario, contraseña, pantallas) y, si hay línea IPTV (TotalFlix o Max Player), un bloque «📡 TOTALFLIX» con usuario, contraseña y vencimiento con hora. El texto para el cliente no dice XUI. Si hay los dos, cada uno lleva su fecha.

La ficha de cada cuenta muestra dispositivos de Emby y de Max Player, caducidad por servicio, ids, dominio PATO/CISNE y reseller. Desde ahí se puede crear el servicio que falte, ampliar Emby o XUI por separado (cobra como una renovación de ese servicio) y pulsar **Reparar** (llave inglesa): borra los dispositivos de Max Player y cambia el servidor entre PATO y CISNE.

**Sincronizar XUI** (admin) o `npm run import-xui` mete todas las líneas. No duplica (por id de línea o usuario) y no cobra. Si el usuario ya es de Emby, sigue siéndolo y se le añade la línea. En este XUI `get_lines` devuelve null: el import recorre `get_line` por id, de 4 en 4 (`XUI_SCAN_CONCURRENCY`). Un id que no existe responde `{"status":"STATUS_FAILURE"}` y se salta. Un 503, un 5xx o un corte de red se reintenta con espera; si sigue fallando, la importación se detiene y nombra ese id. Para tras `XUI_SCAN_MISS_GAP` ids vacíos seguidos (2000) o al llegar a `XUI_SCAN_MAX_ID` (10000). Con el panel vacío se para en el hueco, sin recorrer el id máximo. El botón del admin arranca en segundo plano y la página muestra el avance, así la petición no se queda colgada unos minutos. El informe (simulación con `--simular` y sincronización real) separa dueño (cada reseller y el admin), Max Player y TotalFlix, dominio PATO, CISNE, otro servidor o sin dominio, activas y caducadas, además de nuevas, actualizadas, conflictos y errores. Max Player se reconoce con el listado paginado `GET /users`, sin buscar línea a línea. El reseller puede tener varios `member_id` separados por comas (por ejemplo `3,10`); si la línea trae uno de ellos, se le asigna. Si no, queda en el admin.

### Créditos

- **Emby** cobra `credit_cost` del plan, como hasta ahora.
- **XUI** cobra el precio del paquete si el admin se lo puso en Planes → Paquetes XUI. Si el paquete está vacío, cobra `xui_credit_cost` del plan (0 por defecto: no cambia lo que ya pagaban las cuentas solo Emby).
- **Max Player** suma `maxplayer_credit_cost` del plan, encima de XUI.

Si se piden varios servicios se suman. El admin no gasta saldo. Si XUI se crea y Max Player falla, la cuenta queda guardada con el id de la línea, se cobra una sola vez y el botón **Reintentar** completa lo que falte sin volver a cobrar.

### Migración

No hay que lanzar nada a mano. Al arrancar, el panel añade las columnas que falten:

- `emby_accounts`: `has_emby`, `xui_line_id`, `xui_package_id`, `xui_package_name`, `xui_bouquets`, `player_kind` (`totalflix` o `maxplayer`), `maxplayer_user_id`, `maxplayer_list_ok`, `maxplayer_domain_id`, `emby_expires_at`, `xui_expires_at`, `emby_cut`, `xui_cut`, `provision_error`
- `panel_users.xui_member_id`: uno o varios `member_id` de XUI, separados por comas
- `plans`: `xui_credit_cost`, `maxplayer_credit_cost` (las dos a 0)
- tabla nueva `xui_packages` (catálogo cacheado; el precio en créditos que pongas se conserva al actualizar)

Las cuentas que ya existían quedan como solo Emby. Conviene copiar `data/panel.sqlite` antes de actualizar.

### Qué comprobar contra las APIs reales

Desde esta máquina no se llega a los paneles (la IP está filtrada). En el servidor:

```bash
npm run test-xui
npm run test-maxplayer
```

Conviene contrastar, creando una línea de prueba y borrándola, que la API de tu XUI coincide con lo que usa `src/services/xui.js`:

1. `get_packages` puede venir como array pelado o como `{ status, data }`. El cliente acepta los dos. Revisa que el id, el nombre, `is_trial`, `max_connections` y los bouquets salen bien.
2. `create_line` manda `package`, pero este XUI lo ignora y la línea vuelve sin paquete. El panel guarda el id. Confirma que `edit_line` tampoco lo borra de nuestra base.
3. `exp_date` va como `YYYY-MM-DD HH:mm` en Europe/Madrid, no como unix. Comprueba invierno (UTC+1) y verano (UTC+2), y que manda sobre la duración del paquete.
4. En `edit_line`, omitir `bouquets_selected` a veces vacía los canales. El panel reenvía los bouquets que guardó al crear la línea. Si `get_packages` no trae bouquets, no los reenviamos: comprueba que una renovación no deja la línea sin canales.
5. `enable_line` sobre una línea ya activa, y `delete_line` / `disable_line` cuando el id ya no existe.
6. El texto de Copiar no incluye la M3U. Si hiciera falta a mano, la URL sigue siendo `{XUI_PUBLIC_URL}/get.php?username=…&password=…&type=m3u_plus&output=ts`.
7. Max Player: `POST /users` ya manda `iptv_user` / `iptv_pass` (lista inicial) y luego `PUT /users/list` (o `POST /users/list` si responde 404). `MAXPLAYER_DOMAIN_ID` tiene que ser el dominio que apunta a tu XUI.
8. Un reintento tras un 409 busca el usuario (`POST /users/search`) y llama a `PUT /users/connect`. Comprueba que no crea un duplicado.
9. Max Player no tiene “desactivar usuario”. Al caducar se desactiva la línea XUI (la app deja de reproducir) y se intenta cerrar sus dispositivos. Al borrar sí se llama a `DELETE /users/{id}`.
10. `XUI_INSECURE_TLS=1` solo relaja el certificado de XUI. No lo dejes puesto si más adelante el certificado es válido.
11. Un 503 «Could not verify public API allowance» se reintenta solo. Si sigue fallando, el aviso debe decirlo.
12. Reparar: `DELETE /users/devices/{id}` y, si falla, borrar uno a uno en `/customers/{id}/devices`. El cambio de servidor edita la lista que ya existe (`PUT /customers/{id}/lists/{list_id}`) y borra las demás, para que quede una sola en PATO o CISNE. `PUT /users/list` en este panel añade otra lista («New list») y no sirve para el cambio.
13. `npm run import-xui` (y `--simular`): si `get_lines` viene vacío, recorre `get_line` por id de 4 en 4. `{"status":"STATUS_FAILURE"}` sin texto es un id vacío. Un 503 se reintenta; si un id sigue fallando, el proceso sale con ese id y no importa a medias. No duplica al repetirlo, no cobra, y marca Max Player solo si el usuario IPTV está en `GET /users` paginado. El informe lista dueños, PATO/CISNE, activas/caducadas y errores. En el admin, Sincronizar XUI vuelve al momento y el avance se actualiza en la página. Un 429 de Max Player «Reintenta en N s» espera esos segundos.

## Caducidades

Un cron interno (`EXPIRY_CRON`, recomendado cada 30 min para que las demos por horas corten a tiempo) y una pasada extra al arrancar:

1. Cada servicio vence por su fecha: se corta Emby o la línea XUI, sin tocar el otro. La cuenta pasa a `expired` solo cuando todos los servicios que tiene están cortados.
2. Si una de esas fechas vuelve al futuro, se reactiva solo ese servicio.
3. Tras `DELETE_AFTER_DAYS` días desde la fecha más tardía (0 = nunca) → se borran en Emby, XUI y Max Player.

## Deploy en Ubuntu (producción)

Requisitos: Ubuntu con Node.js 18+ (`node -v`). Si no lo tiene:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 1. Usuario de sistema y código

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin panelemby
sudo git clone https://github.com/josekgullon-sudo/panelemby.git /opt/panelemby
cd /opt/panelemby
sudo npm install --omit=dev
```

### 2. Configuración

```bash
sudo cp .env.example .env
sudo nano .env
```

En producción, como Emby corre en la misma máquina:

```
EMBY_URL=http://localhost:8096
EMBY_PUBLIC_URL=http://IP_O_DOMINIO_PUBLICO:8096   # lo que ven los clientes
EMBY_API_KEY=la_api_key_real
SESSION_SECRET=cadena_aleatoria_larga_nueva        # genera una nueva, no reuses la de dev
PORT=3000
```

Permisos (el `.env` solo legible por el servicio):

```bash
sudo chown -R panelemby:panelemby /opt/panelemby
sudo chmod 600 /opt/panelemby/.env
```

### 3. Primer admin

```bash
cd /opt/panelemby
sudo -u panelemby node scripts/create-admin.js admin TuContraseñaSegura
```

### 4. Servicio systemd

```bash
sudo cp deploy/panelemby.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now panelemby
systemctl status panelemby        # debe decir "active (running)"
journalctl -u panelemby -f        # logs en vivo
```

Abre el puerto si usas ufw: `sudo ufw allow 3000/tcp`.

### Actualizar a una nueva versión

```bash
cd /opt/panelemby
sudo -u panelemby git pull
sudo -u panelemby npm install --omit=dev
sudo systemctl restart panelemby
```

## Puesta en marcha (primeros pasos en el panel)

1. Entra en `http://IP:3000` con el admin creado por script.
2. **Planes** → en la primera ejecución se crea solo el catálogo completo (demo 6 h y 1/3/6/12 meses en 1 o 2 pantallas); edita costes de Emby, XUI y Max Player, o crea más si quieres. En la misma página, «Actualizar desde XUI» trae los paquetes y les puedes poner un precio en créditos. Las pantallas del plan se aplican en Emby como límite de reproducciones simultáneas.
3. **Resellers** → crea el reseller; luego "Créditos" → recárgale saldo.
4. El reseller entra con su usuario, va a **Mis cuentas** → "Nueva cuenta": elige Emby, XUI o los dos. Se crea en esos sistemas y se le descuentan los créditos.
5. El cliente final entra al panel con ese mismo usuario/contraseña y ve su caducidad y datos de conexión.
