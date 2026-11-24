import { many, one, type Queryable } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { round2 } from '../lib/money.js';

/** Data for an X (mid-shift) or Z (closing) report of one register session. */
export async function sessionReport(c: Queryable, sessionId: number, branchId: number) {
  const s = await one<any>(c,
    `SELECT s.*, r.name AS register_name, b.name AS branch_name, b.code AS branch_code, co.name AS company_name,
            co.base_currency AS currency, uo.full_name AS opened_by_name, uc.full_name AS closed_by_name
       FROM pos_sessions s JOIN registers r ON r.id = s.register_id JOIN branches b ON b.id = s.branch_id
       JOIN companies co ON co.id = b.company_id JOIN users uo ON uo.id = s.opened_by LEFT JOIN users uc ON uc.id = s.closed_by
      WHERE s.id = $1 AND s.branch_id = $2`, [sessionId, branchId]);
  if (!s) throw notFound('Register session not found');
  const P = [sessionId];
  // Cancellations/voids made while no session was attached still belong to this shift's window.
  const W = [sessionId, branchId, s.opened_at, s.closed_at];

  const sales = await one<any>(c,
    `SELECT count(*)::int AS tickets, coalesce(sum(pax),0)::int AS guests, coalesce(sum(subtotal),0) AS gross,
            coalesce(sum(discount_amount),0) AS discounts, coalesce(sum(tax_amount),0) AS tax, coalesce(sum(total),0) AS net,
            coalesce(sum(change_amount),0) AS change_given
       FROM tickets WHERE pos_session_id = $1 AND status = 'paid'`, P);
  const byOrderType = await many(c,
    `SELECT order_type, count(*)::int AS tickets, sum(total) AS total FROM tickets WHERE pos_session_id = $1 AND status = 'paid'
      GROUP BY order_type ORDER BY order_type`, P);
  const byChannel = await many(c,
    `SELECT rc.name AS channel, rc.channel_type, count(*)::int AS tickets, sum(t.total) AS total
       FROM tickets t JOIN receipt_channels rc ON rc.id = t.receipt_channel_id
      WHERE t.pos_session_id = $1 AND t.status = 'paid' GROUP BY rc.name, rc.channel_type ORDER BY rc.name`, P);
  const payments = await many<any>(c,
    `SELECT pm.name AS method, p.method_type, p.currency_code, count(*)::int AS count, sum(p.amount) AS amount, sum(p.base_amount) AS base_amount
       FROM payments p JOIN payment_methods pm ON pm.id = p.payment_method_id
      WHERE p.pos_session_id = $1 AND p.kind = 'payment' GROUP BY pm.name, p.method_type, p.currency_code ORDER BY pm.name, p.currency_code`, P);
  const currencies = await many(c,
    `SELECT currency_code, sum(amount) FILTER (WHERE kind = 'payment') AS received, coalesce(sum(-amount) FILTER (WHERE kind = 'refund'),0) AS refunded,
            sum(base_amount) AS net_base
       FROM payments WHERE pos_session_id = $1 GROUP BY currency_code ORDER BY currency_code`, P);
  const refunds = await many<any>(c,
    `SELECT r.id, t.ticket_ref, r.amount, r.reason, r.created_at, u.full_name AS user_name
       FROM refunds r JOIN tickets t ON t.id = r.ticket_id LEFT JOIN users u ON u.id = r.created_by
      WHERE r.pos_session_id = $1 ORDER BY r.id`, P);
  const refundPayments = await many<any>(c,
    `SELECT method_type, sum(-base_amount) AS base_amount FROM payments WHERE pos_session_id = $1 AND kind = 'refund' GROUP BY method_type`, P);
  const discounts = await many(c,
    `SELECT t.ticket_ref, t.discount_type, t.discount_value, t.discount_amount, cp.code AS coupon
       FROM tickets t LEFT JOIN coupons cp ON cp.id = t.coupon_id
      WHERE t.pos_session_id = $1 AND t.status = 'paid' AND t.discount_amount > 0 ORDER BY t.id`, P);
  const expenses = await many<any>(c,
    `SELECT e.id, ec.name AS category, e.description, e.amount, e.currency_code, e.base_amount, e.paid_from_cash, u.full_name AS user_name, e.created_at
       FROM counter_expenses e JOIN expense_categories ec ON ec.id = e.category_id JOIN users u ON u.id = e.user_id
      WHERE e.pos_session_id = $1 AND e.voided_at IS NULL ORDER BY e.id`, P);
  const commissions = await many(c,
    `SELECT dc.name AS delivery_company, count(DISTINCT t.id)::int AS deliveries,
            sum(t.total) FILTER (WHERE true) AS sales, coalesce(sum(x.amount),0) AS commission
       FROM tickets t JOIN delivery_companies dc ON dc.id = t.delivery_company_id
       LEFT JOIN LATERAL (SELECT sum(amount) AS amount FROM delivery_commissions WHERE ticket_id = t.id) x ON true
      WHERE t.pos_session_id = $1 AND t.status = 'paid' GROUP BY dc.name ORDER BY dc.name`, P);
  const cancellations = await many<any>(c,
    `SELECT ca.kind, t.ticket_ref, ca.item_name, ca.qty, ca.amount, ca.reason, u.full_name AS user_name, ap.full_name AS approved_by, ca.created_at
       FROM cancellations ca JOIN tickets t ON t.id = ca.ticket_id JOIN users u ON u.id = ca.user_id LEFT JOIN users ap ON ap.id = ca.approved_by
      WHERE ca.pos_session_id = $1
         OR (ca.pos_session_id IS NULL AND ca.branch_id = $2 AND ca.created_at >= $3 AND ca.created_at < coalesce($4::timestamptz, now()))
      ORDER BY ca.id`, W);
  const open = await one<any>(c,
    `SELECT count(*)::int AS count, coalesce(sum(total - paid_amount),0) AS amount FROM tickets WHERE branch_id = $1 AND status IN ('pending','open')`,
    [branchId]);

  const cashIn = payments.filter((p) => p.method_type === 'cash').reduce((a, p) => a + p.base_amount, 0);
  const cashRefunds = refundPayments.filter((p) => p.method_type === 'cash').reduce((a, p) => a + p.base_amount, 0);
  const cashExpenses = expenses.filter((e) => e.paid_from_cash).reduce((a, e) => a + e.base_amount, 0);
  const expectedCash = round2(s.opening_float + cashIn - sales.change_given - cashRefunds - cashExpenses);
  const credit = payments.filter((p) => p.method_type === 'credit').reduce((a, p) => a + p.base_amount, 0);

  return {
    session: {
      id: s.id, register: s.register_name, branch: s.branch_name, branch_code: s.branch_code, company: s.company_name,
      currency: s.currency, opened_at: s.opened_at, opened_by: s.opened_by_name, closed_at: s.closed_at, closed_by: s.closed_by_name,
      opening_float: s.opening_float, status: s.status,
    },
    sales, by_order_type: byOrderType, by_channel: byChannel, payments, currencies, credit_sales: round2(credit),
    refunds: { total: round2(refunds.reduce((a, r) => a + r.amount, 0)), items: refunds },
    discounts: { total: round2(sales.discounts), items: discounts },
    expenses: {
      total: round2(expenses.reduce((a, e) => a + e.base_amount, 0)),
      by_category: Object.entries(expenses.reduce<Record<string, number>>((m, e) => ((m[e.category] = round2((m[e.category] ?? 0) + e.base_amount)), m), {}))
        .map(([category, total]) => ({ category, total })),
      items: expenses,
    },
    delivery_commissions: commissions,
    cancellations: {
      total: round2(cancellations.reduce((a, x) => a + x.amount, 0)),
      lines: cancellations.filter((x) => x.kind === 'line'),
      tickets: cancellations.filter((x) => x.kind !== 'line'),
    },
    cash: {
      opening_float: s.opening_float, cash_sales: round2(cashIn), change_given: sales.change_given, cash_refunds: round2(cashRefunds),
      cash_expenses: round2(cashExpenses), expected: expectedCash, counted: s.counted_cash,
      difference: s.counted_cash == null ? null : round2(s.counted_cash - expectedCash),
    },
    open_tickets: open,
    generated_at: new Date().toISOString(),
  };
}

