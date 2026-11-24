import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashSecret, isAcceptablePin, isStrongPassword } from '../lib/crypto.js';
import { many, one, tx } from '../lib/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { color, currency, id, idParam, parse, reqText, text } from '../lib/validate.js';
import { audit, canAccessCompany, companyIdsFor, requirePerm, requireUser } from '../plugins/context.js';
import { seedBranchDefaults, seedCompanyDefaults } from '../services/seed.js';

const companySchema = z.object({
  name: reqText(120), legal_name: text(160).nullable(), tax_id: text(60).nullable(), address: text(300).nullable(),
  phone: text(40).nullable(), email: z.string().email().max(120).nullable().or(z.literal('')), base_currency: currency, active: z.boolean(),
});

const branchSchema = z.object({
  company_id: id, name: reqText(120), code: z.string().regex(/^[A-Z0-9]{2,10}$/, 'Code: 2-10 uppercase letters/digits'),
  address: text(300).nullable(), phone: text(40).nullable(), timezone: z.string().max(60).refine((tz) => {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
  }, 'Invalid timezone'),
  receipt_header: text(500).nullable(), receipt_footer: text(500).nullable(),
  tax_rate: z.coerce.number().min(0).max(99), tax_inclusive: z.boolean(), online_ordering: z.boolean(),
  auto_accept_self_orders: z.boolean(), active: z.boolean(),
  lat: z.coerce.number().min(-90).max(90).nullable(), lng: z.coerce.number().min(-180).max(180).nullable(),
});

const accessSchema = z.array(z.object({ company_id: id, branch_id: id.nullable() })).max(200);
const userSchema = z.object({
  username: z.string().regex(/^[a-z0-9._-]{3,40}$/, 'Username: 3-40 lowercase letters, digits, . _ -'),
  full_name: reqText(120), position: text(80).nullish(), landing_page: z.enum(['auto', 'home', 'pos', 'kds', 'orders']).optional(), password: z.string().max(200).nullable(), pin: z.string().nullable(),
  role_id: id, is_tenant_admin: z.boolean(), color, active: z.boolean(), access: accessSchema,
});

