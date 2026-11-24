import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, nextSeq, one, type Client } from '../lib/db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { round2, round3 } from '../lib/money.js';
import { currency, id, idParam, money, parse, qty, reqText, text } from '../lib/validate.js';
import { authorize, branchCtx, companyIdsFor, hasPerm, requirePerm, canAccessCompany, type BranchCtx } from '../plugins/context.js';
import type { Events } from '../realtime.js';
import { computeCommission } from '../services/commission.js';
import { sendToKitchen } from '../services/kot.js';
import { monthlyReport, sessionReport } from '../services/reports.js';
import { returnForLine } from '../services/stock.js';
import { currentSession, loadTicket, recalc, ticketDetail } from '../services/tickets.js';
import { override, sessionIdFor, withTicket } from './pos.js';
import { reportBranches } from './reports.js';

export async function rateFor(c: Client, ctx: BranchCtx, code: string): Promise<number> {
  if (code === ctx.currency) return 1;
  const r = await one<{ rate: number }>(c,
    `SELECT rate FROM exchange_rates WHERE company_id = $1 AND currency_code = $2 AND (branch_id = $3 OR branch_id IS NULL)
        AND effective_from <= now() ORDER BY (branch_id IS NULL), effective_from DESC LIMIT 1`, [ctx.companyId, code, ctx.branchId]);
  if (!r) throw badRequest(`No exchange rate set for ${code}`);
  return r.rate;
}

async function receiptData(c: Client, ctx: BranchCtx, ticketId: number) {
  const t = await ticketDetail(c, ticketId);
  const b = await one<any>(c,
    `SELECT b.name, b.address, b.phone, b.receipt_header, b.receipt_footer, b.tax_rate, b.tax_inclusive,
            co.name AS company_name, co.legal_name, co.tax_id, co.address AS company_address
       FROM branches b JOIN companies co ON co.id = b.company_id WHERE b.id = $1`, [ctx.branchId]);
  return {
    type: 'receipt', branch: b, ticket: {
      ...t, lines: t.lines.filter((l: any) => l.status === 'active'),
    },
    // Credit sales print the client's details clearly.
    credit_client: t.client_id && t.payments.some((p: any) => p.method_type === 'credit')
      ? { name: t.client_name, phone: t.client_phone, address: t.client_address, tax_id: t.client_tax_id } : null,
  };
}

async function queueReceipt(c: Client, ctx: BranchCtx, ev: Events, ticketId: number) {
  const printer = await one<any>(c, `SELECT id, connection, chars_per_line FROM printers WHERE branch_id = $1 AND kind = 'receipt' AND active AND connection LIKE 'tcp://%' ORDER BY id LIMIT 1`, [ctx.branchId]);
  if (!printer) return false;
  const payload = await receiptData(c, ctx, ticketId);
  const job = await one<any>(c, `INSERT INTO print_jobs (branch_id, printer_id, kind, ref_id, payload) VALUES ($1,$2,'receipt',$3,$4) RETURNING *`,
    [ctx.branchId, printer.id, ticketId, JSON.stringify(payload)]);
  ev.print(ctx.branchId, { ...job, connection: printer.connection, chars_per_line: printer.chars_per_line });
  return true;
}