export interface MonthlyFilter { from: string; to: string; companyIds: number[] | null; companyId?: number; branchId?: number }

/** Consolidated sales across all receipt channels, filterable by company / branch / whole tenant. */
export async function monthlyReport(c: Queryable, f: MonthlyFilter) {
  const params: unknown[] = [f.from, f.to];
  // Local-time window per branch timezone; every query joins branches as "b".
  const tsWhere = (alias: string, col: string) =>
    `(${alias}.${col} AT TIME ZONE b.timezone) >= $1::timestamp AND (${alias}.${col} AT TIME ZONE b.timezone) < $2::timestamp`;
  let scopeSql = '';
  if (f.companyIds) { params.push(f.companyIds); scopeSql += ` AND b.company_id = ANY($${params.length})`; }
  if (f.companyId) { params.push(f.companyId); scopeSql += ` AND b.company_id = $${params.length}`; }
  if (f.branchId) { params.push(f.branchId); scopeSql += ` AND b.id = $${params.length}`; }
  const where = `t.status = 'paid' AND ${tsWhere('t', 'closed_at')}${scopeSql}`;
  const base = `FROM tickets t JOIN branches b ON b.id = t.branch_id JOIN companies co ON co.id = b.company_id WHERE ${where}`;

  const totals = await one(c,
    `SELECT count(*)::int AS tickets, coalesce(sum(t.pax),0)::int AS guests, coalesce(sum(t.subtotal),0) AS gross,
            coalesce(sum(t.discount_amount),0) AS discounts, coalesce(sum(t.tax_amount),0) AS tax, coalesce(sum(t.total),0) AS net,
            coalesce(sum(t.refunded_amount),0) AS refunds ${base}`, params);
  const byChannel = await many(c,
    `SELECT rc.name AS channel, rc.channel_type, co.name AS company, count(*)::int AS tickets, sum(t.total) AS total
       ${base.replace('WHERE', 'JOIN receipt_channels rc ON rc.id = t.receipt_channel_id WHERE')}
      GROUP BY rc.name, rc.channel_type, co.name ORDER BY co.name, rc.name`, params);
  const byCompany = await many(c,
    `SELECT co.id, co.name AS company, co.base_currency AS currency, count(*)::int AS tickets, sum(t.total) AS total ${base}
      GROUP BY co.id, co.name, co.base_currency ORDER BY co.name`, params);
  const byBranch = await many(c,
    `SELECT b.id, co.name AS company, b.name AS branch, count(*)::int AS tickets, sum(t.total) AS total,
            sum(t.discount_amount) AS discounts, sum(t.refunded_amount) AS refunds ${base}
      GROUP BY b.id, co.name, b.name ORDER BY co.name, b.name`, params);
  const byDay = await many(c,
    `SELECT (t.closed_at AT TIME ZONE b.timezone)::date AS day, count(*)::int AS tickets, sum(t.total) AS total ${base}
      GROUP BY 1 ORDER BY 1`, params);
  const byOrderType = await many(c,
    `SELECT t.order_type, count(*)::int AS tickets, sum(t.total) AS total ${base} GROUP BY 1 ORDER BY 1`, params);
  const payments = await many(c,
    `SELECT pm.name AS method, p.currency_code, sum(p.amount) AS amount, sum(p.base_amount) AS base_amount
       FROM payments p JOIN payment_methods pm ON pm.id = p.payment_method_id JOIN tickets t ON t.id = p.ticket_id
       JOIN branches b ON b.id = t.branch_id WHERE ${where}
      GROUP BY pm.name, p.currency_code ORDER BY pm.name`, params);
  const commissions = await many(c,
    `SELECT dc.name AS delivery_company, co.name AS company, count(DISTINCT t.id)::int AS deliveries,
            sum(t.total) AS sales, coalesce(sum(x.amount),0) AS commission
       FROM tickets t JOIN branches b ON b.id = t.branch_id JOIN companies co ON co.id = b.company_id
       JOIN delivery_companies dc ON dc.id = t.delivery_company_id
       LEFT JOIN LATERAL (SELECT sum(amount) AS amount FROM delivery_commissions WHERE ticket_id = t.id) x ON true
      WHERE ${where} GROUP BY dc.name, co.name ORDER BY co.name, dc.name`, params);

  // Expenses, waste and cancellations use their own timestamps.
  const expenses = await many(c,
    `SELECT b.name AS branch, ec.name AS category, sum(e.base_amount) AS total FROM counter_expenses e
       JOIN branches b ON b.id = e.branch_id JOIN expense_categories ec ON ec.id = e.category_id
      WHERE e.voided_at IS NULL AND ${tsWhere('e', 'created_at')} ${scopeSql} GROUP BY b.name, ec.name ORDER BY b.name, ec.name`, params);
  const waste = await many(c,
    `SELECT b.name AS branch, w.reason, count(*)::int AS entries, sum(w.cost_amount) AS cost FROM waste_logs w
       JOIN branches b ON b.id = w.branch_id WHERE ${tsWhere('w', 'created_at')} ${scopeSql} GROUP BY b.name, w.reason ORDER BY b.name`, params);
  const cancellations = await many(c,
    `SELECT b.name AS branch, ca.kind, count(*)::int AS count, sum(ca.amount) AS amount FROM cancellations ca
       JOIN branches b ON b.id = ca.branch_id WHERE ${tsWhere('ca', 'created_at')} ${scopeSql} GROUP BY b.name, ca.kind ORDER BY b.name`, params);

  return {
    period: { from: f.from, to: f.to }, totals, by_channel: byChannel, by_company: byCompany, by_branch: byBranch,
    by_day: byDay, by_order_type: byOrderType, payments, delivery_commissions: commissions, expenses, waste, cancellations,
  };
}
