# BMS Restaurant — developer guide for Claude Code

Multi-tenant restaurant management + POS by **NEXUS RAJAN S.A.R.L**. Repo: https://github.com/sharlr/bms (branch `main`).
Production URL shape: `https://bms.nexusrajan.com/{tenant}` (path-based tenancy, **one PostgreSQL database per tenant**).

This file is the source of truth for how the code is built. `docs/ARCHITECTURE.md`, `docs/SECURITY.md` and
`docs/DEPLOYMENT.md` give more background, but parts of ARCHITECTURE.md are older: it still mentions `kot_route` and
kitchen/beverage printers, which have been replaced by **prep stations** (see §6). Where they disagree, trust this file
and the code.

---

## 0. Rules for working in this repo (read first)

1. **Every UI string must be translatable** (EN / FR / NL). In a React component: `const tr = useTr();` with
   `import { useT as useTr } from '../i18n'` (adjust the relative path), then `{tr("English text")}`. Then add the key to
   **both** `frontend/src/locales/fr.json` and `frontend/src/locales/nl.json`. See §8.
   - Use `{0}`, `{1}` placeholders, never string concatenation: `tr("Table {0}", t.name)`.
   - **Never wrap data keys in `tr()`**: column keys, `optionsFrom.label` (a DB column name), status codes, URLs, enum values.
     Only text a human reads.
   - Backend error messages are English. The frontend translates them when it shows them (`useAction` toasts `tr(message)`).
     So when you add a `badRequest('...')`, add the same text to fr.json/nl.json too.
2. **Schema changes = a new numbered migration file**: `backend/migrations/tenant/016_xxx.sql` (or `master/003_xxx.sql`).
   Never edit an applied migration. Each file runs once, in its own transaction, on **every** tenant DB at API start.
   Write it so it works on existing data: backfill, then add NOT NULL; wrap nullable comparisons in `coalesce(...)`.
3. **Zod 4**: `.partial()` still applies `.default()` values, so a PATCH would silently overwrite fields. Never use
   `.default()` in schemas that get `.partial()`. Use explicit optional fields (see `backend/src/modules/resources.ts`).
4. **SQL**: always bind parameters (`$1`, `$2`…). When building placeholders in template literals, write `$${i + 2}`
   (the first `$` is literal). Dynamic identifiers only via `ident()` from `lib/db.ts`.
5. **Scope every query**: tenant (own DB) → `company_id` → `branch_id`. Get these from `branchCtx(req)` / `companyCtx(req)`.
   Never trust IDs from the body without checking they belong to the same company/branch (CRUD `refs` does this).
6. **Permissions**: every route calls `requireUser(req)` or `requirePerm(req, 'perm.name')`. A new permission goes in
   `backend/src/lib/permissions.ts` (plus default roles there) and its description in fr.json/nl.json.
7. **Realtime events** go through the `Events` collector and are flushed **after COMMIT** (`ev.flush()`), never inside a transaction.
8. **Money**: `numeric` in the DB; in JS use `round2/round3/sum` from `lib/money.ts`. Base currency is per company (e.g. DJF).
9. **Do not commit secrets**: `.env`, `.env.local`, keys and dumps are git-ignored. Only `*.example` env files are tracked.
10. After changes run, in this order: `cd backend && npx tsc --noEmit`, `cd frontend && npx tsc -b && npx vite build`,
    rebuild Docker, then the e2e suite (§11). All checks must pass ("ALL CHECKS PASSED").
