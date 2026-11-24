import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { round2 } from '../lib/money.js';
import { currency, id, idParam, money, parse, reqText } from '../lib/validate.js';
import { audit, branchCtx, canAccessBranch, companyCtx, requirePerm, requireUser } from '../plugins/context.js';
import { rateFor } from './billing.js';
import { sessionIdFor, withTicket } from './pos.js';

export function financeRoutes(app: FastifyInstance) {
  // ---------- Counter expenses (petty cash from the register) ----------
  app.get('/expenses', async (req) => {
    requirePerm(req, 'expenses.record');
    const ctx = await branchCtx(req);
    const q = parse(z.object({ from: z.string().date().optional(), to: z.string().date().optional(), session_id: id.optional() }), req.query);
    return many(req.tenant.pool,
      `SELECT e.*, ec.name AS category_name, u.full_name AS user_name FROM counter_expenses e
         JOIN expense_categories ec ON ec.id = e.category_id JOIN users u ON u.id = e.user_id
        WHERE e.branch_id = $1 AND ($2::bigint IS NULL OR e.pos_session_id = $2)
          AND ($3::date IS NULL OR e.created_at >= $3::date) AND ($4::date IS NULL OR e.created_at < $4::date + 1)
        ORDER BY e.id DESC LIMIT 1000`, [ctx.branchId, q.session_id ?? null, q.from ?? null, q.to ?? null]);
  });

  app.post('/expenses', async (req, reply) => {
    const a = requirePerm(req, 'expenses.record');
    const b = parse(z.object({
      category_id: id, description: reqText(300), amount: money.refine((v) => v > 0), currency_code: currency.optional(),
      paid_from_cash: z.boolean().default(true),
    }), req.body);
    const row = await withTicket(req, async (c, ctx) => {
      if (!(await one(c, 'SELECT 1 FROM expense_categories WHERE id = $1 AND company_id = $2 AND active', [b.category_id, ctx.companyId]))) throw badRequest('Invalid category');
      const cur = b.currency_code ?? ctx.currency;
      const rate = await rateFor(c, ctx, cur);
      const sid = await sessionIdFor(c, req, ctx, true);
      return one(c,
        `INSERT INTO counter_expenses (company_id, branch_id, pos_session_id, category_id, description, amount, currency_code, rate, base_amount, paid_from_cash, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [ctx.companyId, ctx.branchId, sid, b.category_id, b.description, b.amount, cur, rate, round2(b.amount * rate), b.paid_from_cash, a.user.id]);
    });
    reply.code(201);
    return row;
  });

  app.post('/expenses/:id/void', async (req) => {
    requirePerm(req, 'expenses.void');
    const ctx = await branchCtx(req);
    const { id: eid } = parse(idParam, req.params);
    const r = await req.tenant.pool.query(
      `UPDATE counter_expenses e SET voided_at = now(), voided_by = $3 FROM pos_sessions s
        WHERE e.id = $1 AND e.branch_id = $2 AND e.voided_at IS NULL AND s.id = e.pos_session_id AND s.status = 'open'`,
      [eid, ctx.branchId, req.auth!.user.id]);
    if (!r.rowCount) throw badRequest('Expense not found or its register session is already closed');
    await audit(req, 'expense.void', 'counter_expenses', eid);
    return { ok: true };
  });

  // ---------- Currencies & manual exchange rates ----------
  app.get('/currencies', async (req) => {
    requireUser(req);
    return many(req.tenant.pool, 'SELECT * FROM currencies ORDER BY code');
  });

  app.get('/rates', async (req) => {
    requireUser(req);
    const companyId = await companyCtx(req);
    const branchId = Number(req.headers['x-branch-id']) || null;
    const current = await many(req.tenant.pool,
      `SELECT DISTINCT ON (currency_code, coalesce(branch_id,0)) r.*, b.name AS branch_name
         FROM exchange_rates r LEFT JOIN branches b ON b.id = r.branch_id
        WHERE r.company_id = $1 AND r.effective_from <= now() AND ($2::bigint IS NULL OR r.branch_id IS NULL OR r.branch_id = $2)
        ORDER BY currency_code, coalesce(branch_id,0), effective_from DESC`, [companyId, branchId]);
    const history = await many(req.tenant.pool,
      `SELECT r.*, u.full_name AS created_by_name, b.name AS branch_name FROM exchange_rates r
         LEFT JOIN users u ON u.id = r.created_by LEFT JOIN branches b ON b.id = r.branch_id
        WHERE r.company_id = $1 ORDER BY r.id DESC LIMIT 200`, [companyId]);
    const base = await one<any>(req.tenant.pool, 'SELECT base_currency FROM companies WHERE id = $1', [companyId]);
    return { base_currency: base?.base_currency, current, history };
  });

  app.post('/rates', async (req, reply) => {
    const a = requirePerm(req, 'rates.manage');
    const companyId = await companyCtx(req);
    const b = parse(z.object({
      currency_code: currency, rate: z.coerce.number().positive().max(1e9), branch_id: id.nullable().optional(),
      effective_from: z.coerce.date().optional(),
    }), req.body);
    const co = await one<any>(req.tenant.pool, 'SELECT base_currency FROM companies WHERE id = $1', [companyId]);
    if (co.base_currency === b.currency_code) throw badRequest('Base currency rate is always 1');
    if (!(await one(req.tenant.pool, 'SELECT 1 FROM currencies WHERE code = $1', [b.currency_code]))) throw badRequest('Unknown currency');
    if (b.branch_id) {
      const br = await one<any>(req.tenant.pool, 'SELECT company_id FROM branches WHERE id = $1', [b.branch_id]);
      if (!br || br.company_id !== companyId || !canAccessBranch(a, companyId, b.branch_id)) throw badRequest('Invalid branch');
    }
    const row = await one(req.tenant.pool,
      `INSERT INTO exchange_rates (company_id, branch_id, currency_code, rate, effective_from, created_by) VALUES ($1,$2,$3,$4,coalesce($5, now()),$6) RETURNING *`,
      [companyId, b.branch_id ?? null, b.currency_code, b.rate, b.effective_from ?? null, a.user.id]);
    await audit(req, 'rate.set', 'exchange_rates', (row as any).id, { currency: b.currency_code, rate: b.rate });
    reply.code(201);
    return row;
  });

  // ---------- Delivery commission reporting ----------
  app.get('/delivery/commissions', async (req) => {
    requirePerm(req, 'delivery.manage');
    const ctx = await branchCtx(req);
    const q = parse(z.object({ from: z.string().date().optional(), to: z.string().date().optional(), delivery_company_id: id.optional() }), req.query);
    return many(req.tenant.pool,
      `SELECT dc.*, t.ticket_ref, t.total AS ticket_total, t.customer_name, t.delivery_address, d.name AS delivery_company_name
         FROM delivery_commissions dc JOIN tickets t ON t.id = dc.ticket_id JOIN delivery_companies d ON d.id = dc.delivery_company_id
        WHERE dc.branch_id = $1 AND ($2::bigint IS NULL OR dc.delivery_company_id = $2)
          AND ($3::date IS NULL OR dc.created_at >= $3::date) AND ($4::date IS NULL OR dc.created_at < $4::date + 1)
        ORDER BY dc.id DESC LIMIT 2000`, [ctx.branchId, q.delivery_company_id ?? null, q.from ?? null, q.to ?? null]);
  });


}
