import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { sha256, verifySecret } from '../lib/crypto.js';
import { many, one } from '../lib/db.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import type { Permission } from '../lib/permissions.js';
import { getTenant, type Tenant } from '../master/pools.js';

export interface AccessEntry { company_id: number; branch_id: number | null }
export interface AuthCtx {
  sessionId: number;
  user: { id: number; username: string; full_name: string; is_tenant_admin: boolean; role_name: string; color: string; position: string | null; theme: string; language: string; landing_page: string };
  perms: Set<string>;
  access: AccessEntry[];
  deviceId: number | null;
}
export interface DeviceCtx { id: number; branch_id: number; company_id: number; register_id: number | null; mode: string; name: string }
export interface BranchCtx {
  companyId: number; branchId: number; currency: string; branchCode: string; branchName: string; companyName: string;
  taxRate: number; taxInclusive: boolean; autoAcceptSelfOrders: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant;
    auth: AuthCtx | null;
    device: DeviceCtx | null;
    _branch?: BranchCtx;
  }
}

export const sessionCookie = (slug: string) => `sid_${slug.replace(/-/g, '_')}`;
export const deviceCookie = (slug: string) => `dev_${slug.replace(/-/g, '_')}`;
export const cookieOpts = (maxAgeSec: number) => ({
  path: '/api', httpOnly: true, secure: config.secureCookies, sameSite: 'strict' as const, maxAge: maxAgeSec,
});

/** onRequest hook for /api/t/:tenant/* — resolves the tenant DB and enforces CSRF header. */
export async function tenantHook(req: FastifyRequest<{ Params: { tenant: string } }>, _reply: FastifyReply) {
  const t = await getTenant((req.params as any).tenant);
  if (!t) throw notFound('Unknown restaurant');
  req.tenant = t;
  req.auth = null;
  req.device = null;
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (unsafe && !req.headers.authorization) {
    // Custom header cannot be sent cross-site without a CORS preflight, which we refuse => CSRF protection.
    if (req.headers['x-requested-with'] !== 'bms') throw forbidden('Missing CSRF header');
    const origin = req.headers.origin;
    if (origin && origin !== config.PUBLIC_ORIGIN) throw forbidden('Bad origin');
  }
}

/** preHandler: load device + user session from cookies (or Device bearer token for print agents). */
export async function loadAuth(req: FastifyRequest) {
  const slug = req.tenant.slug;
  const pool = req.tenant.pool;
  let devToken = req.cookies[deviceCookie(slug)];
  const authz = req.headers.authorization;
  if (authz?.startsWith('Device ')) devToken = authz.slice(7).trim();
  if (devToken) {
    const d = await one<DeviceCtx>(
      pool,
      `UPDATE devices d SET last_seen_at = now() FROM branches b
       WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND b.id = d.branch_id AND b.active
         AND d.created_at > now() - make_interval(days => $2)
       RETURNING d.id, d.branch_id, b.company_id, d.register_id, d.mode, d.name`,
      [sha256(devToken), config.DEVICE_TTL_DAYS],
    );
    req.device = d ?? null;
  }
  const sid = req.cookies[sessionCookie(slug)];
  if (sid) req.auth = await sessionFromToken(pool, sid);
}

export async function sessionFromToken(pool: Tenant['pool'], token: string): Promise<AuthCtx | null> {
  const s = await one<any>(
    pool,
    `UPDATE sessions s SET last_seen_at = now()
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.id = s.user_id AND u.active
      RETURNING s.id AS session_id, s.device_id, u.id, u.username, u.full_name, u.is_tenant_admin, u.color, u.position, u.theme, u.language, u.landing_page,
                r.name AS role_name, r.permissions`,
    [sha256(token)],
  );
  if (!s) return null;
  const access = await many<AccessEntry>(pool, 'SELECT company_id, branch_id FROM user_access WHERE user_id = $1', [s.id]);
  return {
    sessionId: s.session_id,
    deviceId: s.device_id,
    user: { id: s.id, username: s.username, full_name: s.full_name, is_tenant_admin: s.is_tenant_admin, role_name: s.role_name, color: s.color, position: s.position, theme: s.theme, language: s.language, landing_page: s.landing_page },
    perms: new Set<string>(s.permissions),
    access,
  };
}