export function orgRoutes(app: FastifyInstance) {
  // ----- Companies -----
  app.get('/companies', async (req) => {
    const a = requireUser(req);
    const ids = companyIdsFor(a);
    return many(req.tenant.pool, `SELECT * FROM companies WHERE ($1::bigint[] IS NULL OR id = ANY($1)) ORDER BY name`, [ids]);
  });

  app.post('/companies', async (req, reply) => {
    const a = requirePerm(req, 'org.manage');
    if (!a.user.is_tenant_admin) throw forbidden('Only tenant administrators can create companies');
    const b = parse(companySchema.partial({ legal_name: true, tax_id: true, address: true, phone: true, email: true, active: true }).strict(), req.body);
    const row = await tx(req.tenant.pool, async (c) => {
      const co = await one<any>(c,
        `INSERT INTO companies (name, legal_name, tax_id, address, phone, email, base_currency) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.name, b.legal_name ?? null, b.tax_id ?? null, b.address ?? null, b.phone ?? null, b.email || null, b.base_currency]);
      await seedCompanyDefaults(c, co.id);
      return co;
    });
    await audit(req, 'create', 'companies', row.id);
    reply.code(201);
    return row;
  });

  app.patch('/companies/:id', async (req) => {
    const a = requirePerm(req, 'org.manage');
    const { id: cid } = parse(idParam, req.params);
    if (!canAccessCompany(a, cid)) throw forbidden();
    const b = parse(companySchema.partial().strict(), req.body);
    const cols = Object.keys(b);
    if (!cols.length) throw badRequest('Nothing to update');
    const row = await one(req.tenant.pool,
      `UPDATE companies SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [cid, ...cols.map((k) => (b as any)[k] === '' ? null : (b as any)[k])]);
    if (!row) throw notFound();
    await audit(req, 'update', 'companies', cid, { fields: cols });
    return row;
  });

  // ----- Branches -----
  app.get('/branches', async (req) => {
    const a = requireUser(req);
    const ids = companyIdsFor(a);
    const rows = await many<any>(req.tenant.pool,
      `SELECT b.*, c.name AS company_name FROM branches b JOIN companies c ON c.id = b.company_id
        WHERE ($1::bigint[] IS NULL OR b.company_id = ANY($1)) ORDER BY c.name, b.name`, [ids]);
    if (a.user.is_tenant_admin) return rows;
    return rows.filter((b) => a.access.some((x) => x.company_id === b.company_id && (x.branch_id === null || x.branch_id === b.id)));
  });

  app.post('/branches', async (req, reply) => {
    const a = requirePerm(req, 'org.manage');
    const b = parse(branchSchema.partial({
      address: true, phone: true, timezone: true, receipt_header: true, receipt_footer: true, tax_rate: true, tax_inclusive: true,
      online_ordering: true, auto_accept_self_orders: true, active: true, lat: true, lng: true,
    }).strict(), req.body);
    if (!canAccessCompany(a, b.company_id) || (!a.user.is_tenant_admin && !a.access.some((x) => x.company_id === b.company_id && x.branch_id === null)))
      throw forbidden('Company-wide access required to create branches');
    const cols = Object.keys(b);
    const row = await tx(req.tenant.pool, async (c) => {
      const br = await one<any>(c,
        `INSERT INTO branches (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        cols.map((k) => (b as any)[k]));
      await seedBranchDefaults(c, br.id);
      return br;
    });
    await audit(req, 'create', 'branches', row.id);
    reply.code(201);
    return row;
  });

  app.patch('/branches/:id', async (req) => {
    const a = requirePerm(req, 'org.manage');
    const { id: bid } = parse(idParam, req.params);
    const cur = await one<any>(req.tenant.pool, 'SELECT company_id FROM branches WHERE id = $1', [bid]);
    if (!cur || !canAccessCompany(a, cur.company_id)) throw notFound();
    const b = parse(branchSchema.omit({ company_id: true }).partial().strict(), req.body);
    const cols = Object.keys(b);
    if (!cols.length) throw badRequest('Nothing to update');
    const row = await one(req.tenant.pool,
      `UPDATE branches SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [bid, ...cols.map((k) => (b as any)[k])]);
    await audit(req, 'update', 'branches', bid, { fields: cols });
    return row;
  });

  // ----- Users -----
  app.get('/users', async (req) => {
    requirePerm(req, 'users.manage');
    const users = await many<any>(req.tenant.pool,
      `SELECT u.id, u.username, u.full_name, u.role_id, r.name AS role_name, u.is_tenant_admin, u.color, u.position, u.landing_page, u.active,
              u.password_hash IS NOT NULL AS has_password, u.pin_hash IS NOT NULL AS has_pin, u.locked_until, u.created_at
         FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.full_name`);
    const access = await many<any>(req.tenant.pool, 'SELECT user_id, company_id, branch_id FROM user_access');
    return users.map((u) => ({ ...u, access: access.filter((x) => x.user_id === u.id).map(({ company_id, branch_id }) => ({ company_id, branch_id })) }));
  });

  const saveUser = async (req: any, userId: number | null) => {
    const a = requirePerm(req, 'users.manage');
    const schema = userId ? userSchema.partial() : userSchema.partial({ password: true, pin: true, is_tenant_admin: true, color: true, active: true });
    const b = parse(schema.strict(), req.body) as Partial<z.infer<typeof userSchema>>;
    if (b.is_tenant_admin !== undefined && !a.user.is_tenant_admin) throw forbidden('Only tenant administrators can change tenant-admin status');
    // Privilege-escalation guards for non tenant-admins with users.manage:
    if (!a.user.is_tenant_admin) {
      if (userId) {
        const target = await one<any>(req.tenant.pool, 'SELECT is_tenant_admin FROM users WHERE id = $1', [userId]);
        if (!target) throw notFound();
        if (target.is_tenant_admin) throw forbidden('Only tenant administrators can modify a tenant administrator');
        const targetAccess = await many<any>(req.tenant.pool, 'SELECT company_id FROM user_access WHERE user_id = $1', [userId]);
        if (targetAccess.some((x) => !canAccessCompany(a, x.company_id))) throw forbidden('User belongs to a company you do not manage');
      }
      if (b.role_id) {
        const role = await one<any>(req.tenant.pool, 'SELECT permissions FROM roles WHERE id = $1', [b.role_id]);
        if (!role) throw badRequest('Invalid role');
        const own = a.perms;
        if (!own.has('*') && (role.permissions as string[]).some((p) => p === '*' || !own.has(p)))
          throw forbidden('You can only assign roles whose permissions you hold yourself');
      }
    }
    if (b.password && !isStrongPassword(b.password)) throw badRequest('Password must be 10+ chars with upper, lower case and a digit');
    if (b.pin && !isAcceptablePin(b.pin)) throw badRequest('PIN must be 4 digits and not trivially guessable (e.g. 1234, 0000)');
    for (const x of b.access ?? []) {
      if (!canAccessCompany(a, x.company_id)) throw forbidden('Cannot grant access to a company you do not manage');
      if (x.branch_id && !(await one(req.tenant.pool, 'SELECT 1 FROM branches WHERE id = $1 AND company_id = $2', [x.branch_id, x.company_id])))
        throw badRequest('Branch does not belong to company');
    }
    if (userId && userId === a.user.id && (b.active === false || b.is_tenant_admin === false)) throw badRequest('You cannot demote or disable yourself');
    return tx(req.tenant.pool, async (c) => {
      const fields: Record<string, unknown> = {};
      for (const k of ['username', 'full_name', 'position', 'landing_page', 'role_id', 'is_tenant_admin', 'color', 'active'] as const) if (b[k] !== undefined) fields[k] = b[k];
      if (b.password) fields.password_hash = await hashSecret(b.password);
      if (b.pin) fields.pin_hash = await hashSecret(b.pin);
      if (b.pin || b.password) { fields.failed_attempts = 0; fields.locked_until = null; }
      const cols = Object.keys(fields);
      let row: any;
      if (userId) {
        if (cols.length) row = await one(c, `UPDATE users SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING id`, [userId, ...cols.map((k) => fields[k])]);
        else row = await one(c, 'SELECT id FROM users WHERE id = $1', [userId]);
        if (!row) throw notFound();
        if (b.active === false || b.password) await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      } else {
        row = await one(c, `INSERT INTO users (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, cols.map((k) => fields[k]));
      }
      if (b.access) {
        await c.query('DELETE FROM user_access WHERE user_id = $1', [row.id]);
        for (const x of b.access) await c.query('INSERT INTO user_access (user_id, company_id, branch_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [row.id, x.company_id, x.branch_id]);
      }
      return row;
    });
  };

  app.post('/users', async (req, reply) => {
    const row = await saveUser(req, null);
    await audit(req, 'create', 'users', row.id);
    reply.code(201);
    return row;
  });
  app.patch('/users/:id', async (req) => {
    const { id: uid } = parse(idParam, req.params);
    const row = await saveUser(req, uid);
    await audit(req, 'update', 'users', uid);
    return row;
  });
  app.post('/users/:id/unlock', async (req) => {
    const a = requirePerm(req, 'users.manage');
    const { id: uid } = parse(idParam, req.params);
    const target = await one<any>(req.tenant.pool, 'SELECT is_tenant_admin FROM users WHERE id = $1', [uid]);
    if (!target) throw notFound();
    if (target.is_tenant_admin && !a.user.is_tenant_admin) throw forbidden();
    await req.tenant.pool.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [uid]);
    await audit(req, 'unlock', 'users', uid);
    return { ok: true };
  });
}
