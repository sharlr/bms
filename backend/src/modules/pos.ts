import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, tx, type Client } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { round2, round3 } from '../lib/money.js';
import { id, idParam, money, parse, qty, reqText, text } from '../lib/validate.js';
import { authorize, branchCtx, hasPerm, requirePerm, type BranchCtx } from '../plugins/context.js';
import { Events } from '../realtime.js';
import { printToStation, sendToKitchen } from '../services/kot.js';
import { returnForLine, transferLineStock } from '../services/stock.js';
import {
  addLine, assertEditable, createTicket, currentSession, loadTicket, recalc, resolveItem, ticketDetail, validateRefs,
  type Source,
} from '../services/tickets.js';

export const override = z.object({ user_id: id, pin: z.string().regex(/^\d{4}$/) }).nullish();
const lineInput = z.object({
  menu_item_id: id, size_id: id.nullish(), qty: qty.default(1), modifier_ids: z.array(id).max(30).default([]),
  notes: text(300).nullish(), allergy_note: text(300).nullish(), seat_no: z.coerce.number().int().min(1).max(500).nullish(),
});

export function sourceFor(req: FastifyRequest): Source {
  const m = req.auth?.deviceId ? req.device?.mode : null;
  return m === 'waiter' ? 'waiter' : m === 'takeaway' ? 'takeaway' : 'pos';
}

/** Run a ticket mutation in a transaction and flush realtime events after commit. */
export async function withTicket<T>(req: FastifyRequest, fn: (c: Client, ctx: BranchCtx, ev: Events) => Promise<T>): Promise<T> {
  const ctx = await branchCtx(req);
  const ev = new Events(req.tenant.slug);
  const out = await tx(req.tenant.pool, (c) => fn(c, ctx, ev));
  ev.flush();
  return out;
}

export async function sessionIdFor(c: Client, req: FastifyRequest, ctx: BranchCtx, create: boolean) {
  const reg = req.auth?.deviceId && req.device ? req.device.register_id : null;
  const s = await currentSession(c, ctx, reg, req.auth!.user.id, create);
  return s?.id ?? null;
}

async function cancelTicket(
  c: Client, req: FastifyRequest, ctx: BranchCtx, t: any, kind: 'ticket' | 'table_clear', reason: string,
  approver: number, returnStock: boolean, ev: Events,
) {
  if (t.paid_amount > 0) throw conflict(`Ticket ${t.ticket_ref} has payments — refund it instead`);
  const sessionId = await sessionIdFor(c, req, ctx, true);
  await c.query(
    `INSERT INTO cancellations (company_id, branch_id, pos_session_id, ticket_id, kind, amount, reason, user_id, approved_by, item_name, qty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL)`,
    [ctx.companyId, ctx.branchId, sessionId, t.id, kind, t.total, reason, req.auth!.user.id, approver, `Ticket ${t.ticket_ref}`]);
  if (returnStock) {
    const lines = await many<any>(c, `SELECT id FROM ticket_lines WHERE ticket_id = $1 AND stock_deducted`, [t.id]);
    for (const l of lines) await returnForLine(c, ctx.branchId, t, l.id, 1, 'sale_reversal', req.auth!.user.id);
  }
  await c.query(
    `UPDATE tickets SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, pos_session_id = coalesce(pos_session_id, $4),
            updated_at = now() WHERE id = $1`, [t.id, approver, reason, sessionId]);
  await c.query(`UPDATE kot_orders SET status = 'cancelled', updated_at = now() WHERE ticket_id = $1 AND status <> 'served'`, [t.id]);
  await c.query('DELETE FROM delivery_commissions WHERE ticket_id = $1', [t.id]);
  ev.branch(ctx.branchId, 'kds:cancel', { ticket_id: t.id, ticket_ref: t.ticket_ref });
  ev.branch(ctx.branchId, 'tables:changed', { ticket_id: t.id });
}

