import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { isAcceptablePin, isStrongPassword, randomToken, sha256, verifySecret } from '../lib/crypto.js';
import { many, one } from '../lib/db.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { idParam, parse, reqText } from '../lib/validate.js';
import { evict, masterPool } from '../master/pools.js';
import { deleteTenant, provisionTenant } from '../master/provision.js';

const COOKIE = 'psid';
const cookie = (maxAge: number) => ({ path: '/api/platform', httpOnly: true, secure: config.secureCookies, sameSite: 'strict' as const, maxAge });

async function requireAdmin(req: FastifyRequest) {
  const tok = req.cookies[COOKIE];
  if (!tok) throw unauthorized();
  const a = await one<{ id: number; email: string }>(masterPool,
    `SELECT a.id, a.email FROM platform_sessions s JOIN platform_admins a ON a.id = s.admin_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.active`, [sha256(tok)]);
  if (!a) throw unauthorized();
  return a;
}

const log = (adminId: number | null, action: string, data: object, ip: string) =>
  masterPool.query('INSERT INTO platform_audit (admin_id, action, data, ip) VALUES ($1,$2,$3,$4)', [adminId, action, data, ip]);

export async function platformRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'bms') throw forbidden('Missing CSRF header');
  });

  app.post('/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(z.object({ email: z.string().email().max(160), password: z.string().max(200) }), req.body);
    const a = await one<any>(masterPool, 'SELECT * FROM platform_admins WHERE lower(email) = lower($1) AND active', [b.email]);
    if (a?.locked_until && new Date(a.locked_until) > new Date()) throw unauthorized('Account locked, try later');
    if (!a || !(await verifySecret(a?.password_hash, b.password))) {
      if (a) await masterPool.query(`UPDATE platform_admins SET failed_attempts = failed_attempts + 1,
          locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '30 minutes' END WHERE id = $1`, [a.id]);
      await log(a?.id ?? null, 'login.failed', { email: b.email }, req.ip);
      throw unauthorized('Invalid credentials');
    }
    const tok = randomToken(32);
    await masterPool.query(`INSERT INTO platform_sessions (token_hash, admin_id, expires_at) VALUES ($1,$2, now() + interval '8 hours')`, [sha256(tok), a.id]);
    await masterPool.query('UPDATE platform_admins SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [a.id]);
    await log(a.id, 'login', {}, req.ip);
    reply.setCookie(COOKIE, tok, cookie(8 * 3600));
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    const tok = req.cookies[COOKIE];
    if (tok) await masterPool.query('UPDATE platform_sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(tok)]);
    reply.clearCookie(COOKIE, { path: '/api/platform' });
    return { ok: true };
  });

  app.get('/me', async (req) => requireAdmin(req));

  app.get('/tenants', async (req) => {
    await requireAdmin(req);
    return many(masterPool, 'SELECT id, slug, name, status, db_name, created_at FROM tenants ORDER BY id');
  });

  app.post('/tenants', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const admin = await requireAdmin(req);
    const b = parse(z.object({
      slug: z.string().regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/, 'Lowercase letters, digits and hyphens (3-32 chars)'),
      name: reqText(120), company_name: reqText(120), currency: z.string().regex(/^[A-Z]{3}$/),
      branch_name: reqText(120), branch_code: z.string().regex(/^[A-Z0-9]{2,10}$/),
      admin_username: z.string().regex(/^[a-z0-9._-]{3,40}$/), admin_full_name: reqText(120),
      admin_password: z.string().max(200), admin_pin: z.string().optional(),
    }).strict(), req.body);
    if (!isStrongPassword(b.admin_password)) throw badRequest('Admin password must be 10+ chars with upper, lower case and a digit');
    if (b.admin_pin && !isAcceptablePin(b.admin_pin)) throw badRequest('Admin PIN must be 4 digits and not trivial');
    const t = await provisionTenant({
      slug: b.slug, name: b.name, companyName: b.company_name, currency: b.currency, branchName: b.branch_name, branchCode: b.branch_code,
      adminUsername: b.admin_username, adminFullName: b.admin_full_name, adminPassword: b.admin_password, adminPin: b.admin_pin,
    });
    await log(admin.id, 'tenant.create', { slug: b.slug }, req.ip);
    reply.code(201);
    return { ...t, url: `${config.PUBLIC_ORIGIN}/${t.slug}` };
  });

  // Display name only: the slug (URL) and database name never change.
  app.patch('/tenants/:id', async (req) => {
    const admin = await requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.strictObject({ name: reqText(120) }), req.body);
    const t = await one<any>(masterPool, 'UPDATE tenants SET name = $2, updated_at = now() WHERE id = $1 RETURNING slug', [id, b.name]);
    if (!t) throw notFound();
    evict(t.slug); // drop the cached tenant so the new name shows immediately
    await log(admin.id, 'tenant.rename', { id, name: b.name }, req.ip);
    return { ok: true };
  });

  app.post('/tenants/:id/status', async (req) => {
    const admin = await requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
    const t = await one<any>(masterPool, `UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1 AND status IN ('active','suspended') RETURNING slug`, [id, b.status]);
    if (!t) throw notFound();
    evict(t.slug);
    await log(admin.id, 'tenant.status', { id, status: b.status }, req.ip);
    return { ok: true };
  });

  app.delete('/tenants/:id', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const admin = await requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ confirm: z.string() }), req.body);
    const t = await one<any>(masterPool, 'SELECT slug FROM tenants WHERE id = $1', [id]);
    if (!t) throw notFound();
    if (b.confirm !== t.slug) throw badRequest(`Type "${t.slug}" to confirm`);
    const r = await deleteTenant(id);
    await log(admin.id, 'tenant.delete', r, req.ip);
    return r;
  });
}
