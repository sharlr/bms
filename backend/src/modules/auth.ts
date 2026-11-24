import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { hashSecret, isAcceptablePin, isStrongPassword, randomToken, sha256, verifySecret } from '../lib/crypto.js';
import { many, one } from '../lib/db.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { PERMISSIONS } from '../lib/permissions.js';
import { id, idParam, parse, reqText } from '../lib/validate.js';
import {
  audit, branchCtx, canAccessBranch, cookieOpts, deviceCookie, requirePerm, requireUser, sessionCookie,
} from '../plugins/context.js';

const LOGIN_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

async function registerFailure(req: FastifyRequest, userId: number) {
  await req.tenant.pool.query(
    `UPDATE users SET failed_attempts = failed_attempts + 1,
        locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
      WHERE id = $1`, [userId, MAX_FAILS, LOCK_MINUTES]);
}

async function startSession(req: FastifyRequest, reply: FastifyReply, userId: number, deviceId: number | null) {
  const token = randomToken(32);
  const ttlH = config.SESSION_TTL_HOURS;
  await req.tenant.pool.query(
    `INSERT INTO sessions (token_hash, user_id, device_id, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6))`,
    [sha256(token), userId, deviceId, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), ttlH]);
  await req.tenant.pool.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [userId]);
  reply.setCookie(sessionCookie(req.tenant.slug), token, cookieOpts(ttlH * 3600));
}

async function contextFor(req: FastifyRequest) {
  const a = req.auth;
  if (!a) return null;
  const params: unknown[] = [];
  let filter = '';
  if (!a.user.is_tenant_admin) {
    params.push(a.user.id);
    filter = `AND EXISTS (SELECT 1 FROM user_access ua WHERE ua.user_id = $1 AND ua.company_id = b.company_id
                          AND (ua.branch_id IS NULL OR ua.branch_id = b.id))`;
  }
  const branches = await many<any>(req.tenant.pool,
    `SELECT b.id, b.name, b.code, b.company_id, c.name AS company_name, c.base_currency
       FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.active AND c.active ${filter} ORDER BY c.name, b.name`, params);
  const companies = [...new Map(branches.map((b) => [b.company_id, { id: b.company_id, name: b.company_name, base_currency: b.base_currency }])).values()];
  return { companies, branches };
}