export function requireUser(req: FastifyRequest): AuthCtx {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export const hasPerm = (a: AuthCtx, p: Permission) => a.user.is_tenant_admin || a.perms.has('*') || a.perms.has(p);

export function requirePerm(req: FastifyRequest, ...perms: Permission[]): AuthCtx {
  const a = requireUser(req);
  for (const p of perms) if (!hasPerm(a, p)) throw forbidden(`Missing permission: ${p}`);
  return a;
}

export function canAccessCompany(a: AuthCtx, companyId: number) {
  return a.user.is_tenant_admin || a.access.some((x) => x.company_id === companyId);
}
export function canAccessBranch(a: AuthCtx, companyId: number, branchId: number) {
  return a.user.is_tenant_admin || a.access.some((x) => x.company_id === companyId && (x.branch_id === null || x.branch_id === branchId));
}

export async function loadBranch(req: FastifyRequest, branchId: number): Promise<BranchCtx> {
  const b = await one<any>(
    req.tenant.pool,
    `SELECT b.id, b.company_id, b.code, b.name, b.tax_rate, b.tax_inclusive, b.auto_accept_self_orders,
            c.base_currency, c.name AS company_name
       FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.id = $1 AND b.active AND c.active`,
    [branchId],
  );
  if (!b) throw notFound('Branch not found');
  return {
    companyId: b.company_id, branchId: b.id, currency: b.base_currency, branchCode: b.code, branchName: b.name,
    companyName: b.company_name, taxRate: b.tax_rate, taxInclusive: b.tax_inclusive,
    autoAcceptSelfOrders: b.auto_accept_self_orders,
  };
}

/**
 * Active company/branch context. Device-bound sessions are pinned to the device's branch;
 * back-office users pick it with the X-Branch-Id header (the header/sidebar context switcher).
 */
export async function branchCtx(req: FastifyRequest): Promise<BranchCtx> {
  if (req._branch) return req._branch;
  const a = requireUser(req);
  let branchId: number | null = null;
  if (a.deviceId && req.device && req.device.id === a.deviceId) branchId = req.device.branch_id;
  else {
    const h = req.headers['x-branch-id'];
    if (typeof h === 'string' && /^\d+$/.test(h)) branchId = Number(h);
  }
  if (!branchId) throw badRequest('Select a branch first', 'branch_required');
  const ctx = await loadBranch(req, branchId);
  if (!canAccessBranch(a, ctx.companyId, ctx.branchId)) throw forbidden('No access to this branch');
  req._branch = ctx;
  return ctx;
}

/** Branch context for an unauthenticated device (kiosk). */
export async function deviceBranchCtx(req: FastifyRequest, ...modes: string[]): Promise<BranchCtx> {
  if (!req.device || !modes.includes(req.device.mode)) throw unauthorized('Registered device required');
  return loadBranch(req, req.device.branch_id);
}

/** Company context: X-Company-Id header, else the active branch's company. */
export async function companyCtx(req: FastifyRequest): Promise<number> {
  const a = requireUser(req);
  const h = req.headers['x-company-id'];
  let companyId: number | null = typeof h === 'string' && /^\d+$/.test(h) ? Number(h) : null;
  if (!companyId) companyId = (await branchCtx(req)).companyId;
  if (!canAccessCompany(a, companyId)) throw forbidden('No access to this company');
  return companyId;
}

export function companyIdsFor(a: AuthCtx): number[] | null {
  return a.user.is_tenant_admin ? null : [...new Set(a.access.map((x) => x.company_id))];
}

/**
 * Permission check with optional manager override (supervisor enters their PIN on the terminal).
 * Returns the id of the user who authorised the action.
 */
export async function authorize(
  req: FastifyRequest, perm: Permission, override?: { user_id: number; pin: string } | null,
): Promise<number> {
  const a = requireUser(req);
  if (hasPerm(a, perm)) return a.user.id;
  if (!override) throw forbidden(`Manager approval required (${perm})`);
  const u = await one<any>(
    req.tenant.pool,
    `SELECT u.id, u.pin_hash, u.is_tenant_admin, u.locked_until, r.permissions FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.active`,
    [override.user_id],
  );
  if (!u || (u.locked_until && new Date(u.locked_until) > new Date())) throw forbidden('Approval rejected');
  const ok = await verifySecret(u.pin_hash, override.pin);
  if (!ok) {
    await req.tenant.pool.query(
      `UPDATE users SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '5 minutes' END WHERE id = $1`, [u.id]);
    throw forbidden('Approval rejected');
  }
  const perms = new Set<string>(u.permissions);
  if (!(u.is_tenant_admin || perms.has('*') || perms.has(perm))) throw forbidden('Approver lacks permission');
  const ctx = await branchCtx(req);
  const access = await many<AccessEntry>(req.tenant.pool, 'SELECT company_id, branch_id FROM user_access WHERE user_id = $1', [u.id]);
  if (!u.is_tenant_admin && !access.some((x) => x.company_id === ctx.companyId && (x.branch_id === null || x.branch_id === ctx.branchId))) {
    throw forbidden('Approver has no access to this branch');
  }
  return u.id;
}

export async function audit(req: FastifyRequest, action: string, entity: string | null, entityId: number | null, data: object = {}) {
  await req.tenant.pool.query(
    'INSERT INTO audit_log (user_id, action, entity, entity_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.auth?.user.id ?? null, action, entity, entityId, data, req.ip],
  );
}