export function billingRoutes(app: FastifyInstance) {
  // Split / multi-mode / multi-currency payments on a single ticket.
  app.post('/pos/tickets/:id/payments', async (req) => {
    const a = requirePerm(req, 'pos.payment');
    const { id: tid } = parse(idParam, req.params);
    const b = parse(z.object({
      payments: z.array(z.object({
        payment_method_id: id, currency_code: currency, amount: money.refine((v) => v > 0, 'Amount must be positive'), reference: text(80).optional(),
      })).max(20), // empty = close a ticket already fully paid online
      print_receipt: z.boolean().default(false),
    }), req.body);
    const result = await withTicket(req, async (c, ctx, ev) => {
      let t = await loadTicket(c, tid, ctx, true);
      if (t.status !== 'open' && t.status !== 'pending') throw conflict(`Ticket is ${t.status}`);
      if (t.status === 'pending' && !hasPerm(a, 'pos.accept_online')) throw forbidden('Accept the customer order first');
      await sendToKitchen(c, ctx, tid, a.user.id, ev); // pay = confirm: unsent lines are fired first
      t = await recalc(c, tid, ctx);
      if (t.total <= 0 && !(await one(c, `SELECT 1 FROM ticket_lines WHERE ticket_id = $1 AND status = 'active'`, [tid]))) throw badRequest('Ticket is empty');
      const sessionId = await sessionIdFor(c, req, ctx, true);

      const rows: any[] = [];
      for (const p of b.payments) {
        const m = await one<any>(c, 'SELECT * FROM payment_methods WHERE id = $1 AND company_id = $2 AND active', [p.payment_method_id, ctx.companyId]);
        if (!m) throw badRequest('Invalid payment method');
        if (!(await one(c, 'SELECT 1 FROM currencies WHERE code = $1', [p.currency_code]))) throw badRequest('Unknown currency');
        const rate = await rateFor(c, ctx, p.currency_code);
        rows.push({ ...p, method: m, rate, base: round2(p.amount * rate) });
      }
      const due = round2(t.total - t.paid_amount);
      if (!rows.length && due > 0.004) throw badRequest('Enter a payment');
      const incoming = round2(rows.reduce((s, r) => s + r.base, 0));
      const nonCash = round2(rows.filter((r) => r.method.method_type !== 'cash').reduce((s, r) => s + r.base, 0));
      if (nonCash > due + 0.009) throw badRequest('Only cash payments can exceed the amount due (change)');

      for (const r of rows) {
        if (r.method.method_type === 'credit') {
          if (!hasPerm(a, 'pos.credit_sale')) throw forbidden('Credit sales not permitted');
          if (!t.client_id) throw badRequest('Select a credit client on the ticket first');
          const cl = await one<any>(c, 'SELECT * FROM clients WHERE id = $1 AND company_id = $2 FOR UPDATE', [t.client_id, ctx.companyId]);
          if (!cl?.credit_allowed) throw badRequest('This client is not allowed credit');
          if (cl.credit_limit > 0 && cl.balance + r.base > cl.credit_limit + 0.009) throw badRequest(`Credit limit exceeded (available ${round2(cl.credit_limit - cl.balance)})`);
          await c.query('UPDATE clients SET balance = balance + $2 WHERE id = $1', [cl.id, r.base]);
        }
        await c.query(
          `INSERT INTO payments (ticket_id, company_id, branch_id, pos_session_id, payment_method_id, method_type, currency_code, amount, rate, base_amount,
              kind, client_id, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'payment',$11,$12,$13)`,
          [tid, ctx.companyId, ctx.branchId, sessionId, r.method.id, r.method.method_type, r.currency_code, r.amount, r.rate, r.base,
            r.method.method_type === 'credit' ? t.client_id : null, r.reference ?? null, a.user.id]);
      }
      const paid = round2(t.paid_amount + incoming);
      let change = 0;
      if (paid >= t.total - 0.004) {
        change = round2(paid - t.total);
        await c.query(
          `UPDATE tickets SET paid_amount = $2, change_amount = $3, status = 'paid', closed_at = now(), pos_session_id = $4, closed_by = $5, updated_at = now() WHERE id = $1`,
          [tid, paid, change, sessionId, a.user.id]);
        // Online prepayments had no register session; they belong to the session that closes the ticket (X/Z reports).
        await c.query('UPDATE payments SET pos_session_id = $2, value_at = now() WHERE ticket_id = $1 AND pos_session_id IS NULL', [tid, sessionId]);
        if (t.coupon_id) await c.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [t.coupon_id]);
        await computeCommission(c, tid);
        await c.query(`UPDATE ticket_lines SET kitchen_status = 'served' WHERE ticket_id = $1 AND station_id IS NULL`, [tid]);
        if (b.print_receipt) await queueReceipt(c, ctx, ev, tid);
        ev.branch(ctx.branchId, 'tables:changed', { ticket_id: tid });
        ev.branch(ctx.branchId, 'ticket:paid', { ticket_id: tid, ticket_ref: t.ticket_ref });
      } else {
        await c.query('UPDATE tickets SET paid_amount = $2, updated_at = now() WHERE id = $1', [tid, paid]);
      }
      return { change, balance_due: round2(Math.max(0, t.total - paid)) };
    });
    return { ...result, ticket: await ticketDetail(req.tenant.pool, tid) };
  });

  // Full / partial refunds (by line quantities or custom amount).
  app.post('/pos/tickets/:id/refund', async (req) => {
    requirePerm(req, 'pos.access');
    const { id: tid } = parse(idParam, req.params);
    const b = parse(z.object({
      lines: z.array(z.object({ line_id: id, qty })).max(200).optional(), amount: money.optional(), reason: reqText(200),
      payment_method_id: id, currency_code: currency.optional(), restock: z.boolean().default(false), override,
    }).refine((x) => x.lines?.length || x.amount, 'Choose lines or an amount'), req.body);
    const approver = await authorize(req, 'pos.refund', b.override);
    await withTicket(req, async (c, ctx, ev) => {
      const t = await loadTicket(c, tid, ctx, true);
      if (t.status !== 'paid') throw conflict('Only paid tickets can be refunded');
      const refundable = round2(t.total - t.refunded_amount);
      const m = await one<any>(c, 'SELECT * FROM payment_methods WHERE id = $1 AND company_id = $2 AND active', [b.payment_method_id, ctx.companyId]);
      if (!m) throw badRequest('Invalid payment method');
      let amount = 0;
      const refundedLines: any[] = [];
      if (b.lines?.length) {
        for (const x of b.lines) {
          const l = await one<any>(c, `SELECT * FROM ticket_lines WHERE id = $1 AND ticket_id = $2 AND status = 'active' FOR UPDATE`, [x.line_id, tid]);
          if (!l) throw badRequest('Invalid line');
          const left = round3(l.qty - l.refunded_qty);
          if (x.qty > left + 1e-9) throw badRequest(`Only ${left} of ${l.item_name} can be refunded`);
          const share = t.subtotal > 0 ? ((l.line_total / l.qty) * x.qty) / t.subtotal : 0;
          amount += share * t.total; // proportional to discount & tax
          await c.query('UPDATE ticket_lines SET refunded_qty = refunded_qty + $2 WHERE id = $1', [l.id, x.qty]);
          if (b.restock && l.stock_deducted) await returnForLine(c, ctx.branchId, t, l.id, x.qty / left, 'refund_return', approver);
          refundedLines.push({ line_id: l.id, name: l.item_name, qty: x.qty });
        }
        amount = round2(amount);
      } else amount = round2(b.amount!);
      if (amount <= 0) throw badRequest('Refund amount must be positive');
      if (amount > refundable + 0.009) throw badRequest(`Maximum refundable is ${refundable}`);
      const cur = b.currency_code ?? ctx.currency;
      const rate = await rateFor(c, ctx, cur);
      const sessionId = await sessionIdFor(c, req, ctx, true);
      if (m.method_type === 'credit') {
        if (!t.client_id) throw badRequest('No client on ticket for credit refund');
        await c.query('UPDATE clients SET balance = balance - $2 WHERE id = $1', [t.client_id, amount]);
      }
      await c.query(
        `INSERT INTO payments (ticket_id, company_id, branch_id, pos_session_id, payment_method_id, method_type, currency_code, amount, rate, base_amount,
            kind, client_id, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'refund',$11,$12,$13)`,
        [tid, ctx.companyId, ctx.branchId, sessionId, m.id, m.method_type, cur, -round2(amount / rate), rate, -amount,
          m.method_type === 'credit' ? t.client_id : null, b.reason, approver]);
      await c.query(
        `INSERT INTO refunds (ticket_id, branch_id, pos_session_id, amount, reason, lines, restock, created_by, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tid, ctx.branchId, sessionId, amount, b.reason, JSON.stringify(refundedLines), b.restock, req.auth!.user.id, approver]);
      const total = round2(t.refunded_amount + amount);
      await c.query(`UPDATE tickets SET refunded_amount = $2, refund_status = $3, updated_at = now() WHERE id = $1`,
        [tid, total, total >= t.total - 0.009 ? 'full' : 'partial']);
      await computeCommission(c, tid);
      ev.branch(ctx.branchId, 'ticket:refunded', { ticket_id: tid });
    });
    return ticketDetail(req.tenant.pool, tid);
  });

  app.get('/pos/tickets/:id/receipt', async (req) => {
    requirePerm(req, 'pos.access');
    const { id: tid } = parse(idParam, req.params);
    return withTicket(req, async (c, ctx) => {
      await loadTicket(c, tid, ctx);
      return receiptData(c, ctx, tid);
    });
  });

  app.post('/pos/tickets/:id/print-receipt', async (req) => {
    requirePerm(req, 'pos.access');
    const { id: tid } = parse(idParam, req.params);
    const queued = await withTicket(req, async (c, ctx, ev) => {
      await loadTicket(c, tid, ctx);
      return queueReceipt(c, ctx, ev, tid);
    });
    return { queued, browser: !queued };
  });

  // ---------- Register sessions ----------
  app.get('/pos/session', async (req) => {
    const a = requirePerm(req, 'pos.access');
    return withTicket(req, async (c, ctx) => {
      const reg = a.deviceId && req.device ? req.device.register_id : null;
      const session = await currentSession(c, ctx, reg, a.user.id, false);
      const registers = await many(c, 'SELECT id, name FROM registers WHERE branch_id = $1 AND active ORDER BY id', [ctx.branchId]);
      const open = await many(c, `SELECT s.id, s.register_id, s.opened_at, u.full_name AS opened_by FROM pos_sessions s JOIN users u ON u.id = s.opened_by
                                    WHERE s.branch_id = $1 AND s.status = 'open'`, [ctx.branchId]);
      return { session, registers, open_sessions: open };
    });
  });

  app.post('/pos/session/open', async (req) => {
    const a = requirePerm(req, 'pos.register');
    const b = parse(z.object({ register_id: id.optional(), opening_float: money.default(0) }), req.body);
    return withTicket(req, async (c, ctx) => {
      const reg = b.register_id ?? (a.deviceId && req.device ? req.device.register_id : null);
      if (reg && !(await one(c, 'SELECT 1 FROM registers WHERE id = $1 AND branch_id = $2', [reg, ctx.branchId]))) throw badRequest('Invalid register');
      const s = await currentSession(c, ctx, reg, a.user.id, true);
      await c.query('UPDATE pos_sessions SET opening_float = $2 WHERE id = $1', [s.id, b.opening_float]);
      return { ...s, opening_float: b.opening_float };
    });
  });

  // ---------- X / Z reports ----------
  const resolveSession = async (c: Client, req: any, ctx: BranchCtx, sid?: number) => {
    if (sid) return sid;
    const reg = req.auth?.deviceId && req.device ? req.device.register_id : null;
    const s = await currentSession(c, ctx, reg, req.auth.user.id, false);
    if (!s) throw notFound('No open register session');
    return s.id as number;
  };

  app.get('/reports/session', async (req) => {
    requirePerm(req, 'reports.x');
    const q = parse(z.object({ session_id: id.optional() }), req.query);
    return withTicket(req, async (c, ctx) => sessionReport(c, await resolveSession(c, req, ctx, q.session_id), ctx.branchId));
  });

  app.post('/reports/x', async (req) => {
    const a = requirePerm(req, 'reports.x');
    const b = parse(z.object({ session_id: id.optional() }), req.body);
    return withTicket(req, async (c, ctx) => {
      const sid = await resolveSession(c, req, ctx, b.session_id);
      const data = await sessionReport(c, sid, ctx.branchId);
      const no = await nextSeq(c, ctx.branchId, 'x_report');
      const r = await one(c, `INSERT INTO shift_reports (company_id, branch_id, pos_session_id, report_type, report_no, data, created_by)
                              VALUES ($1,$2,$3,'X',$4,$5,$6) RETURNING id, report_type, report_no, created_at`,
        [ctx.companyId, ctx.branchId, sid, no, JSON.stringify(data), a.user.id]);
      return { ...r, data };
    });
  });

  app.post('/reports/z', async (req) => {
    const a = requirePerm(req, 'reports.z');
    const b = parse(z.object({ session_id: id.optional(), counted_cash: money.nullable().optional() }), req.body);
    return withTicket(req, async (c, ctx, ev) => {
      const sid = await resolveSession(c, req, ctx, b.session_id);
      const s = await one<any>(c, 'SELECT * FROM pos_sessions WHERE id = $1 AND branch_id = $2 FOR UPDATE', [sid, ctx.branchId]);
      if (!s || s.status !== 'open') throw conflict('Session already closed');
      // End of day: every ticket of the branch must be settled or cancelled first (no override).
      const open = await many<any>(c,
        `SELECT t.ticket_ref, dt.name AS table_name, coalesce(w.full_name, 'customer order') AS staff FROM tickets t
           LEFT JOIN dining_tables dt ON dt.id = t.table_id LEFT JOIN users w ON w.id = t.waiter_id
          WHERE t.branch_id = $1 AND t.status IN ('pending','open') ORDER BY t.id`, [ctx.branchId]);
      if (open.length) {
        const list = open.slice(0, 15).map((t) => `${t.ticket_ref}${t.table_name ? ' (table ' + t.table_name + ')' : ''} — ${t.staff}`).join('; ');
        throw conflict(`Close all tickets before the Z report. ${open.length} still open: ${list}${open.length > 15 ? '; …' : ''}`);
      }
      await c.query(`UPDATE pos_sessions SET status = 'closed', closed_at = now(), closed_by = $2, counted_cash = $3 WHERE id = $1`,
        [sid, a.user.id, b.counted_cash ?? null]);
      const data = await sessionReport(c, sid, ctx.branchId);
      const no = await nextSeq(c, ctx.branchId, 'z_report');
      const r = await one(c, `INSERT INTO shift_reports (company_id, branch_id, pos_session_id, report_type, report_no, data, created_by)
                              VALUES ($1,$2,$3,'Z',$4,$5,$6) RETURNING id, report_type, report_no, created_at`,
        [ctx.companyId, ctx.branchId, sid, no, JSON.stringify(data), a.user.id]);
      ev.branch(ctx.branchId, 'session:closed', { session_id: sid });
      return { ...r, data };
    });
  });

  app.get('/reports/shifts', async (req) => {
    requirePerm(req, 'reports.x');
    const ctx = await branchCtx(req);
    const q = parse(z.object({ type: z.enum(['X', 'Z']).optional() }), req.query);
    return many(req.tenant.pool,
      `SELECT r.id, r.report_type, r.report_no, r.pos_session_id, r.created_at, u.full_name AS created_by_name,
              (r.data->'sales'->>'net')::numeric AS net_sales
         FROM shift_reports r JOIN users u ON u.id = r.created_by
        WHERE r.branch_id = $1 AND ($2::text IS NULL OR r.report_type = $2) ORDER BY r.id DESC LIMIT 200`, [ctx.branchId, q.type ?? null]);
  });

  app.get('/reports/shifts/:id', async (req) => {
    requirePerm(req, 'reports.x');
    const ctx = await branchCtx(req);
    const { id: rid } = parse(idParam, req.params);
    const r = await one(req.tenant.pool, 'SELECT * FROM shift_reports WHERE id = $1 AND branch_id = $2', [rid, ctx.branchId]);
    if (!r) throw notFound();
    return r;
  });

  // Business overview dashboard: KPIs + daily trend + sales by branch over a date range and a set of branches.
  app.get('/reports/dashboard', async (req) => {
    const a = requirePerm(req, 'reports.monthly');
    const q = parse(z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      branch_ids: z.string().regex(/^\d+(,\d+)*$/).optional(),
    }), req.query);
    const pool = req.tenant.pool;
    const branches = await reportBranches(req, a, q.branch_ids);
    const ids = branches.map((b) => b.id);
    const P = [q.from, q.to, ids];
    // Inclusive local-date window per branch timezone.
    const win = (col: string) => `(${col} AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date AND b.id = ANY($3)`;
    const sales = await one<any>(pool,
      `SELECT coalesce(sum(t.total),0) AS sales, count(*)::int AS tickets, count(DISTINCT (t.closed_at AT TIME ZONE b.timezone)::date)::int AS days,
              coalesce(sum(t.discount_amount),0) AS discounts, coalesce(sum(t.change_amount),0) AS change_given
         FROM tickets t JOIN branches b ON b.id = t.branch_id WHERE t.status = 'paid' AND ${win('t.closed_at')}`, P);
    const pay = await one<any>(pool,
      `SELECT coalesce(sum(p.base_amount),0) AS net_receipts,
              coalesce(sum(p.base_amount) FILTER (WHERE p.method_type = 'cash'),0) AS cash_net,
              coalesce(-sum(p.base_amount) FILTER (WHERE p.kind = 'refund'),0) AS refunds
         FROM payments p JOIN branches b ON b.id = p.branch_id WHERE ${win('coalesce(p.value_at, p.created_at)')}`, P);
    const exp = await one<any>(pool,
      `SELECT coalesce(sum(e.base_amount),0) AS total, coalesce(sum(e.base_amount) FILTER (WHERE e.paid_from_cash),0) AS cash
         FROM counter_expenses e JOIN branches b ON b.id = e.branch_id WHERE e.voided_at IS NULL AND ${win('e.created_at')}`, P);
    const owed = await one<any>(pool,
      `SELECT coalesce(sum(balance),0) AS owed FROM clients WHERE company_id = ANY($1)`, [[...new Set(branches.map((b) => b.company_id))]]);
    const daily = await many(pool,
      `SELECT to_char((t.closed_at AT TIME ZONE b.timezone)::date, 'YYYY-MM-DD') AS day, sum(t.total) AS total, count(*)::int AS tickets
         FROM tickets t JOIN branches b ON b.id = t.branch_id WHERE t.status = 'paid' AND ${win('t.closed_at')} GROUP BY 1 ORDER BY 1`, P);
    const byBranch = await many(pool,
      `SELECT b.id, b.name, coalesce(sum(t.total),0) AS total, count(t.id)::int AS tickets
         FROM branches b LEFT JOIN tickets t ON t.branch_id = b.id AND t.status = 'paid'
              AND (t.closed_at AT TIME ZONE b.timezone)::date BETWEEN $1::date AND $2::date
        WHERE b.id = ANY($3) GROUP BY b.id, b.name ORDER BY total DESC`, P);
    return {
      branches: branches.map(({ id: bid, name, base_currency }) => ({ id: bid, name, currency: base_currency })),
      currencies: [...new Set(branches.map((b) => b.base_currency))],
      kpis: {
        sales: sales.sales, tickets: sales.tickets, days: sales.days, discounts: sales.discounts,
        net_receipts: pay.net_receipts, refunds: pay.refunds,
        net_cash: round2(pay.cash_net - sales.change_given - exp.cash), // cash in minus change, cash refunds and cash expenses
        counter_expenses: exp.total, owed_by_clients: owed.owed,
      },
      daily, by_branch: byBranch,
    };
  });

  // Monthly consolidated: whole tenant (accessible companies), one company, or one branch.
  app.get('/reports/monthly', async (req) => {
    const a = requirePerm(req, 'reports.monthly');
    const q = parse(z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), company_id: id.optional(), branch_id: id.optional(),
    }), req.query);
    if (q.company_id && !canAccessCompany(a, q.company_id)) throw forbidden();
    if (q.branch_id) {
      const br = await one<any>(req.tenant.pool, 'SELECT company_id FROM branches WHERE id = $1', [q.branch_id]);
      if (!br || !canAccessCompany(a, br.company_id)) throw forbidden();
    }
    const [y, m] = q.month.split('-').map(Number);
    const from = `${q.month}-01`;
    const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    return monthlyReport(req.tenant.pool, { from, to, companyIds: companyIdsFor(a), companyId: q.company_id, branchId: q.branch_id });
  });
}