11. Windows dev machine: prefer writing scripts to files over long `node -e "..."` one-liners (shell quoting of
    backticks / `${}` corrupts code). In JS string replacement, use `split/join`, because `String.replace` treats `$&` / `` $` `` specially.

---

## 1. Stack

| Layer | Tech |
|---|---|
| Backend | Node 22, **Fastify 5**, TypeScript (ESM, `module: NodeNext`, imports end in `.js`), **Zod 4**, `pg`, Socket.IO 4, `@node-rs/argon2` |
| DB | **PostgreSQL 17**; master DB `bms_master` + one DB per tenant `bms_t_{slug}` with its own role |
| Frontend | **React 19 + Vite** SPA, react-router-dom 7 (data router), lazy-loaded pages, Leaflet (lazy) for maps, `qrcode` |
| Edge | Traefik v3 (TLS via ACME in prod) → `web` (nginx serving SPA) and `api` (Fastify on :4000) |
| Printing | `print-agent/agent.mjs`, runs inside the restaurant LAN, connects **out** to the API over WSS, prints ESC/POS over TCP |

---

## 2. Repository layout

```
backend/
  src/index.ts            boot: build server → migrate master → migrate all tenants → realtime → listen → backup scheduler (every 60 s)
  src/server.ts           Fastify setup (helmet, CORS, cookie, rate limit, error handler), route registration
  src/config.ts           env validation (Zod); refuses weak secrets in production
  src/realtime.ts         Socket.IO server + Events collector class
  src/lib/                crypto (tokens, argon2, AES-GCM), db (many/one/exec/tx/ident/nextSeq), errors, money, permissions, validate
  src/plugins/context.ts  tenantHook, loadAuth, requireUser/requirePerm, branchCtx/companyCtx, authorize (manager PIN override), audit
  src/master/             pools (master + LRU tenant pools), provision (create/delete/migrate tenants), migrate runner, backup (pg_dump/restore/scheduler)
  src/modules/            route modules (see §4)
  src/services/           business logic shared by routes (see §5)
  src/scripts/            migrate.ts, create-platform-admin.ts
  migrations/master/      001_init, 002_backups
  migrations/tenant/      001_schema … 015_language_nl (see §3)