export function authRoutes(app: FastifyInstance) {
  app.get('/auth/me', async (req) => {
    const a = req.auth;
    return {
      tenant: { slug: req.tenant.slug, name: req.tenant.name },
      device: req.device ? { id: req.device.id, name: req.device.name, mode: req.device.mode, branch_id: req.device.branch_id, register_id: req.device.register_id } : null,
      user: a ? { ...a.user, permissions: a.user.is_tenant_admin ? ['*'] : [...a.perms], device_bound: !!a.deviceId } : null,
      context: await contextFor(req),
    };
  });

  app.get('/auth/permissions', async (req) => { requireUser(req); return PERMISSIONS; });

  // Back-office username + password login.
  app.post('/auth/login', { config: LOGIN_LIMIT }, async (req, reply) => {
    const body = parse(z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200), branch_id: id.optional() }), req.body);
    const u = await one<any>(req.tenant.pool,
      'SELECT id, password_hash, locked_until FROM users WHERE lower(username) = lower($1) AND active', [body.username]);
    if (u?.locked_until && new Date(u.locked_until) > new Date()) throw unauthorized('Account temporarily locked. Try again later.');
    const ok = await verifySecret(u?.password_hash, body.password);
    if (!u || !ok) {
      if (u) await registerFailure(req, u.id);
      throw unauthorized('Invalid username or password');
    }
    // Branch chosen on the login screen: checked only after the password, so it reveals nothing to strangers.
    let branch: any = null;
    if (body.branch_id) {
      branch = await one<any>(req.tenant.pool,
        `SELECT b.id, b.company_id FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.id = $1 AND b.active AND c.active`, [body.branch_id]);
      const access = await many<any>(req.tenant.pool, 'SELECT company_id, branch_id FROM user_access WHERE user_id = $1', [u.id]);
      const admin = await one<any>(req.tenant.pool, 'SELECT is_tenant_admin FROM users WHERE id = $1', [u.id]);
      if (!branch || !canAccessBranch({ user: { is_tenant_admin: admin.is_tenant_admin }, access } as any, branch.company_id, branch.id))
        throw forbidden('You are not assigned to this branch');
    }
    await startSession(req, reply, u.id, null);
    await audit(req, 'login', 'users', u.id, { method: 'password', branch: branch?.id ?? null });
    return { ok: true, branch_id: branch?.id ?? null, company_id: branch?.company_id ?? null };
  });

  // Staff grid shown on a registered terminal.
  app.get('/auth/staff', async (req) => {
    const d = req.device;
    if (!d || d.mode === 'print_agent' || d.mode === 'kiosk') throw unauthorized('This screen must be registered as a terminal');
    return many(req.tenant.pool,
      `SELECT u.id, u.full_name, u.color, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.active AND u.pin_hash IS NOT NULL
          AND (u.is_tenant_admin OR EXISTS (SELECT 1 FROM user_access ua WHERE ua.user_id = u.id AND ua.company_id = $1
                                              AND (ua.branch_id IS NULL OR ua.branch_id = $2)))
        ORDER BY u.full_name`, [d.company_id, d.branch_id]);
  });

  // 4-digit PIN login — only from a registered device, rate limited, with account lockout.
  app.post('/auth/pin', { config: LOGIN_LIMIT }, async (req, reply) => {
    const d = req.device;
    if (!d || d.mode === 'print_agent' || d.mode === 'kiosk') throw unauthorized('PIN login is only allowed on registered terminals');
    const body = parse(z.object({ user_id: id, pin: z.string().regex(/^\d{4}$/) }), req.body);
    const u = await one<any>(req.tenant.pool,
      'SELECT id, pin_hash, locked_until, is_tenant_admin FROM users WHERE id = $1 AND active', [body.user_id]);
    if (!u) throw unauthorized('Invalid PIN');
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw unauthorized('Too many attempts. Ask a manager or wait 15 minutes.');
    if (!(await verifySecret(u.pin_hash, body.pin))) {
      await registerFailure(req, u.id);
      throw unauthorized('Invalid PIN');
    }
    const access = await many<any>(req.tenant.pool, 'SELECT company_id, branch_id FROM user_access WHERE user_id = $1', [u.id]);
    const fake = { user: { is_tenant_admin: u.is_tenant_admin }, access } as any;
    if (!canAccessBranch(fake, d.company_id, d.branch_id)) throw forbidden('You are not assigned to this branch');
    await startSession(req, reply, u.id, d.id);
    await audit(req, 'login', 'users', u.id, { method: 'pin', device: d.id });
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) await req.tenant.pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.auth.sessionId]);
    reply.clearCookie(sessionCookie(req.tenant.slug), { path: '/api' });
    return { ok: true };
  });

  app.post('/auth/change-password', { config: LOGIN_LIMIT }, async (req) => {
    const a = requireUser(req);
    const b = parse(z.object({ current: z.string().max(200), next: z.string().max(200) }), req.body);
    const u = await one<any>(req.tenant.pool, 'SELECT password_hash FROM users WHERE id = $1', [a.user.id]);
    if (u.password_hash && !(await verifySecret(u.password_hash, b.current))) throw unauthorized('Current password is wrong');
    if (!isStrongPassword(b.next)) throw badRequest('Password must be 10+ chars with upper, lower case and a digit');
    await req.tenant.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [a.user.id, await hashSecret(b.next)]);
    await req.tenant.pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2', [a.user.id, a.sessionId]);
    return { ok: true };
  });

  // My profile: display preferences + position. Name/role/access stay with users.manage.
  app.patch('/auth/profile', async (req) => {
    const a = requireUser(req);
    const b = parse(z.strictObject({
      position: z.string().max(80).transform((s) => s.trim() || null).nullable().optional(),
      theme: z.enum(['gold', 'navy', 'emerald', 'crimson', 'slate']).optional(),
      landing_page: z.enum(['auto', 'home', 'pos', 'kds', 'orders']).optional(),
      language: z.enum(['en', 'fr']).optional(),
    }), req.body);
    const cols = Object.keys(b);
    if (!cols.length) throw badRequest('Nothing to update');
    await req.tenant.pool.query(`UPDATE users SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [a.user.id, ...cols.map((k) => (b as any)[k])]);
    return { ok: true };
  });

  app.post('/auth/change-pin', { config: LOGIN_LIMIT }, async (req) => {
    const a = requireUser(req);
    const b = parse(z.object({ pin: z.string() }), req.body);
    if (!isAcceptablePin(b.pin)) throw badRequest('PIN must be 4 digits and not trivially guessable');
    await req.tenant.pool.query('UPDATE users SET pin_hash = $2 WHERE id = $1', [a.user.id, await hashSecret(b.pin)]);
    return { ok: true };
  });

  // ----- Devices (terminals) -----
  app.post('/auth/devices', async (req, reply) => {
    const a = requirePerm(req, 'org.manage');
    const ctx = await branchCtx(req);
    const b = parse(z.object({
      name: reqText(60), mode: z.enum(['pos', 'waiter', 'takeaway', 'kiosk', 'kds', 'print_agent']), register_id: id.nullable().optional(),
    }), req.body);
    if (b.register_id && !(await one(req.tenant.pool, 'SELECT 1 FROM registers WHERE id = $1 AND branch_id = $2', [b.register_id, ctx.branchId])))
      throw badRequest('Invalid register');
    const token = randomToken(32);
    const d = await one<any>(req.tenant.pool,
      `INSERT INTO devices (branch_id, register_id, name, mode, token_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, branch_id, register_id, name, mode, created_at`,
      [ctx.branchId, b.register_id ?? null, b.name, b.mode, sha256(token), a.user.id]);
    await audit(req, 'device.register', 'devices', d.id, { mode: b.mode });
    if (b.mode === 'print_agent') return { ...d, token }; // shown once, pasted into the print agent config
    reply.setCookie(deviceCookie(req.tenant.slug), token, cookieOpts(config.DEVICE_TTL_DAYS * 86400));
    // The registering manager's own session is not device-bound; terminal staff log in with their PIN next.
    return d;
  });

  app.get('/devices', async (req) => {
    requirePerm(req, 'org.manage');
    const ctx = await branchCtx(req);
    return many(req.tenant.pool,
      `SELECT d.id, d.name, d.mode, d.register_id, d.created_at, d.last_seen_at, d.revoked_at, u.full_name AS created_by_name
         FROM devices d LEFT JOIN users u ON u.id = d.created_by WHERE d.branch_id = $1 ORDER BY d.revoked_at NULLS FIRST, d.id`,
      [ctx.branchId]);
  });

  app.delete('/devices/:id', async (req) => {
    requirePerm(req, 'org.manage');
    const ctx = await branchCtx(req);
    const { id: devId } = parse(idParam, req.params);
    const r = await req.tenant.pool.query('UPDATE devices SET revoked_at = now() WHERE id = $1 AND branch_id = $2 AND revoked_at IS NULL', [devId, ctx.branchId]);
    if (!r.rowCount) throw notFound();
    await req.tenant.pool.query('UPDATE sessions SET revoked_at = now() WHERE device_id = $1', [devId]);
    await audit(req, 'device.revoke', 'devices', devId);
    return { ok: true };
  });

  app.post('/auth/forget-device', async (req, reply) => {
    requirePerm(req, 'org.manage');
    reply.clearCookie(deviceCookie(req.tenant.slug), { path: '/api' });
    return { ok: true };
  });
}
