# Architecture

## Request routing (path-based multi-tenancy)

```
Browser ──HTTPS──► Traefik (TLS, HSTS, rate limit, body limit)
                     ├─ /api/*          ─► api   (Fastify)   /api/t/{tenant}/...   /api/platform/...   /api/socket.io
                     └─ everything else ─► web   (nginx)     serves the SPA; /{tenant}/... falls back to index.html
api ──(internal docker network, no internet)──► postgres
```

* The SPA reads the tenant from the first URL segment (`/pizzahut/pos`) and calls `/api/t/pizzahut/...`.
* `tenantHook` resolves the slug against the **master DB** (`tenants` table), decrypts that tenant's DB password
  (AES-256-GCM, key = `SECRETS_KEY`) and uses a **dedicated connection pool** to the tenant's own database
  (LRU-cached, `TENANT_POOL_MAX` connections each). Unknown or suspended tenants → 404.
* Reserved slugs (`api`, `platform`, `assets`, …) can't be used as tenant names.

## Databases

| Database | Owner role | Contents |
|---|---|---|
| `bms_master` | `bms_app` | `tenants` (slug → db name, db role, encrypted password, status), platform admins / sessions / audit |
| `bms_t_{slug}` (one per tenant) | `bms_t_{slug}` | Everything for that tenant — see below |

`bms_app` has `CREATEDB` + `CREATEROLE` only (**not** superuser). Provisioning (`backend/src/master/provision.ts`):

1. `CREATE ROLE bms_t_{slug} LOGIN PASSWORD <random 256-bit>` (no superuser / createdb / createrole)
2. `CREATE DATABASE bms_t_{slug} OWNER bms_t_{slug}`; then, as the tenant role: `REVOKE ALL ON DATABASE … FROM PUBLIC`, `REVOKE ALL ON SCHEMA public FROM PUBLIC`
3. Run `migrations/tenant/*.sql`, seed roles, first company/branch/register/floor/tables, channels, payment methods, admin user
4. Drop the app role's `SET` membership on the tenant role; mark tenant `active`.
   On any failure the DB, role and master row are rolled back.

Verified: tenant role A cannot connect to tenant B's DB, and `bms_app` itself cannot connect to tenant DBs.

Migrations run per database (advisory-locked) at API start for the master DB and **every** tenant DB; a failing
tenant is logged and skipped so it can't take the platform down.

## Tenant schema (`backend/migrations/tenant/001_schema.sql`)

```
companies ─┬─< branches ─┬─< registers ─< pos_sessions ─< shift_reports (X/Z snapshots)
           │             ├─< floors ─< dining_tables (qr_token)
           │             ├─< printers (kitchen | beverage | receipt)
           │             ├─< devices (pos | waiter | takeaway | kiosk | kds | print_agent)
           │             ├─< branch_stock (ingredient qty / min_qty)
           │             └─< branch_sequences (ticket no, KOT no, X/Z no)
           ├─< receipt_channels (pos, waiter, takeaway, kiosk, qr, online, delivery; optional branch)
           ├─< menu_categories (kot_route) ─< menu_items (kot_route override, tracks_stock toggle, allergens)
           │                                   ├─< item_sizes
           │                                   ├─< item_prices (item × size × branch; branch NULL = company default)
           │                                   ├─< item_modifier_groups >─ modifier_groups ─< modifiers
           │                                   └─< recipes (item [+ size]) ─< recipe_lines >─ ingredients
           ├─< clients (credit_allowed, credit_limit, balance)   ├─< coupons   ├─< payment_methods
           ├─< exchange_rates (manual, company or branch scope, effective_from)
           ├─< delivery_companies ─< delivery_commission_rules (basis delivery|item|zone|client × fixed|percent)
           ├─< delivery_zones
           └─< expense_categories ─< counter_expenses (currency, rate, base amount, register session)

tickets (company, branch, receipt_channel, register session, ticket_ref, order_type, source, table, PAX,
         client, delivery partner/zone/address, discount/coupon, tax, totals, refund status)
  ├─< ticket_lines (item, size, qty, unit price, modifiers, notes, allergy, seat, kot_route, kitchen_status, void info)
  ├─< payments (method, currency, amount, rate, base_amount, payment|refund)   ← split & multi-currency
  ├─< refunds   ├─< kot_orders (route, printer, lines)   ├─< print_jobs
  ├─< delivery_commissions (rule, basis, amount)
  ├─< cancellations (line | ticket | table_clear, amount, reason, user, approver, session)  ← shown on X/Z
  └─< stock_movements (ingredient, qty_change, balance_after, kind, ticket_id, ticket_line_id, ticket_ref)
users (argon2id password + PIN, role, lockout) ─< user_access (company, branch|NULL = all branches)
roles (permissions[]), sessions, audit_log, waste_logs, currencies
```

## Key flows

**Order → kitchen.** `POST /pos/tickets/:id/send` (`services/kot.ts`): new lines of stock-tracked items deduct their
recipe from branch stock with the ticket reference on every movement; lines are grouped by route and written as KOTs:
food → branch kitchen printer, drinks → beverage printer. Each KOT becomes a `print_job` and a `kds:new` event.

**Printing.** The VPS can't reach printers on a restaurant LAN, so `print-agent/` runs in the restaurant, connects
**out** over WSS with a device token, receives jobs for its branch, renders ESC/POS and acks. Jobs queued while the
agent is offline are replayed on reconnect. The agent only prints to private-network addresses (or an allowlist).

**Payments.** Multiple payments per ticket, each with method + currency; foreign currency is converted with the
latest manual rate (branch rate overrides company rate). Only cash may exceed the amount due (change). Credit method
requires a credit-enabled client on the ticket (limit enforced, balance updated) and prints the client on the receipt.
Split checks move lines (by seat or by item quantity) to a new ticket; split-by-amount = partial payments.

**Delivery commissions** (`services/commission.ts`), computed when a delivery ticket is paid (recomputed on refunds):
order-level rule = most specific of client rule › zone rule › per-delivery rule (fixed or % of total); item rules add
per-unit fixed or % of line. Every delivery is charged its own commission.

**Register sessions / reports.** A register session opens on first activity (or explicitly with a float). X = snapshot
without closing; Z closes the session and stores the snapshot. Both include sales, order types, channels, payment
modes, currencies, cash drawer reconciliation, counter expenses, delivery commissions, discounts, refunds and all
voided lines / cancelled tickets / cleared tables. The monthly report aggregates paid tickets over all receipt channels
by company / branch / tenant (in each branch's local timezone), plus commissions, expenses, waste and cancellations.

## Realtime

Socket.IO at `/api/socket.io`, authenticated with the session cookie (staff), device cookie (kiosk) or device token
(print agent). Rooms: `{tenant}:{branch}` (floor plan, KDS, new customer orders, low stock) and
`{tenant}:{branch}:print`. Events are emitted only after the DB transaction commits.
