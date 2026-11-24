import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ident, many, one } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { Permission } from '../lib/permissions.js';
import { idParam, parse } from '../lib/validate.js';
import { audit, branchCtx, companyCtx, requirePerm, requireUser } from '../plugins/context.js';

type RefScope = 'company' | 'branch';
export interface CrudDef {
  path: string;
  table: string;
  /** company: rows carry company_id; branch: rows carry branch_id; parent: rows belong to a company-scoped parent row. */
  scope: 'tenant' | 'company' | 'branch' | 'parent';
  parent?: { column: string; table: string };
  schema: z.ZodObject<any>;
  readPerm?: Permission | null;
  writePerm: Permission;
  orderBy?: string;
  /** Foreign keys that must point at rows of the same company / branch. */
  refs?: Record<string, { table: string; scope: RefScope }>;
  /** Equality filters allowed as query params. */
  filters?: string[];
  remove?: 'soft' | 'hard' | 'none';
  hidden?: string[];
  beforeWrite?: (req: FastifyRequest, data: Record<string, unknown>, isCreate: boolean) => Promise<void> | void;
}

async function scopeWhere(req: FastifyRequest, def: CrudDef, params: unknown[]): Promise<string> {
  switch (def.scope) {
    case 'tenant': return 'true';
    case 'company': params.push(await companyCtx(req)); return `company_id = $${params.length}`;
    case 'branch': params.push((await branchCtx(req)).branchId); return `branch_id = $${params.length}`;
    case 'parent': {
      params.push(await companyCtx(req));
      return `${ident(def.parent!.column)} IN (SELECT id FROM ${ident(def.parent!.table)} WHERE company_id = $${params.length})`;
    }
  }
}

async function checkRefs(req: FastifyRequest, def: CrudDef, data: Record<string, unknown>) {
  const refs = { ...(def.refs ?? {}) };
  if (def.scope === 'parent') refs[def.parent!.column] = { table: def.parent!.table, scope: 'company' };
  for (const [col, ref] of Object.entries(refs)) {
    const v = data[col];
    if (v === undefined || v === null) continue;
    const scopeVal = ref.scope === 'company' ? await companyCtx(req) : (await branchCtx(req)).branchId;
    const ok = await one(req.tenant.pool,
      `SELECT 1 FROM ${ident(ref.table)} WHERE id = $1 AND ${ref.scope === 'company' ? 'company_id' : 'branch_id'} = $2`, [v, scopeVal]);
    if (!ok) throw badRequest(`Invalid ${col}`);
  }
}

const strip = (def: CrudDef, row: any) => {
  if (row && def.hidden) for (const h of def.hidden) delete row[h];
  return row;
};

export function registerCrud(app: FastifyInstance, def: CrudDef) {
  const T = ident(def.table);
  const read = (req: FastifyRequest) => (def.readPerm ? requirePerm(req, def.readPerm) : requireUser(req));

  app.get(def.path, async (req) => {
    read(req);
    const params: unknown[] = [];
    let where = await scopeWhere(req, def, params);
    const q = req.query as Record<string, string>;
    for (const f of def.filters ?? []) {
      const v = q[f];
      if (v === undefined || v === '') continue;
      if (v === 'null') { where += ` AND ${ident(f)} IS NULL`; continue; }
      params.push(v);
      where += ` AND ${ident(f)} = $${params.length}`;
    }
    const rows = await many(req.tenant.pool, `SELECT * FROM ${T} WHERE ${where} ORDER BY ${def.orderBy ?? 'id'} LIMIT 2000`, params);
    return rows.map((r) => strip(def, r));
  });

  app.get(`${def.path}/:id`, async (req) => {
    read(req);
    const { id } = parse(idParam, req.params);
    const params: unknown[] = [id];
    const row = await one(req.tenant.pool, `SELECT * FROM ${T} WHERE id = $1 AND ${await scopeWhere(req, def, params)}`, params);
    if (!row) throw notFound();
    return strip(def, row);
  });

  app.post(def.path, async (req, reply) => {
    requirePerm(req, def.writePerm);
    const data = parse(def.schema.strict(), req.body) as Record<string, unknown>;
    await def.beforeWrite?.(req, data, true);
    await checkRefs(req, def, data);
    if (def.scope === 'company') data.company_id = await companyCtx(req);
    if (def.scope === 'branch') data.branch_id = (await branchCtx(req)).branchId;
    const cols = Object.keys(data);
    const row = await one(req.tenant.pool,
      `INSERT INTO ${T} (${cols.map(ident).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      cols.map((c) => normalize(data[c])));
    await audit(req, 'create', def.table, (row as any).id, {});
    reply.code(201);
    return strip(def, row);
  });

  app.patch(`${def.path}/:id`, async (req) => {
    requirePerm(req, def.writePerm);
    const { id } = parse(idParam, req.params);
    const data = parse(def.schema.partial().strict(), req.body) as Record<string, unknown>;
    await def.beforeWrite?.(req, data, false);
    await checkRefs(req, def, data);
    const cols = Object.keys(data);
    if (!cols.length) throw badRequest('Nothing to update');
    const params: unknown[] = cols.map((c) => normalize(data[c]));
    params.push(id);
    const idIdx = params.length;
    const where = await scopeWhere(req, def, params);
    const row = await one(req.tenant.pool,
      `UPDATE ${T} SET ${cols.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ')} WHERE id = $${idIdx} AND ${where} RETURNING *`, params);
    if (!row) throw notFound();
    await audit(req, 'update', def.table, id, { fields: cols });
    return strip(def, row);
  });

  if ((def.remove ?? 'soft') !== 'none') {
    app.delete(`${def.path}/:id`, async (req) => {
      requirePerm(req, def.writePerm);
      const { id } = parse(idParam, req.params);
      const params: unknown[] = [id];
      const where = await scopeWhere(req, def, params);
      const sql = def.remove === 'hard'
        ? `DELETE FROM ${T} WHERE id = $1 AND ${where}`
        : `UPDATE ${T} SET active = false WHERE id = $1 AND ${where}`;
      const r = await req.tenant.pool.query(sql, params);
      if (!r.rowCount) throw notFound();
      await audit(req, 'delete', def.table, id, {});
      return { ok: true };
    });
  }
}

const normalize = (v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v);

export const zBool = z.boolean();