frontend/
  src/main.tsx            router + providers (LangProvider > ToastProvider > SessionProvider …)
  src/api.ts              fetch wrapper (tenant + platform), branch/company context headers
  src/session.tsx         SessionProvider/useSession (me, can(), branchId, theme, language), LANDING_PAGES, landingRoute()
  src/socket.ts           useBranchEvents(branchId, events, handler)
  src/i18n.tsx            translations, LangProvider/useLang/useT, LangSwitch, SOFTWARE, LANGUAGES, THEMES
  src/locales/            fr.json, nl.json  (English text → translation)
  src/util.ts             fmt (money), fmtQty, dt, time, minutesSince, today, thisMonth, todayLocal, ORDER_TYPES
  src/styles.css          all styling; themes via [data-theme="gold|navy|emerald|crimson|slate"] CSS variables
  src/components/         AppBar, CrudPage, FloorPlan, Map/MapPicker, MenuOrdering, Receipt, Reservations, CookingNotes, Charts, ui
  src/pages/              Auth, Pos, Kds, Kiosk, Customer, Platform, admin/*
print-agent/              in-store print agent (Node, ESC/POS)
tests/e2e.mjs             end-to-end API test suite (~145 checks)
traefik/                  traefik.yml + dynamic.yml (prod), traefik/local/* (Docker Desktop)
docker-compose.yml        production (TLS, domain from BMS_DOMAIN)
docker-compose.local.yml  Docker Desktop: http://localhost:8080, PAYMENT_PROVIDER=sandbox, env from .env.local
docker-compose.dev.yml    Postgres only, for `npm run dev`
scripts/                  gen-secrets.sh, create-platform-admin.sh, backup.sh
```

---

## 3. Databases

### Master DB (`bms_master`, role `bms_app` = CREATEDB + CREATEROLE, **not** superuser)
`tenants` (slug, display name, db name, db role, AES-256-GCM encrypted db password, status active/suspended),
`platform_admins`, `platform_sessions`, `platform_audit`, `backup_schedules`, `backup_versions`.

### Tenant DB (`bms_t_{slug}`, owned by role `bms_t_{slug}`)
Main tables (001_schema plus later migrations):

```
companies (base currency, tax, receipt header/footer…) ─┬─ branches (timezone, lat/lng, online ordering/booking flags…)
  branches ─┬─ registers ─ pos_sessions (change fund, open/closed) ─ shift_reports (X/Z snapshots)
            ├─ floors (layout jsonb, width, height) ─ dining_tables (seats, shape, pos, qr_token)
            ├─ printers (kind 'kot' + station_id | 'receipt')   ├─ devices (mode pos|waiter|takeaway|kiosk|kds|print_agent)
            ├─ branch_stock (qty, min_qty)                      └─ branch_sequences (ticket/KOT/X/Z numbers; nextSeq())
  companies ─ prep_stations (unlimited kitchens/bars) · receipt_channels · payment_methods (cash|card|credit|mobile_money|voucher|other)
            · menu_categories (station_id, parent_id) ─ menu_items (station_id override, no_kot, tracks_stock, allergens)
                 menu_items ─ item_sizes · item_prices (item × size × branch? × order_type?) · item_modifier_groups ─ modifier_groups ─ modifiers
                            ─ item_images (bytea) · recipes ─ recipe_lines ─ ingredients
            · cooking_notes · clients (credit) · coupons · exchange_rates · currencies (global list)
            · delivery_companies ─ delivery_commission_rules · delivery_zones · expense_categories ─ counter_expenses
tickets (status pending|open|paid|cancelled; order_type dine_in|takeaway|delivery; source pos|waiter|takeaway|kiosk|qr|online;
         guest_status; refund_status; scheduled_for; delivery lat/lng; closed_by; public token)
  ├─ ticket_lines (status active|void; kitchen_status new|sent|accepted|preparing|ready|served; station_id; kitchen_by/at; seat; notes; allergy)
  ├─ payments (kind payment|refund; currency, rate, base_amount; value_at = date a prepayment counts) · online_payments · refunds
  ├─ kot_orders (station_id, kot_no, lines jsonb, status) · print_jobs (kot|receipt|report; pending|printed|failed|no_printer)
  ├─ cancellations (line|ticket|table_clear) · delivery_commissions · stock_movements (sale|sale_reversal|refund_return|purchase|adjustment|waste|opening)
reservations (pending|confirmed|seated|cancelled|no_show; source online|staff; token) · waste_logs · audit_log
users (argon2id password + PIN, role, theme, language en|fr|nl, position, landing_page auto|home|pos|kds|orders, lockout)
  ─ user_access (company_id, branch_id NULL = all branches) · roles (permissions text[]) · sessions
```

Migration history: 002 currencies · 003 price per order type · 004 user prefs · 005 floor layout · 006 per-line kitchen + online
payments · 007 more currencies (DJF…) · 008 remove delivery batches · 009 item images · 010 cooking notes · 011 tickets.closed_by
· 012 landing page · 013 reservations + scheduled delivery + branch lat/lng + payments.value_at · 014 prep stations (replaces
kot_route) · 015 language 'nl'.

Migrations: `master/migrate.ts` applies pending `*.sql` in name order, each in its own transaction, under an advisory lock,
and records them in `schema_migrations`. If a tenant's migration fails, that tenant is logged and skipped; the API still starts.

Provisioning (`master/provision.ts provisionTenant`): create role + DB → revoke PUBLIC → run tenant migrations → seed (roles,
company, branch, register, floor, tables, channels, payment methods, admin user) → mark active. Everything is rolled back on
failure. `RESERVED_SLUGS` lists the names a tenant cannot use. A tenant must be suspended before it can be deleted; deleting
archives a final dump first.

---

## 4. HTTP API

Base paths: tenant API `/api/t/:tenant/...`; platform API `/api/platform/...`; health `GET /api/health`;
Socket.IO `/api/socket.io`.

**Request contract** (`frontend/src/api.ts`): every request sends header `X-Requested-With: bms` (CSRF guard, required on
writes), plus `X-Branch-Id` / `X-Company-Id` from localStorage (selected in the top bar). Cookies: `sid_{slug}` (staff
session), `dev_{slug}` (registered device), both `HttpOnly; SameSite=Strict; path=/api`. Errors come back as
`{ error: code, message }`.

Tenant request pipeline: `tenantHook` (slug → master DB → tenant pool, 404 if unknown or suspended) → `loadAuth` (session
+ device) → route. Branch resolution in `branchCtx`: a device-bound session uses the device's branch; otherwise the
`X-Branch-Id` header, validated against `user_access`.

### Route map (file → routes)
- **platform.ts** (`/api/platform`): `POST /login` `POST /logout` `GET /me` `GET|POST /tenants` `PATCH /tenants/:id` (rename display name) `POST /tenants/:id/status` `DELETE /tenants/:id`
- **auth.ts**: `GET /auth/me` `GET /auth/permissions` `POST /auth/login` (username+password+branch) `GET /auth/staff` (PIN grid, registered devices only) `POST /auth/pin` `POST /auth/logout` `POST /auth/change-password` `PATCH /auth/profile` (theme, language, position, landing_page) `POST /auth/change-pin` `POST /auth/devices` (register this browser as terminal) `GET /devices` `DELETE /devices/:id` `POST /auth/forget-device`
- **org.ts**: `GET|POST /companies` `PATCH /companies/:id` `GET|POST /branches` `PATCH /branches/:id` `GET|POST /users` `PATCH /users/:id` `POST /users/:id/unlock`
- **resources.ts** (generic CRUD via `registerCrud` in crud.ts → `GET path`, `GET path/:id`, `POST path`, `PATCH path/:id`, `DELETE path/:id`):
  `/registers` `/printers` `/receipt-channels` `/payment-methods` `/clients` `/coupons` `/menu/categories` `/menu/sizes`
  `/menu/modifier-groups` `/menu/modifiers` `/menu/cooking-notes` `/prep-stations` `/expense-categories` `/inventory/ingredients`
  `/delivery/companies` `/delivery/zones` `/delivery/rules` `/floors` `/tables` `/roles`
- **menu.ts**: `GET /menu/palette` (POS menu) `GET|POST /menu/items` `PATCH|DELETE /menu/items/:id` `PUT|DELETE /menu/items/:id/image` `GET /public/menu-images/:id` `PUT /menu/items/:id/prices` `PUT /menu/items/:id/modifier-groups`
- **pos.ts**: `GET /pos/floor` `POST /pos/tables/:id/open` `GET|POST /pos/tickets` `GET|PATCH /pos/tickets/:id` `POST /pos/tickets/:id/lines` `PATCH|DELETE /pos/tickets/:id/lines/:lineId` `POST /pos/tickets/:id/send` `POST /pos/tickets/:id/accept` `POST /pos/tickets/:id/lines/:lineId/void` `POST /pos/tickets/:id/cancel` `POST /pos/tables/:id/clear` `POST /pos/tickets/:id/discount` `POST /pos/tickets/:id/split`
- **billing.ts**: `POST /pos/tickets/:id/payments` `POST /pos/tickets/:id/refund` `GET /pos/tickets/:id/receipt` `POST /pos/tickets/:id/print-receipt` `GET /pos/session` `POST /pos/session/open` (change fund) `GET /reports/session` `POST /reports/x` `POST /reports/z` (refused while the branch has open tickets) `GET /reports/shifts` `GET /reports/shifts/:id` `GET /reports/dashboard` `GET /reports/monthly`
- **reports.ts**: `GET /reports/staff` `GET /reports/settlements` `GET /reports/items` (date range `from`/`to`, branch local time)
- **kitchen.ts**: `GET /kds/staff` (cooks to pick on Take) `GET /kds/orders?station_id=` `POST /kds/orders/:id/status` `POST /kds/lines/:id/status` (with optional `cook_id`) `GET /print/jobs`
- **inventory.ts**: `GET /inventory/stock` `GET /inventory/low-stock` `PUT /inventory/stock/:id/min` `POST /inventory/stock/adjust` `GET /inventory/movements` `GET|PUT /inventory/recipes` `DELETE /inventory/recipes/:id` `GET|POST /waste`
- **finance.ts**: `GET|POST /expenses` `POST /expenses/:id/void` `GET /currencies` `GET|POST /rates` `GET /delivery/commissions`
- **public.ts** (no login; strict rate limits): `GET /public/info` `GET /public/table/:token` `POST /public/table-lookup` `GET /public/branches` `GET /public/branches/:id/menu` `GET /public/branches/:id/delivery-companies` `POST /public/orders` `GET /public/orders/:token` `POST /public/orders/:token/pay` `GET|POST /public/pay/sandbox/:id` · kiosk (registered device): `GET /kiosk/menu` `POST /kiosk/orders`
- **reservations.ts**: public `POST /public/reservations` `GET /public/reservations/:token` `POST /public/reservations/:token/cancel` · staff `GET|POST /reservations` `PATCH /reservations/:id` `POST /reservations/:id/seat`
- **backup.ts**: `GET|POST /backups` `GET /backups/:id/download` `DELETE /backups/:id` `POST /backups/:id/restore` `POST /backups/upload` (octet-stream) `POST /backups/schedules` `PATCH|DELETE /backups/schedules/:id` (restore/upload/delete: tenant admins only)

### Adding a simple resource
Add a `registerCrud(app, { path, table, scope: 'tenant'|'company'|'branch'|'parent', schema, readPerm, writePerm, refs, filters, orderBy, beforeWrite })`
entry in `resources.ts`. On the frontend, render it with `<CrudPage path=... columns=[...] fields=[...] />`. A `Field.optionsFrom`
is `{ path, label: '<column name>', nullLabel? }`.

---

## 5. Services (backend/src/services)

- **tickets.ts**: `OrderType`, `Source`, `loadTicket(c,id,ctx,lock)`, `assertEditable`, `channelFor`, `resolveItem` (price
  resolution: branch+order type › branch › company+order type › company), `addLine`, `recalc` (totals/tax/discount),
  `createTicket`, `ticketDetail`, `currentSession` (opens a register session on first activity), `branchLocalTime`,
  `ADVANCE_MINUTES=60`, `isAdvance`, `checkSchedule` (≤ 60 days ahead), `validateRefs`.
- **kot.ts**: `sendToKitchen`: groups unsent lines **by station_id**, one KOT per station (`kot_orders`), a print job for each
  active `kot` printer of that station, a `kds:new` event. Lines with no station are marked `served` (no kitchen ticket).
  `printToStation`.
- **stock.ts**: `applyMovement` (returns LowStock when stock drops below min → `stock:low` event), `recipeFor`,
  `deductForLine` (only for items with `tracks_stock`), `transferLineStock` (split), `returnForLine` (void/refund).
- **commission.ts**: `computeCommission`. The order-level rule is the most specific of client › zone › per-delivery
  (fixed or %); item rules add on top. It runs when a delivery ticket is paid and again on refund.
- **reports.ts**: `sessionReport` (X/Z content: sales, order types, channels, payment modes, currencies, cash
  reconciliation, expenses, commissions, discounts, refunds, voids/cancellations), `monthlyReport(MonthlyFilter)`.
- **onlinepay.ts**: `Provider` interface (`createCheckout`), `provider` (`sandbox` or null per `PAYMENT_PROVIDER`),
  `markOnlinePaid`. To add a real gateway (e.g. CACPay), implement `Provider` and a webhook route. The sandbox is
  refused in production on https.
- **seed.ts**: `seedRoles`, `seedCompanyDefaults`, `seedBranchDefaults`.

## 6. Key business flows
- **Kitchens/bars (prep stations)**: unlimited per company. Category `station_id` → item `station_id` override, or
  `no_kot`. The KDS screen picks a station (saved in localStorage `bms:kds-station`) or "All". Per-line flow:
  `sent` → **Take** (modal to pick a cook from `/kds/staff`; `kitchen_by`) → `preparing` → `ready` → `served`. Lines not
  yet taken blink red. Ready lines raise `order:ready` on the POS.
- **Customer orders** (QR `/menu?table=token`, online `/order`, kiosk): created as `pending`. Staff with
  `pos.accept_online` accept them (unless the branch auto-accepts). Advance orders (`scheduled_for` > now + 60 min) are
  accepted but sent to the kitchen later. A prepayment counts in reports on the delivery date (`payments.value_at`).
- **Payments**: several per ticket, any method/currency (latest manual rate; a branch rate overrides the company rate).
  Only cash may exceed the amount due. Credit needs a credit client (limit enforced). Split = move lines to a new check;
  split by amount = partial payments.
- **Sensitive actions** (void, cancel, clear table, refund, discount): need the permission or a manager PIN override
  (`authorize()` in context.ts; frontend `useOverride`).
- **Register**: open day with a change fund. X = snapshot; Z = close. Z is refused while the branch still has open tickets.
- **Login**: back office = username + password + branch. Registered terminals = staff PIN grid. After sign-in the user
  goes to their landing page (`landingRoute()`).
- **Backups**: pg_dump custom format per tenant in `BACKUP_DIR/{slug}`. Manual, scheduled (daily at a time, with a
  retention period), uploaded, and pre-restore safety copies. A restore first takes a safety backup.

## 7. Realtime (Socket.IO)
Rooms: `{tenant}:{branchId}` and `{tenant}:{branchId}:print` (print agent). Events: `tables:changed`, `order:new`,
`order:paid`, `order:ready`, `ticket:paid`, `ticket:refunded`, `kds:new`, `kds:update`, `kds:void`, `kds:cancel`,
`stock:low`, `session:closed`, `reservation:new`, `reservation:changed`, `print:job` (agent acks with `print:ack`).
Backend: `const ev = new Events(req.tenant.slug); ev.branch(branchId, 'event', data); … after commit: ev.flush()`.
Frontend: `useBranchEvents(branchId, ['kds:new', …], (event, data) => …)`.

---

## 8. Frontend

**SPA routes** (`main.tsx`): `/` landing · `/platform` platform console · `/:tenant` (TenantHome redirect) · `login` ·
`terminal` (PIN) · `pos` · `kds` · `kiosk` · `menu` + `order` (CustomerOrder) · `track/:token` · `pay/sandbox/:id` ·
`reserve` · `reservation/:token` · `app/*` (AdminApp back office).

**AdminApp** (`pages/admin/AdminApp.tsx`): collapsible sidebar built from a `NAV` tree of `{ to, label, perm }` (label is
English and goes through `tr()`). Sections: Dashboard · Operations (POS, Floor plan designer, KDS, Orders, Reservations,
Delivery partners/zones/rules/commissions, Inventory, Waste, Exchange rates, Expenses, Reports X/Z/History/Monthly/Staff/
Settlements/Items) · Menu (catalog, categories, items with photo + prices per order type, modifiers, cooking notes,
Kitchens & Bars) · Clients/Coupons · Backup & Restore · Settings (companies, branches, users, roles, devices, printers,
registers, payment methods, channels, print queue) · My profile. To add a page: create the component, add a `<Route>` and a
NAV entry with a `perm`.

**Shared UI**: `components/ui.tsx` → `ToastProvider/useToast`, `useAction()` (runs an async call; toasts translated
success/error), `Modal`, `Numpad`, `PinDots`, `OverrideProvider/useOverride`, `Loading`. `AppBar` = top bar of the full-screen
apps (POS, KDS): brand block, company/branch, language switch, 🔒 Lock, plus right-aligned buttons passed in `right`. The
back-office shell (sidebar, user menu, theme, sign out) lives in AdminApp; theme/language/position/password in My Profile. `CrudPage`
= generic list + form. `ScaledPlan`/`Decor`/`KINDS` (FloorPlan) are used by both the POS floor and the FloorEditor designer.
`MapPicker` is lazy-loaded via `components/Map.tsx`. Use `fmt(amount, currency)` for money.

**Session**: `useSession()` → `{ me, loading, branchId, can(perm), reload, … }`. `me.user` has theme, language,
permissions, landing_page; `me.device` is set on registered terminals.

**i18n** (`src/i18n.tsx`): English source text is the key. `translate(lang, s, ...args)` keeps leading/trailing spaces
and fills `{n}`. A missing key falls back to English. Language comes from localStorage `bms:lang`, then the browser, then
`en`. It is saved to the user profile when changed in the AppBar. Locale files are flat JSON objects sorted by key. Module-level constants
(e.g. `ORDER_TYPES`, NAV labels) hold English and are passed through `tr()` at render time. Language names in
the language picker are never translated (each language is shown in its own language).

**Themes**: `gold` (default), `navy`, `emerald`, `crimson`, `slate`, set as `data-theme` on `<html>`. Colours come from CSS
variables in `styles.css`; never hard-code theme colours in components.

---

## 9. Security (keep these intact)
Zod schemas on every input (unknown keys stripped, `<>` stripped from text) · argon2id for passwords/PINs · opaque session tokens
(SHA-256 in DB) · CSRF header + Origin check · rate limits (300/min global, 10/min login/PIN, 5/min platform login,
stricter public limits) · Helmet CSP · CORS only `PUBLIC_ORIGIN` · no stack traces in production · tenant DB passwords
encrypted with `SECRETS_KEY` · Postgres only on the internal Docker network · images ≤ 1 MB, JPEG/PNG/WebP · password policy
10+ characters with upper, lower and a digit · trivial PINs rejected. Details: `docs/SECURITY.md`.

## 10. Environment
Backend env (validated in `config.ts`): `PUBLIC_ORIGIN`, `PG_HOST/PORT/USER/PASSWORD`, `PG_MASTER_DB`, `PG_SSL`,
`TENANT_DB_PREFIX` (`bms_t_`), `TENANT_POOL_MAX`, `TENANT_POOLS_CACHED`, `SECRETS_KEY` (64 hex), `SESSION_TTL_HOURS`,
`PAYMENT_PROVIDER` (`none`|`sandbox`), `DEVICE_TTL_DAYS`, `MIGRATIONS_DIR`, `BACKUP_DIR`, `LOG_LEVEL`, `NODE_ENV`.
Production compose reads `.env` (template `.env.example`, secrets via `scripts/gen-secrets.sh`). Local compose reads
`.env.local` (contains `LOCAL_PLATFORM_ADMIN`, `LOCAL_PLATFORM_PASSWORD`, …; never commit it).

## 11. Run, build, test

```bash
# Local full stack (Docker Desktop) → http://localhost:8080
docker compose -f docker-compose.local.yml --env-file .env.local up -d --build          # all
docker compose -f docker-compose.local.yml --env-file .env.local up -d --build api web  # after code changes
docker compose -f docker-compose.local.yml --env-file .env.local logs api --tail 50

# Typecheck / build
cd backend && npx tsc --noEmit
cd frontend && npx tsc -b && npx vite build

# E2E suite (stack must be running). Login rate limit is 10/min: wait ~65 s between two runs or you get 429s.
set -a; . ./.env.local; set +a
PLATFORM_ADMIN_EMAIL="$LOCAL_PLATFORM_ADMIN" PLATFORM_ADMIN_PASSWORD="$LOCAL_PLATFORM_PASSWORD" \
  BMS_TEST_URL=http://localhost:8080/api node tests/e2e.mjs          # must end with "ALL CHECKS PASSED"
```
The e2e suite provisions throwaway tenants and covers isolation, auth, POS, KDS, payments, reports, reservations,
backups and more. Add a check there for every new backend feature.

Production deployment (Ubuntu VPS, Traefik TLS): see `docs/DEPLOYMENT.md`.

## 12. Git
Work on a feature branch, then merge into `main` and push (`git push origin main`). The repo-local identity is already
set. Commit messages end with the Claude co-author line. Never commit `.env*` files except `*.example`.
