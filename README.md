# Panel Emby

Panel web de gestión de usuarios para Emby Server con tres roles:

- **Admin**: control total — resellers, créditos, planes, todas las cuentas, estadísticas.
- **Reseller**: cartera de créditos, crea y renueva cuentas de Emby (solo ve las suyas).
- **Cliente final**: ve su caducidad, días restantes y datos de conexión.

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
| `npm run test-emby` | Prueba la conexión y la API key de Emby |
| `npm run expiry` | Lanza a mano una pasada de caducidades |

## Caducidades

Un cron interno (hora en `EXPIRY_CRON`, por defecto 04:30) y una pasada extra al arrancar:

1. Cuentas vencidas → `IsDisabled=true` en Emby y estado `expired`.
2. Cuentas renovadas mientras estaban caducadas → se reactivan.
3. Tras `DELETE_AFTER_DAYS` días caducadas (0 = nunca) → se borran de Emby.

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
2. **Planes** → crea p. ej. "Mensual", 30 días, 1 crédito.
3. **Resellers** → crea el reseller; luego "Créditos" → recárgale saldo.
4. El reseller entra con su usuario, va a **Mis cuentas** → "Nueva cuenta": se crea el usuario en Emby con su contraseña y se le descuentan los créditos del plan.
5. El cliente final entra al panel con ese mismo usuario/contraseña y ve su caducidad y datos de conexión.
