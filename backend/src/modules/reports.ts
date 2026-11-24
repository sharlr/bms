import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { round2 } from '../lib/money.js';
import { parse } from '../lib/validate.js';
import { requirePerm, type AuthCtx } from '../plugins/context.js';

const rangeQ = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branch_ids: z.string().regex(/^\d+(,\d+)*$/).optional(),
});

/** Branches this user may report on, optionally narrowed to an explicit selection. */
export async function reportBranches(req: FastifyRequest, a: AuthCtx, branchIds?: string) {
  let branches = await many<any>(req.tenant.pool,
    `SELECT b.id, b.name, b.company_id, c.base_currency FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.active ORDER BY b.name`);
  if (!a.user.is_tenant_admin) branches = branches.filter((b) => a.access.some((x) => x.company_id === b.company_id && (x.branch_id === null || x.branch_id === b.id)));
  if (branchIds) { const want = new Set(branchIds.split(',').map(Number)); branches = branches.filter((b) => want.has(b.id)); }
  return branches;
}

async function scope(req: FastifyRequest) {
  const a = requirePerm(req, 'reports.monthly');
  const q = parse(rangeQ, req.query);
  if (q.from > q.to) throw badRequest('"From" must be before "To"');
  const branches = await reportBranches(req, a, q.branch_ids);
  return { q, ids: branches.map((b) => b.id), currencies: [...new Set(branches.map((b) => b.base_currency))] };
}
// Inclusive local-date window in each branch's timezone ($1 = from, $2 = to, $3 = branch ids; branches aliased "b").
const win = (col: string) => `(${col} AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date AND b.id = ANY($3)`;

