# Deployment — Ubuntu VPS (Docker)

Tested layout: Ubuntu 22.04/24.04, 2 vCPU / 4 GB RAM is plenty for dozens of tenants.

## 1. DNS

Create an `A` record `bms.nexusrajan.com → <VPS IPv4>` (and `AAAA` if you have IPv6). Wait until it resolves.

## 2. Server preparation

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install ca-certificates curl git ufw unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades            # automatic security updates

# Docker Engine + compose plugin (official repo)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# Firewall: only SSH + HTTP(S). PostgreSQL is never published.
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

> Docker-published ports bypass UFW rules. This stack only publishes 80/443 (Traefik), so that's fine — don't add
> `ports:` to `postgres` or `api`.

Harden SSH (`/etc/ssh/sshd_config`): `PasswordAuthentication no`, `PermitRootLogin no`, then `sudo systemctl restart ssh`.

## 3. Install

```bash
sudo mkdir -p /opt/bms && sudo chown $USER /opt/bms
git clone https://github.com/sharlr/bms.git /opt/bms && cd /opt/bms
chmod +x scripts/*.sh docker/postgres/init.sh
cp .env.example .env
./scripts/gen-secrets.sh            # paste the 3 values into .env
nano .env                           # set BMS_DOMAIN and ACME_EMAIL
chmod 600 .env
docker compose up -d --build
docker compose ps                   # all services healthy
./scripts/create-platform-admin.sh  # super-admin for https://bms.nexusrajan.com/platform
```

**Back up `BMS_SECRETS_KEY` separately** (password manager). Tenant database passwords are encrypted with it.

## 4. Create the first tenant

Open `https://bms.nexusrajan.com/platform` → **New tenant** (slug `pizzahut`, company, currency, first branch and
admin). The restaurant is live at `https://bms.nexusrajan.com/pizzahut`.

Inside the tenant (`/pizzahut/login` as the admin):

1. **Settings → Companies / Branches**: add more companies (brands / legal entities) and branches.
2. **Settings → Users**: staff with role, PIN and company/branch access. **Roles & Permissions** to tailor rights.
3. **Settings → Printers**: kitchen + beverage (+ receipt) printers per branch, `tcp://<printer LAN IP>:9100`.
4. **Menu**: categories (KOT route), items with sizes, company/branch prices, modifiers, “Deduct stock” toggle.
5. **POS → Floor Plan**: arrange tables, print table QR codes.
6. **POS → Recipes & Inventory**, **Exchange Rates**, **Delivery & Commissions**, **Clients / Coupons**.
7. **Settings → Devices**: on each restaurant screen, sign in as a manager and register it (POS / waiter /
   takeaway / kiosk / KDS). Staff then log in with name + PIN.

## 5. In-store print agent (per branch)

On a small always-on machine in the restaurant LAN (Raspberry Pi, mini PC) with Node 22:

```bash
git clone https://github.com/sharlr/bms.git && cd bms/print-agent && npm ci --omit=dev
cp .env.example .env    # BMS_URL, BMS_TENANT, BMS_DEVICE_TOKEN (Settings → Devices → mode "In-store print agent")
npm start
```

Run it as a service (systemd):

```ini
# /etc/systemd/system/bms-print-agent.service
[Unit]
Description=BMS print agent
After=network-online.target
[Service]
WorkingDirectory=/home/pi/bms/print-agent
ExecStart=/usr/bin/node --env-file=.env agent.mjs
Restart=always
User=pi
[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now bms-print-agent`. Give printers static LAN IPs. Jobs show under **Settings → Print Queue**.

## 6. Backups

**In-app (per restaurant):** Back office → Backup & Restore. Tenant admins can take backups, schedule daily ones with a
retention period, download, restore (with an automatic safety backup first) and restore from an uploaded file.
Files are stored in the `backups` Docker volume (`/backups/<tenant>/` inside the `api` container) and listed in the
master DB. They are on the same server as the database, so also copy that volume off-site:

```bash
docker run --rm -v bms_backups:/b -v /var/backups/bms-app:/out alpine sh -c 'cp -a /b/. /out/'
```

**Whole server (all tenants + master DB):**

```bash
sudo crontab -e
15 3 * * * /opt/bms/scripts/backup.sh >> /var/log/bms-backup.log 2>&1
```

Dumps the master DB, every tenant DB and globals to `/var/backups/bms/<date>/` (14 days kept). **Copy them
off-server** (e.g. `rclone` to object storage). Restore one tenant:

```bash
docker compose exec -T postgres pg_restore -U postgres -d bms_t_pizzahut --clean --if-exists < /var/backups/bms/2026-01-01/bms_t_pizzahut.dump
```

## 7. Updates

```bash
cd /opt/bms && git pull && docker compose up -d --build
```

The API applies new master and tenant migrations on start (each DB under an advisory lock). Check
`docker compose logs api | grep FAILED` after an upgrade.

## 8. Operations

* Logs: `docker compose logs -f api` (cookies / auth headers are redacted).
* Suspend a tenant: platform console → Suspend (their URLs immediately return 404).
* Rotate a staff PIN / password: Settings → Users (all their sessions are revoked).
* Lost terminal: Settings → Devices → Revoke (its sessions end immediately).
