# Security

How each item of the hardening checklist is implemented, and the results of the audit run on 2026-11-24.

| Checklist item | Implementation |
|---|---|
| **Hide API keys and secrets** | All secrets come from environment variables (`.env` on the server, never committed — `.gitignore` covers `.env*`, keys, dumps). Tenant DB passwords are random 256-bit values, stored AES-256-GCM encrypted in the master DB. The print-agent token is shown once and stored only as a SHA-256 hash. The frontend bundle contains no secrets. |
| **Check environment variables** | `backend/src/config.ts` validates every variable with Zod at boot, prints only *which* keys are invalid (never values) and refuses to start in production with a weak `PG_PASSWORD` or a placeholder/dev `SECRETS_KEY`. |
| **Protect admin routes** | Platform console (`/api/platform/*`): separate admin table, cookie scoped to `/api/platform`, 5 logins/min + 30-min lockout, audit log. Tenant back office: every route checks session + named permission (`requirePerm`). Roles can only be edited by tenant administrators; non-admins can't modify tenant admins, grant tenant-admin, or assign roles with permissions they don't hold (regression-tested). |
| **Implement proper authentication** | Opaque 256-bit session tokens (SHA-256 hashed in DB) in `HttpOnly; Secure; SameSite=Strict` cookies with 12 h expiry and server-side revocation (logout, password change, user disable, device revoke). PIN login only works on **registered devices** (device token cookie), with per-IP rate limiting and 5-attempt / 15-min account lockout. Sensitive POS actions (void, cancel, clear table, refund, discount) need the permission or a **manager PIN override**, also lockout-protected. |
| **Validate user access** | Every query is scoped: tenant (separate DB) → company (`company_id`) → branch (`branch_id`). `branchCtx()` validates the active branch against `user_access`; device-bound sessions are pinned to the device's branch. The generic CRUD layer checks that every foreign key (category, floor, client, zone, branch, …) belongs to the same company/branch, so IDs from another company are rejected. |
| **Sanitize forms and prevent XSS** | All input is parsed by strict Zod schemas (unknown keys rejected, lengths capped, control chars and `<>` stripped from free text). React escapes all output; no `dangerouslySetInnerHTML`. Image URLs must be `https://`. Strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`). |
| **Add rate limiting** | Traefik: 50 req/s average per client to `/api`. Fastify: 300 req/min global, 10/min on login/PIN, 5/min on platform login, 8/min on public orders, 10/min on table lookup. |
| **Secure API endpoints** | CSRF: every state-changing request must carry `X-Requested-With: bms` (cannot be sent cross-site without a CORS preflight, which is refused) and a matching `Origin`. 512 KB body limit (1 MB at the edge). Production errors return a generic message; Postgres errors are mapped to safe 4xx messages. Public endpoints expose only menu, delivery partners and order status by unguessable token. |
| **Review CORS settings** | API and Socket.IO allow only `PUBLIC_ORIGIN` (same origin as the SPA), credentials on, explicit method list. |
| **Add security headers** | Traefik: HSTS (2 years, preload), nosniff, frame deny, referrer policy, permissions policy, `Server` header stripped, TLS ≥ 1.2. nginx: CSP + same headers for the SPA. Fastify: Helmet (CSP `default-src 'none'`, CORP same-origin, HSTS). |
| **Disable production debug mode** | `NODE_ENV=production` in compose; no stack traces in responses; source maps not built; Traefik dashboard disabled; logs redact cookies / `Authorization` / `Set-Cookie`; dev-only logging off. |
| **Update vulnerable dependencies** | `npm audit`: **0 vulnerabilities** in backend, frontend and print-agent. Zod was upgraded 3 → 4 to fix GHSA-mrhx-c7xc-m3w5 (memory exhaustion); the one behavioural change it introduced (defaults applied inside partial schemas) was found and fixed, with a regression test. |
| **Remove unused packages** | Every dependency is imported by the code (checked per package); no dev tools ship in production images (`npm ci --omit=dev`). |
| **Check for exposed files** | nginx serves only the built `dist/`; dotfiles and `*.map` return 404; `.dockerignore` keeps `.env`, `node_modules`, logs out of images; `robots.txt` disallows indexing. |
| **Secure database access** | PostgreSQL is only on an `internal: true` Docker network (no host port, no internet). SCRAM-SHA-256 auth. The app role is **not superuser** (CREATEDB + CREATEROLE only). Each tenant DB is owned by its own role, with `CONNECT` and `public`-schema rights revoked from `PUBLIC` — verified: tenant A's role can't connect to tenant B's DB, and the app role can't read tenant DBs. All SQL uses bind parameters; dynamic identifiers come only from whitelisted schema keys and pass `ident()` validation. |
| **Hash passwords properly** | argon2id (19 MiB, t=2) for passwords, PINs and platform admins; constant-work verification for unknown users. Password policy: 10+ chars with upper, lower and a digit. Trivial PINs (0000, 1234, …) rejected. |
| **Scan Git history for leaked secrets** | Full history (`git log --all -p`) and working tree scanned for passwords, API keys, tokens, AWS/GitHub/Slack keys and private keys: **nothing found** (history contains only the initial README/LICENSE commit). |
| **Run a security audit** | See below. |

## Audit results (2026-11-24)

* `tests/e2e.mjs`: **60/60 checks passed** against PostgreSQL 17, including: tenant isolation (a session from tenant B is useless on tenant A), CSRF enforcement, password and PIN rejection, staff grid hidden from unregistered browsers, customer token can't reach staff APIs, privilege-escalation guards, trivial-PIN rejection, permission denial for reports.
* Database-level isolation verified directly with PostgreSQL roles (see above).
* Production boot verified: refuses weak secrets, sends security headers, hides internal errors, and one broken tenant can't block startup.
* **Issue found and fixed during the audit:** a non-admin with `users.manage` could have reset a tenant admin's password or assigned the Administrator role. Fixed and covered by tests.

## Operational recommendations

* Keep `BMS_SECRETS_KEY` and backups off-server; restrict SSH to keys only; enable unattended upgrades.
* Rotate the platform admin password periodically; review `platform_audit` and each tenant's `audit_log`.
* Re-run `npm audit` and rebuild images monthly (`docker compose build --pull`).
* Give POS terminals, kiosks and print agents their own VLAN / Wi-Fi where possible.