export function posRoutes(app: FastifyInstance) {
  // ---------- Floor plan ----------
  app.get('/pos/floor', async (req) => {
    const a = requirePerm(req, 'pos.access');
    const ctx = await branchCtx(req);
    const floors = await many(req.tenant.pool, 'SELECT id, name, sort, layout, width, height FROM floors WHERE branch_id = $1 AND active ORDER BY sort, id', [ctx.branchId]);
    const tables = await many<any>(req.tenant.pool,
      `SELECT dt.id, dt.floor_id, dt.name, dt.seats, dt.shape, dt.pos_x, dt.pos_y, dt.width, dt.height, dt.qr_token,
              t.id AS ticket_id, t.ticket_ref, t.status AS ticket_status, t.pax, t.total, t.guest_status, t.opened_at,
              u.full_name AS waiter_name,
              (SELECT count(*)::int FROM tickets x WHERE x.table_id = dt.id AND x.status IN ('pending','open')) AS ticket_count,
              (SELECT to_char(r.reserved_for AT TIME ZONE b.timezone, 'HH24:MI') FROM reservations r
                WHERE r.table_id = dt.id AND r.status IN ('pending','confirmed')
                  AND (r.reserved_for AT TIME ZONE b.timezone)::date = (now() AT TIME ZONE b.timezone)::date ORDER BY r.reserved_for LIMIT 1) AS reserved_at,
              (SELECT count(*)::int FROM ticket_lines l WHERE l.ticket_id = t.id AND l.status = 'active' AND l.kitchen_status = 'new' AND l.from_customer) AS customer_pending
         FROM dining_tables dt JOIN branches b ON b.id = dt.branch_id
         LEFT JOIN LATERAL (SELECT * FROM tickets WHERE table_id = dt.id AND status IN ('pending','open') ORDER BY id LIMIT 1) t ON true
         LEFT JOIN users u ON u.id = coalesce(t.waiter_id, t.created_by)
        WHERE dt.branch_id = $1 AND dt.active ORDER BY dt.name`, [ctx.branchId]);
    if (!hasPerm(a, 'floor.manage')) for (const t of tables) delete t.qr_token;
    return { floors, tables };
  });

  app.post('/pos/tables/:id/open', async (req, reply) => {
    const a = requirePerm(req, 'pos.order');
    const { id: tableId } = parse(idParam, req.params);
    const b = parse(z.object({ pax: z.coerce.number().int().min(1).max(500) }), req.body);
    const t = await withTicket(req, async (c, ctx, ev) => {
      const src = sourceFor(req);
      const t = await createTicket(c, ctx, {
        order_type: 'dine_in', source: src, channel_type: src, table_id: tableId, pax: b.pax, waiter_id: a.user.id, created_by: a.user.id,
      });
      ev.branch(ctx.branchId, 'tables:changed', { table_id: tableId });
      return t;
    });
    reply.code(201);
    return ticketDetail(req.tenant.pool, t.id);
  });

  // ---------- Tickets ----------
  app.get('/pos/tickets', async (req) => {
    requirePerm(req, 'pos.access');
    const ctx = await branchCtx(req);
    const q = parse(z.object({
      status: z.enum(['pending', 'open', 'paid', 'cancelled', 'active', 'scheduled']).optional(),
      order_type: z.enum(['dine_in', 'takeaway', 'delivery']).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), q: text(40).optional(),
    }), req.query);
    const params: unknown[] = [ctx.branchId];
    let where = 't.branch_id = $1';
    if (q.status === 'active') where += ` AND t.status IN ('pending','open')`;
    else if (q.status === 'scheduled') where += ` AND t.status IN ('pending','open') AND t.scheduled_for > now()`;
    else if (q.status) { params.push(q.status); where += ` AND t.status = $${params.length}`; }
    if (q.order_type) { params.push(q.order_type); where += ` AND t.order_type = $${params.length}`; }
    if (q.date) { params.push(q.date); where += ` AND (t.opened_at AT TIME ZONE b.timezone)::date = $${params.length}::date`; }
    if (q.q) { params.push(`%${q.q}%`); where += ` AND (t.ticket_ref ILIKE $${params.length} OR t.customer_name ILIKE $${params.length} OR t.customer_phone ILIKE $${params.length})`; }
    return many(req.tenant.pool,
      `SELECT t.id, t.ticket_ref, t.status, t.refund_status, t.order_type, t.source, t.total, t.paid_amount, t.pax, t.opened_at, t.closed_at, t.scheduled_for,
              t.customer_name, dt.name AS table_name, dc.name AS delivery_company_name, rc.name AS channel_name
         FROM tickets t JOIN branches b ON b.id = t.branch_id LEFT JOIN dining_tables dt ON dt.id = t.table_id
         LEFT JOIN delivery_companies dc ON dc.id = t.delivery_company_id LEFT JOIN receipt_channels rc ON rc.id = t.receipt_channel_id
        WHERE ${where} ORDER BY t.id DESC LIMIT 300`, params);
  });

  app.get('/pos/tickets/:id', async (req) => {
    requirePerm(req, 'pos.access');
    const ctx = await branchCtx(req);
    const { id: tid } = parse(idParam, req.params);
    await loadTicket(req.tenant.pool, tid, ctx);
    return ticketDetail(req.tenant.pool, tid);
  });

  const ticketFields = z.object({
    order_type: z.enum(['dine_in', 'takeaway', 'delivery']), pax: z.coerce.number().int().min(0).max(500),
    client_id: id.nullable(), customer_name: text(120).nullable(), customer_phone: text(40).nullable(),
    delivery_company_id: id.nullable(), delivery_zone_id: id.nullable(), delivery_address: text(300).nullable(),
    notes: text(500).nullable(), table_id: id.nullable(),
    scheduled_for: z.coerce.date().nullable(), delivery_lat: z.coerce.number().min(-90).max(90).nullable(),
    delivery_lng: z.coerce.number().min(-180).max(180).nullable(),
    guest_status: z.enum(['seated', 'ordered', 'served', 'bill_requested']),
  });

  app.post('/pos/tickets', async (req, reply) => {
    const a = requirePerm(req, 'pos.order');
    const b = parse(ticketFields.omit({ guest_status: true }).partial().extend({ order_type: z.enum(['dine_in', 'takeaway', 'delivery']) }).strict(), req.body);
    const t = await withTicket(req, async (c, ctx, ev) => {
      const src = sourceFor(req);
      const channel = b.order_type === 'delivery' ? 'delivery' : b.order_type === 'takeaway' ? 'takeaway' : src;
      const t = await createTicket(c, ctx, { ...b, source: src, channel_type: channel, waiter_id: a.user.id, created_by: a.user.id });
      ev.branch(ctx.branchId, 'tables:changed', { ticket_id: t.id });
      return t;
    });
    reply.code(201);
    return ticketDetail(req.tenant.pool, t.id);
  });

  app.patch('/pos/tickets/:id', async (req) => {
    requirePerm(req, 'pos.order');
    const { id: tid } = parse(idParam, req.params);
    const b = parse(ticketFields.partial().strict(), req.body);
    await withTicket(req, async (c, ctx, ev) => {
      const t = await loadTicket(c, tid, ctx, true);
      assertEditable(t);
      await validateRefs(c, ctx, b);
      if (b.table_id && b.table_id !== t.table_id) {
        const busy = await one(c, `SELECT 1 FROM tickets WHERE table_id = $1 AND status IN ('pending','open') AND id <> $2`, [b.table_id, tid]);
        if (busy) throw conflict('Target table is occupied');
      }
      const cols = Object.keys(b);
      if (!cols.length) return;
      await c.query(`UPDATE tickets SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
        [tid, ...cols.map((k) => (b as any)[k])]);
      // Prices differ per order type: reprice every active line when the order type changes.
      if (b.order_type && b.order_type !== t.order_type) {
        if (t.paid_amount > 0) throw conflict('Cannot change order type after payments were taken');
        const lines = await many<any>(c, `SELECT * FROM ticket_lines WHERE ticket_id = $1 AND status = 'active'`, [tid]);
        for (const l of lines) {
          const r = await resolveItem(c, ctx, l.menu_item_id, l.size_id, (l.modifiers as any[]).map((m) => m.id), b.order_type);
          await c.query('UPDATE ticket_lines SET unit_price = $2, line_total = $3 WHERE id = $1',
            [l.id, r.unitPrice, round2(l.qty * (r.unitPrice + l.modifiers_total))]);
        }
        await recalc(c, tid, ctx);
      }
      ev.branch(ctx.branchId, 'tables:changed', { ticket_id: tid });
    });
    return ticketDetail(req.tenant.pool, tid);
  });

  // ---------- Lines ----------
  app.post('/pos/tickets/:id/lines', async (req) => {
    const a = requirePerm(req, 'pos.order');
    const { id: tid } = parse(idParam, req.params);
    const b = parse(lineInput, req.body);
    await withTicket(req, async (c, ctx, ev) => {
      const t = await loadTicket(c, tid, ctx, true);
      assertEditable(t);
      await addLine(c, ctx, tid, b, a.user.id);
      await recalc(c, tid, ctx);
      ev.branch(ctx.branchId, 'tables:changed', { ticket_id: tid });
    });
    return ticketDetail(req.tenant.pool, tid);
  });

  app.patch('/pos/tickets/:id/lines/:lineId', async (req) => {
    requirePerm(req, 'pos.order');
    const p = parse(z.object({ id, lineId: id }), req.params);
    // Explicit schema without defaults: an omitted field must mean "leave unchanged".
    const b = parse(z.strictObject({
      qty: qty.optional(), modifier_ids: z.array(id).max(30).optional(), notes: text(300).nullish(),
      allergy_note: text(300).nullish(), seat_no: z.coerce.number().int().min(1).max(500).nullish(),
    }), req.body);
    await withTicket(req, async (c, ctx) => {
      const t = await loadTicket(c, p.id, ctx, true);
      assertEditable(t);
      const l = await one<any>(c, `SELECT * FROM ticket_lines WHERE id = $1 AND ticket_id = $2 AND status = 'active'`, [p.lineId, p.id]);
      if (!l) throw notFound('Line not found');
      if (l.kitchen_status !== 'new') throw conflict('Line already sent to kitchen — void it instead');
      const mods = b.modifier_ids ?? (l.modifiers as any[]).map((m) => m.id);
      const r = await resolveItem(c, ctx, l.menu_item_id, l.size_id, mods, t.order_type);
      const newQty = b.qty ?? l.qty;
      await c.query(
        `UPDATE ticket_lines SET qty = $2, modifiers = $3, modifiers_total = $4, notes = $5, allergy_note = $6, seat_no = $7, line_total = $8 WHERE id = $1`,
        [l.id, newQty, JSON.stringify(r.modifiers), r.modifiersTotal, b.notes !== undefined ? b.notes : l.notes,
          b.allergy_note !== undefined ? b.allergy_note : l.allergy_note, b.seat_no !== undefined ? b.seat_no : l.seat_no,
          round2(newQty * (l.unit_price + r.modifiersTotal))]);
      await recalc(c, p.id, ctx);
    });
    return ticketDetail(req.tenant.pool, p.id);
  });

  app.delete('/pos/tickets/:id/lines/:lineId', async (req) => {
    requirePerm(req, 'pos.order');
    const p = parse(z.object({ id, lineId: id }), req.params);
    await withTicket(req, async (c, ctx, ev) => {
      const t = await loadTicket(c, p.id, ctx, true);
      assertEditable(t);
      const r = await c.query(`DELETE FROM ticket_lines WHERE id = $1 AND ticket_id = $2 AND kitchen_status = 'new' AND status = 'active'`, [p.lineId, p.id]);
      if (!r.rowCount) throw conflict('Only unsent lines can be removed — void sent lines');
      await recalc(c, p.id, ctx);
      ev.branch(ctx.branchId, 'tables:changed', { ticket_id: p.id });
    });
    return ticketDetail(req.tenant.pool, p.id);
  });

  // Accept order & route KOTs (food -> kitchen printer, drinks -> beverage printer) + KDS.
  app.post('/pos/tickets/:id/send', async (req) => {
    const a = requirePerm(req, 'pos.order');
    const { id: tid } = parse(idParam, req.params);
    const res = await withTicket(req, async (c, ctx, ev) => {
      const t = await loadTicket(c, tid, ctx, true);
      assertEditable(t);
      const fromCustomer = await one(c, `SELECT 1 FROM ticket_lines WHERE ticket_id = $1 AND kitchen_status = 'new' AND from_customer`, [tid]);
      if ((t.status === 'pending' || fromCustomer) && !hasPerm(a, 'pos.accept_online')) throw conflict('Customer orders must be accepted by authorised staff');
      return sendToKitchen(c, ctx, tid, a.user.id, ev);
    });
    return { ...res, ticket: await ticketDetail(req.tenant.pool, tid) };
  });

  // Accept an advance (booked-for-later) customer order without sending it to the kitchen yet.
  app.post('/pos/tickets/:id/accept', async (req) => {
    requirePerm(req, 'pos.accept_online');
    const { id: tid } = parse(idParam, req.params);
    await withTicket(req, async (c, ctx, ev) => {
      const r = await c.query(`UPDATE tickets SET status = 'open', updated_at = now() WHERE id = $1 AND branch_id = $2 AND status = 'pending'`, [tid, ctx.branchId]);
      if (!r.rowCount) throw conflict('Only new customer orders can be accepted');
      ev.branch(ctx.branchId, 'tables:changed', { ticket_id: tid });
    });
    return ticketDetail(req.tenant.pool, tid);
  });

  app.post('/pos/tickets/:id/lines/:lineId/void', async (req) => {
    requirePerm(req, 'pos.order');
    const p = parse(z.object({ id, lineId: id }), req.params);
    const b = parse(z.object({ reason: reqText(200), qty: qty.optional(), return_to_stock: z.boolean().default(true), override }), req.body);
    const approver = await authorize(req, 'pos.void_line', b.override);
    await withTicket(req, async (c, ctx, ev) => {
      const t = await loadTicket(c, p.id, ctx, true);
      assertEditable(t);
      const l = await one<any>(c, `SELECT * FROM ticket_lines WHERE id = $1 AND ticket_id = $2 AND status = 'active' FOR UPDATE`, [p.lineId, p.id]);
      if (!l) throw notFound('Line not found');
      const vq = round3(Math.min(b.qty ?? l.qty, l.qty));
      const unit = l.line_total / l.qty;
      const amount = round2(unit * vq);
      const sessionId = await sessionIdFor(c, req, ctx, true);
      if (vq < l.qty) {
        await c.query(`UPDATE ticket_lines SET qty = qty - $2, line_total = $3 WHERE id = $1`, [l.id, vq, round2(l.line_total - amount)]);
        await c.query(
          `INSERT INTO ticket_lines (ticket_id, menu_item_id, size_id, item_name, size_name, qty, unit_price, modifiers, modifiers_total, notes,
              allergy_note, seat_no, line_total, station_id, status, kitchen_status, sent_at, stock_deducted, void_reason, voided_by, voided_at, created_by)
           SELECT ticket_id, menu_item_id, size_id, item_name, size_name, $2, unit_price, modifiers, modifiers_total, notes, allergy_note, seat_no,
                  $3, station_id, 'void', kitchen_status, sent_at, false, $4, $5, now(), created_by FROM ticket_lines WHERE id = $1`,
          [l.id, vq, amount, b.reason, approver]);
      } else {
        await c.query(`UPDATE ticket_lines SET status = 'void', void_reason = $2, voided_by = $3, voided_at = now() WHERE id = $1`, [l.id, b.reason, approver]);
      }
      if (b.return_to_stock && l.stock_deducted) await returnForLine(c, ctx.branchId, t, l.id, vq / l.qty, 'sale_reversal', approver);
      await c.query(
        `INSERT INTO cancellations (company_id, branch_id, pos_session_id, ticket_id, ticket_line_id, kind, item_name, qty, amount, reason, user_id, approved_by)
         VALUES ($1,$2,$3,$4,$5,'line',$6,$7,$8,$9,$10,$11)`,
        [ctx.companyId, ctx.branchId, sessionId, t.id, l.id, l.item_name + (l.size_name ? ` (${l.size_name})` : ''), vq, amount, b.reason, req.auth!.user.id, approver]);
      if (l.kitchen_status !== 'new' && l.station_id != null) {
        const st = await one<any>(c, 'SELECT name FROM prep_stations WHERE id = $1', [l.station_id]);
        await printToStation(c, ctx, l.station_id, t.id, { type: 'void', station: st?.name, ticket_ref: t.ticket_ref, reason: b.reason, lines: [{ name: l.item_name, size: l.size_name, qty: vq }] }, ev);
        ev.branch(ctx.branchId, 'kds:void', { ticket_id: t.id, ticket_ref: t.ticket_ref, line_id: l.id, qty: vq, name: l.item_name });
      }
      await recalc(c, p.id, ctx);
      ev.branch(ctx.branchId, 'tables:changed', { ticket_id: p.id });
    });
    return ticketDetail(req.tenant.pool, p.id);
  });

  app.post('/pos/tickets/:id/cancel', async (req) => {
    requirePerm(req, 'pos.order');
    const { id: tid } = parse(idParam, req.params);
    const b = parse(z.object({ reason: reqText(200), return_to_stock: z.boolean().default(true), override }), req.body);
    const approver = await authorize(req, 'pos.cancel_ticket', b.override);
    await withTicket(req, async (c, ctx, ev) => {
      const t = await loadTicket(c, tid, ctx, true);
      assertEditable(t);
      await cancelTicket(c, req, ctx, t, 'ticket', b.reason, approver, b.return_to_stock, ev);
    });
    return ticketDetail(req.tenant.pool, tid);
  });

  app.post('/pos/tables/:id/clear', async (req) => {
    requirePerm(req, 'pos.access');
    const { id: tableId } = parse(idParam, req.params);
    const b = parse(z.object({ reason: reqText(200), return_to_stock: z.boolean().default(true), override }), req.body);
    const approver = await authorize(req, 'pos.clear_table', b.override);
    const n = await withTicket(req, async (c, ctx, ev) => {
      const tickets = await many<any>(c, `SELECT * FROM tickets WHERE table_id = $1 AND branch_id = $2 AND status IN ('pending','open') FOR UPDATE`, [tableId, ctx.branchId]);
      for (const t of tickets) await cancelTicket(c, req, ctx, t, 'table_clear', b.reason, approver, b.return_to_stock, ev);
      ev.branch(ctx.branchId, 'tables:changed', { table_id: tableId });
      return tickets.length;
    });
    return { ok: true, cancelled: n };
  });

  // ---------- Discounts & coupons ----------
  app.post('/pos/tickets/:id/discount', async (req) => {
    requirePerm(req, 'pos.order');
    const { id: tid } = parse(idParam, req.params);
    const b = parse(z.object({
      discount_type: z.enum(['percent', 'fixed']).nullable().optional(), value: money.optional(), coupon_code: text(30).optional(), override,
    }), req.body);
    if (!b.coupon_code) await authorize(req, 'pos.discount', b.override);
    await withTicket(req, async (c, ctx) => {
      const t = await loadTicket(c, tid, ctx, true);
      assertEditable(t);
      if (b.coupon_code) {
        const cp = await one<any>(c,
          `SELECT * FROM coupons WHERE company_id = $1 AND upper(code) = upper($2) AND active
              AND (valid_from IS NULL OR valid_from <= now()) AND (valid_to IS NULL OR valid_to >= now())
              AND (max_uses IS NULL OR used_count < max_uses)`, [ctx.companyId, b.coupon_code]);
        if (!cp) throw badRequest('Coupon is invalid or expired');
        if (t.subtotal < cp.min_order) throw badRequest(`Coupon requires a minimum order of ${cp.min_order}`);
        await c.query('UPDATE tickets SET discount_type = $2, discount_value = $3, coupon_id = $4 WHERE id = $1', [tid, cp.discount_type, cp.value, cp.id]);
      } else if (!b.discount_type) {
        await c.query('UPDATE tickets SET discount_type = NULL, discount_value = 0, coupon_id = NULL WHERE id = $1', [tid]);
      } else {
        if (b.discount_type === 'percent' && (b.value ?? 0) > 100) throw badRequest('Percent discount cannot exceed 100');
        await c.query('UPDATE tickets SET discount_type = $2, discount_value = $3, coupon_id = NULL WHERE id = $1', [tid, b.discount_type, b.value ?? 0]);
      }
      await recalc(c, tid, ctx);
    });
    return ticketDetail(req.tenant.pool, tid);
  });

  // ---------- Split check by items or by seat (split by amount = partial payments) ----------
  app.post('/pos/tickets/:id/split', async (req, reply) => {
    const a = requirePerm(req, 'pos.split');
    const { id: tid } = parse(idParam, req.params);
    const b = parse(z.object({
      mode: z.enum(['items', 'seat']), lines: z.array(z.object({ line_id: id, qty })).max(200).optional(),
      seat_no: z.coerce.number().int().min(1).optional(),
    }), req.body);
    const newId = await withTicket(req, async (c, ctx, ev) => {
      const t = await loadTicket(c, tid, ctx, true);
      assertEditable(t);
      if (t.paid_amount > 0) throw conflict('Split before taking payments (use partial payments to split by amount)');
      const active = await many<any>(c, `SELECT * FROM ticket_lines WHERE ticket_id = $1 AND status = 'active' FOR UPDATE`, [tid]);
      let moves: { line: any; qty: number }[];
      if (b.mode === 'seat') {
        if (!b.seat_no) throw badRequest('seat_no required');
        moves = active.filter((l) => l.seat_no === b.seat_no).map((l) => ({ line: l, qty: l.qty }));
      } else {
        moves = (b.lines ?? []).map((x) => {
          const l = active.find((y) => y.id === x.line_id);
          if (!l) throw badRequest('Invalid line');
          if (x.qty > l.qty) throw badRequest('Quantity exceeds line quantity');
          return { line: l, qty: x.qty };
        });
      }
      if (!moves.length) throw badRequest('Nothing to split');
      const movedAll = moves.length === active.length && moves.every((m) => m.qty === m.line.qty);
      if (movedAll) throw badRequest('Cannot move every line — at least one must stay');
      const nt = await createTicket(c, ctx, {
        order_type: t.order_type, source: t.source, channel_type: (await one<any>(c, 'SELECT channel_type FROM receipt_channels WHERE id = $1', [t.receipt_channel_id])).channel_type,
        pax: 1, client_id: t.client_id, customer_name: t.customer_name, customer_phone: t.customer_phone,
        delivery_company_id: t.delivery_company_id, delivery_zone_id: t.delivery_zone_id, delivery_address: t.delivery_address,
        waiter_id: t.waiter_id, created_by: a.user.id, status: t.status,
      });
      // Split tickets share the table.
      await c.query('UPDATE tickets SET table_id = $2, parent_ticket_id = $3 WHERE id = $1', [nt.id, t.table_id, t.id]);
      for (const m of moves) {
        if (m.qty === m.line.qty) {
          await c.query('UPDATE ticket_lines SET ticket_id = $2 WHERE id = $1', [m.line.id, nt.id]);
        } else {
          const unit = m.line.line_total / m.line.qty;
          await c.query('UPDATE ticket_lines SET qty = qty - $2, line_total = $3 WHERE id = $1', [m.line.id, m.qty, round2(m.line.line_total - unit * m.qty)]);
          const nl = await one<any>(c,
            `INSERT INTO ticket_lines (ticket_id, menu_item_id, size_id, item_name, size_name, qty, unit_price, modifiers, modifiers_total, notes,
                allergy_note, seat_no, line_total, station_id, kitchen_status, sent_at, stock_deducted, created_by)
             SELECT $2, menu_item_id, size_id, item_name, size_name, $3, unit_price, modifiers, modifiers_total, notes, allergy_note, seat_no,
                    $4, station_id, kitchen_status, sent_at, stock_deducted, created_by FROM ticket_lines WHERE id = $1 RETURNING id`,
            [m.line.id, nt.id, m.qty, round2(unit * m.qty)]);
          if (m.line.stock_deducted) await transferLineStock(c, ctx.branchId, t, m.line.id, nt, nl.id, m.qty / m.line.qty, a.user.id);
        }
      }
      await recalc(c, tid, ctx);
      await recalc(c, nt.id, ctx);
      ev.branch(ctx.branchId, 'tables:changed', { ticket_id: tid });
      return nt.id;
    });
    reply.code(201);
    return { original: await ticketDetail(req.tenant.pool, tid), split: await ticketDetail(req.tenant.pool, newId) };
  });
}
