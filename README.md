# BMS — Multi-Tenant Restaurant Management & POS

Restaurant POS (Odoo-style) with strict multi-tenancy, served under one domain:

```
https://bms.nexusrajan.com/{tenant}          e.g. https://bms.nexusrajan.com/pizzahut
```

* **One dedicated PostgreSQL database + one dedicated DB role per tenant.** No shared tables, no shared data.
* Inside a tenant: **Tenant → Companies → Branches**, with every sale, price, stock movement, expense and report scoped by `company_id` / `branch_id` (tenant-level consolidated reports where allowed).
* Touch POS (floor plan, PAX, tabbed menu, sizes, modifiers, allergies, split checks, multi-currency/multi-method payments, credit sales, discounts/coupons, voids/cancellations with manager PIN approval, refunds).
* Waiter, takeaway, kiosk and customer QR / online ordering (with delivery-partner choice).
* KOT routing (food → kitchen printer, drinks → beverage printer) + live Kitchen Display.
* Recipes, per-item stock-impact toggle, ticket-referenced stock ledger, low-stock alerts, waste log.
* Delivery partners with flexible commission rules (fixed/% × per delivery/item/zone/client) and grouped deliveries.
* Counter expenses, X / Z reports, monthly consolidated report across all receipt channels.

| Part | Tech |
|---|---|
| API | Node 22, Fastify 5, TypeScript, Zod, `pg`, Socket.IO, argon2id |
| Web | React 19 + Vite SPA (one build serves every tenant path) |
| DB | PostgreSQL 17 (master routing DB + 1 DB per tenant) |
| Edge | Traefik v3 (Let's Encrypt, HTTPS, headers, rate limit) → nginx (SPA) / API |
| Printing | `print-agent/` — small Node service inside the restaurant LAN, ESC/POS over TCP 9100 |

## Repository layout

```
backend/            API, migrations (master/ and tenant/), provisioning, services
frontend/           SPA: POS, KDS, kiosk, customer menu, back office, platform console
print-agent/        In-store ESC/POS print agent (connects out over WSS)
traefik/            Edge proxy static + dynamic config (file provider, no docker.sock)
docker/postgres/    First-boot init (non-superuser app role + master DB)
scripts/            gen-secrets, backup, create-platform-admin
tests/e2e.mjs       60-check end-to-end API suite (run against dev/staging only)
docs/               ARCHITECTURE.md, DEPLOYMENT.md, SECURITY.md
```

## Quick start (local development)

```bash
docker compose -f docker-compose.dev.yml up -d          # PostgreSQL 17 on 127.0.0.1:5432
cd backend && cp .env.dev.example .env && npm ci && npm run dev     # API :4000
# create the platform super-admin (once)
PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='ChangeMe12345' npx tsx --env-file=.env src/scripts/create-platform-admin.ts
cd ../frontend && npm ci && npm run dev                  # SPA :5173 (proxies /api to :4000)
```

1. Open `http://localhost:5173/platform`, sign in, **create a tenant** (e.g. `pizzahut`). This creates the tenant's own database and role, runs migrations and seeds the first company, branch, register, floor plan, receipt channels, payment methods and administrator.
2. Open `http://localhost:5173/pizzahut/login` and sign in as the tenant admin.
3. **Settings → Devices → Register a device** turns the current browser into a POS / waiter / takeaway / kiosk / KDS terminal; staff then log in with their name + 4-digit PIN.

Run the API test-suite against the dev stack:

```bash
PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='ChangeMe12345' node tests/e2e.mjs
```

## Production

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** (Ubuntu VPS + Docker), **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** (tenancy, schema, flows) and **[docs/SECURITY.md](docs/SECURITY.md)** (hardening checklist & audit results).

## License

MIT — see [LICENSE](LICENSE).