export function reportRoutes(app: FastifyInstance) {
  /** Who did what: tickets settled per cashier, orders per waiter, items cooked per cook, customer self-orders. */
  app.get('/reports/staff', async (req) => {
    const { q, ids, currencies } = await scope(req);
    const P = [q.from, q.to, ids];
    const pool = req.tenant.pool;
    const cashiers = await many(pool,
      `SELECT u.id, u.full_name, r.name AS role, count(*)::int AS tickets, sum(t.total) AS amount,
              count(*) FILTER (WHERE t.order_type = 'dine_in')::int AS dine_in, count(*) FILTER (WHERE t.order_type <> 'dine_in')::int AS takeaway_delivery
         FROM tickets t JOIN branches b ON b.id = t.branch_id JOIN users u ON u.id = t.closed_by JOIN roles r ON r.id = u.role_id
        WHERE t.status = 'paid' AND ${win('t.closed_at')} GROUP BY u.id, u.full_name, r.name ORDER BY amount DESC`, P);
    const waiters = await many(pool,
      `SELECT u.id, u.full_name, r.name AS role, count(*)::int AS orders, coalesce(sum(t.pax), 0)::int AS guests,
              count(*) FILTER (WHERE t.status = 'paid')::int AS paid, count(*) FILTER (WHERE t.status = 'cancelled')::int AS cancelled,
              coalesce(sum(t.total) FILTER (WHERE t.status = 'paid'), 0) AS amount
         FROM tickets t JOIN branches b ON b.id = t.branch_id JOIN users u ON u.id = t.waiter_id JOIN roles r ON r.id = u.role_id
        WHERE ${win('t.opened_at')} GROUP BY u.id, u.full_name, r.name ORDER BY orders DESC`, P);
    const cooks = await many(pool,
      `SELECT u.id, u.full_name, r.name AS role, count(*)::int AS lines, sum(l.qty) AS items,
              round(avg(extract(epoch FROM (l.kitchen_at - l.sent_at)) / 60)::numeric, 1) AS avg_wait_min
         FROM ticket_lines l JOIN tickets t ON t.id = l.ticket_id JOIN branches b ON b.id = t.branch_id
         JOIN users u ON u.id = l.kitchen_by JOIN roles r ON r.id = u.role_id
        WHERE l.status = 'active' AND l.kitchen_status IN ('preparing','ready','served') AND ${win('l.kitchen_at')}
        GROUP BY u.id, u.full_name, r.name ORDER BY items DESC`, P);
    const self = await many(pool,
      `SELECT t.source, count(*)::int AS orders, count(*) FILTER (WHERE t.status = 'paid')::int AS paid,
              count(*) FILTER (WHERE t.status = 'cancelled')::int AS cancelled, coalesce(sum(t.total) FILTER (WHERE t.status = 'paid'), 0) AS amount
         FROM tickets t JOIN branches b ON b.id = t.branch_id
        WHERE t.source IN ('qr','online','kiosk') AND ${win('t.opened_at')} GROUP BY t.source ORDER BY t.source`, P);
    return { period: q, currencies, cashiers, waiters, cooks, self_orders: self };
  });

  /** Settlement-wise receipts: every payment / refund grouped by payment method and currency. */
  app.get('/reports/settlements', async (req) => {
    const { q, ids, currencies } = await scope(req);
    const P = [q.from, q.to, ids];
    const receipts = await many<any>(req.tenant.pool,
      `SELECT p.id, coalesce(p.value_at, p.created_at) AS created_at, p.created_at AS paid_at, b.name AS branch, t.ticket_ref, t.order_type, pm.name AS method, p.method_type, p.currency_code,
              p.amount, p.rate, p.base_amount, p.kind, p.reference, u.full_name AS cashier, cl.name AS client
         FROM payments p JOIN tickets t ON t.id = p.ticket_id JOIN branches b ON b.id = p.branch_id
         JOIN payment_methods pm ON pm.id = p.payment_method_id LEFT JOIN users u ON u.id = p.created_by LEFT JOIN clients cl ON cl.id = p.client_id
        WHERE ${win('coalesce(p.value_at, p.created_at)')} ORDER BY pm.name, p.currency_code, coalesce(p.value_at, p.created_at) LIMIT 20000`, P);
    const key = (r: any) => `${r.method}|${r.currency_code}`;
    const groups = new Map<string, any>();
    for (const r of receipts) {
      const g = groups.get(key(r)) ?? { method: r.method, method_type: r.method_type, currency_code: r.currency_code, count: 0, received: 0, refunded: 0, net: 0, net_base: 0 };
      g.count++;
      if (r.kind === 'payment') g.received = round2(g.received + r.amount); else g.refunded = round2(g.refunded - r.amount);
      g.net = round2(g.net + r.amount);
      g.net_base = round2(g.net_base + r.base_amount);
      groups.set(key(r), g);
    }
    return {
      period: q, currencies, summary: [...groups.values()],
      total_base: round2(receipts.reduce((s, r) => s + r.base_amount, 0)), receipts, truncated: receipts.length >= 20000,
    };
  });

  /** Item-wise sales: quantity and amount per item and size, on settled tickets, net of voids and refunds. */
  app.get('/reports/items', async (req) => {
    const { q, ids, currencies } = await scope(req);
    const rows = await many<any>(req.tenant.pool,
      `SELECT cat.name AS category, l.item_name, l.size_name,
              sum(l.qty) AS qty, sum(l.refunded_qty) AS refunded_qty, sum(l.qty - l.refunded_qty) AS net_qty,
              sum(l.line_total) AS gross,
              -- ticket-level discount shared across lines in proportion to their value
              sum(CASE WHEN t.subtotal > 0 THEN l.line_total * (t.subtotal - t.discount_amount) / t.subtotal ELSE 0 END
                  * (l.qty - l.refunded_qty) / l.qty) AS net_amount,
              count(DISTINCT t.id)::int AS tickets
         FROM ticket_lines l JOIN tickets t ON t.id = l.ticket_id JOIN branches b ON b.id = t.branch_id
         JOIN menu_items i ON i.id = l.menu_item_id JOIN menu_categories cat ON cat.id = i.category_id
        WHERE t.status = 'paid' AND l.status = 'active' AND ${win('t.closed_at')}
        GROUP BY cat.name, l.item_name, l.size_name ORDER BY net_amount DESC`, [q.from, q.to, ids]);
    const items = rows.map((r) => ({ ...r, gross: round2(r.gross), net_amount: round2(r.net_amount) }));
    return {
      period: q, currencies, items,
      totals: { qty: items.reduce((s, r) => s + r.net_qty, 0), gross: round2(items.reduce((s, r) => s + r.gross, 0)), net_amount: round2(items.reduce((s, r) => s + r.net_amount, 0)) },
    };
  });
}
