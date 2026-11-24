import { randomToken } from '../lib/crypto.js';
import { many, nextSeq, one, type Client, type Queryable } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { round2 } from '../lib/money.js';
import type { BranchCtx } from '../plugins/context.js';

export type OrderType = 'dine_in' | 'takeaway' | 'delivery';
export type Source = 'pos' | 'waiter' | 'takeaway' | 'kiosk' | 'qr' | 'online';

export async function loadTicket(c: Queryable, id: number, ctx: BranchCtx, lock = false) {
  const t = await one<any>(c, `SELECT * FROM tickets WHERE id = $1 AND branch_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, ctx.branchId]);
  if (!t) throw notFound('Ticket not found');
  return t;
}

export function assertEditable(t: any) {
  if (t.status !== 'open' && t.status !== 'pending') throw conflict(`Ticket is ${t.status}`);
}

export async function channelFor(c: Queryable, ctx: BranchCtx, type: string): Promise<number> {
  const r = await one<{ id: number }>(c,
    `SELECT id FROM receipt_channels WHERE company_id = $1 AND channel_type = $2 AND active AND (branch_id = $3 OR branch_id IS NULL)
      ORDER BY branch_id NULLS LAST, id LIMIT 1`, [ctx.companyId, type, ctx.branchId]);
  if (!r) throw badRequest(`No active receipt channel of type "${type}" configured`);
  return r.id;
}

export interface ResolvedItem {
  item: any; sizeId: number | null; sizeName: string | null; unitPrice: number;
  modifiers: { id: number; name: string; price: number }[]; modifiersTotal: number; stationId: number | null;
}

/** Price lookup, most specific first: branch+order type > branch > company+order type > company default. Size required if item has sizes. */
export async function resolveItem(
  c: Queryable, ctx: BranchCtx, itemId: number, sizeId: number | null | undefined, modifierIds: number[], orderType: string, onlineOnly = false,
): Promise<ResolvedItem> {
  const item = await one<any>(c,
    `SELECT i.*, CASE WHEN i.no_kot THEN NULL ELSE coalesce(i.station_id, cat.station_id) END AS route_station
       FROM menu_items i JOIN menu_categories cat ON cat.id = i.category_id
      WHERE i.id = $1 AND i.company_id = $2 AND i.active AND cat.active`, [itemId, ctx.companyId]);
  if (!item || (onlineOnly && !item.available_online)) throw badRequest('Menu item not available');
  const sizes = await many<any>(c, 'SELECT id, name FROM item_sizes WHERE item_id = $1 AND active', [itemId]);
  let size: any = null;
  if (sizes.length) {
    size = sizes.find((s) => s.id === sizeId);
    if (!size) throw badRequest(`Choose a size for ${item.name}`);
  } else if (sizeId) throw badRequest('This item has no sizes');
  const price = await one<{ price: number }>(c,
    `SELECT price FROM item_prices WHERE item_id = $1 AND size_id IS NOT DISTINCT FROM $2 AND (branch_id = $3 OR branch_id IS NULL)
        AND (order_type = $4 OR order_type IS NULL)
      ORDER BY branch_id NULLS LAST, order_type NULLS LAST LIMIT 1`, [itemId, size?.id ?? null, ctx.branchId, orderType]);
  if (!price) throw badRequest(`No price set for ${item.name}${size ? ' (' + size.name + ')' : ''} at this branch`);

  let modifiers: ResolvedItem['modifiers'] = [];
  const perGroup = new Map<number, number>();
  if (modifierIds.length) {
    const uniq = [...new Set(modifierIds)];
    const rows = await many<any>(c,
      `SELECT m.id, m.name, m.price_delta, m.group_id, g.max_select FROM modifiers m
         JOIN modifier_groups g ON g.id = m.group_id
         JOIN item_modifier_groups img ON img.group_id = g.id AND img.item_id = $1
        WHERE m.id = ANY($2) AND m.active AND g.active`, [itemId, uniq]);
    if (rows.length !== uniq.length) throw badRequest('Invalid modifier for this item');
    for (const r of rows) perGroup.set(r.group_id, (perGroup.get(r.group_id) ?? 0) + 1);
    for (const r of rows) if ((perGroup.get(r.group_id) ?? 0) > r.max_select) throw badRequest('Too many modifiers selected');
    modifiers = rows.map((r) => ({ id: r.id, name: r.name, price: r.price_delta }));
  }
  const required = await many<any>(c,
    `SELECT g.id, g.name, g.min_select FROM modifier_groups g JOIN item_modifier_groups img ON img.group_id = g.id
      WHERE img.item_id = $1 AND g.active AND g.min_select > 0`, [itemId]);
  for (const g of required) {
    if ((perGroup.get(g.id) ?? 0) < g.min_select) throw badRequest(`Select at least ${g.min_select} from "${g.name}"`);
  }
  return {
    item, sizeId: size?.id ?? null, sizeName: size?.name ?? null, unitPrice: price.price,
    modifiers, modifiersTotal: round2(modifiers.reduce((a, m) => a + m.price, 0)), stationId: item.route_station,
  };
}

export interface LineInput {
  menu_item_id: number; size_id?: number | null; qty: number; modifier_ids?: number[];
  notes?: string | null; allergy_note?: string | null; seat_no?: number | null;
}

export async function addLine(c: Client, ctx: BranchCtx, ticketId: number, l: LineInput, userId: number | null, opts: { onlineOnly?: boolean; fromCustomer?: boolean } = {}) {
  const t = await one<{ order_type: string }>(c, 'SELECT order_type FROM tickets WHERE id = $1', [ticketId]);
  const r = await resolveItem(c, ctx, l.menu_item_id, l.size_id, l.modifier_ids ?? [], t!.order_type, opts.onlineOnly);
  const lineTotal = round2(l.qty * (r.unitPrice + r.modifiersTotal));
  return one<any>(c,
    `INSERT INTO ticket_lines (ticket_id, menu_item_id, size_id, item_name, size_name, qty, unit_price, modifiers, modifiers_total,
        notes, allergy_note, seat_no, line_total, station_id, created_by, from_customer)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [ticketId, l.menu_item_id, r.sizeId, r.item.name, r.sizeName, l.qty, r.unitPrice, JSON.stringify(r.modifiers), r.modifiersTotal,
      l.notes || null, l.allergy_note || null, l.seat_no ?? null, lineTotal, r.stationId, userId, !!opts.fromCustomer]);
}

/** Recompute subtotal / discount / tax / total from active lines. */
export async function recalc(c: Client, ticketId: number, ctx: BranchCtx) {
  const t = await one<any>(c, 'SELECT discount_type, discount_value FROM tickets WHERE id = $1', [ticketId]);
  const s = await one<{ subtotal: number }>(c,
    `SELECT coalesce(sum(line_total), 0) AS subtotal FROM ticket_lines WHERE ticket_id = $1 AND status = 'active'`, [ticketId]);
  const subtotal = round2(s!.subtotal);
  let discount = 0;
  if (t.discount_type === 'percent') discount = round2((subtotal * Math.min(t.discount_value, 100)) / 100);
  else if (t.discount_type === 'fixed') discount = Math.min(round2(t.discount_value), subtotal);
  const net = round2(subtotal - discount);
  const r = ctx.taxRate;
  const tax = ctx.taxInclusive ? round2((net * r) / (100 + r)) : round2((net * r) / 100);
  const total = ctx.taxInclusive ? net : round2(net + tax);
  return one<any>(c,
    `UPDATE tickets SET subtotal = $2, discount_amount = $3, tax_amount = $4, total = $5, updated_at = now() WHERE id = $1 RETURNING *`,
    [ticketId, subtotal, discount, tax, total]);
}

export interface CreateTicketInput {
  order_type: OrderType; source: Source; channel_type: string; table_id?: number | null; pax?: number;
  client_id?: number | null; customer_name?: string | null; customer_phone?: string | null;
  delivery_company_id?: number | null; delivery_zone_id?: number | null; delivery_address?: string | null;
  notes?: string | null; status?: 'pending' | 'open'; waiter_id?: number | null; created_by?: number | null;
  scheduled_for?: Date | string | null; delivery_lat?: number | null; delivery_lng?: number | null;
}

/** A date + time typed in the branch's local timezone, as an absolute timestamp. */
export async function branchLocalTime(c: Queryable, branchId: number, date: string, time: string): Promise<Date> {
  const r = await one<{ t: Date }>(c, 'SELECT (($2::date + $3::time) AT TIME ZONE timezone) AS t FROM branches WHERE id = $1', [branchId, date, time]);
  return r!.t;
}

/** Booked for later: further ahead than this, an order is accepted but not sent to the kitchen automatically. */
export const ADVANCE_MINUTES = 60;
export const isAdvance = (d?: Date | string | null) => !!d && new Date(d).getTime() > Date.now() + ADVANCE_MINUTES * 60_000;
export function checkSchedule(d: Date) {
  if (d.getTime() < Date.now() - 10 * 60_000) throw badRequest('Choose a date and time in the future');
  if (d.getTime() > Date.now() + 60 * 86_400_000) throw badRequest('Bookings can be made up to 60 days ahead');
}

export async function validateRefs(c: Queryable, ctx: BranchCtx, i: Partial<CreateTicketInput>) {
  if (i.table_id && !(await one(c, 'SELECT 1 FROM dining_tables WHERE id = $1 AND branch_id = $2 AND active', [i.table_id, ctx.branchId])))
    throw badRequest('Invalid table');
  if (i.client_id && !(await one(c, 'SELECT 1 FROM clients WHERE id = $1 AND company_id = $2 AND active', [i.client_id, ctx.companyId])))
    throw badRequest('Invalid client');
  if (i.delivery_company_id && !(await one(c, 'SELECT 1 FROM delivery_companies WHERE id = $1 AND company_id = $2 AND active', [i.delivery_company_id, ctx.companyId])))
    throw badRequest('Invalid delivery company');
  if (i.delivery_zone_id && !(await one(c, 'SELECT 1 FROM delivery_zones WHERE id = $1 AND company_id = $2 AND active', [i.delivery_zone_id, ctx.companyId])))
    throw badRequest('Invalid delivery zone');
}

export async function createTicket(c: Client, ctx: BranchCtx, i: CreateTicketInput) {
  await validateRefs(c, ctx, i);
  if (i.order_type === 'dine_in' && i.table_id) {
    const busy = await one(c, `SELECT id FROM tickets WHERE table_id = $1 AND status IN ('pending','open') FOR UPDATE`, [i.table_id]);
    if (busy) throw conflict('Table already has an open order');
  }
  const channelId = await channelFor(c, ctx, i.channel_type);
  const no = await nextSeq(c, ctx.branchId, 'ticket');
  const ref = `${ctx.branchCode}-${String(no).padStart(6, '0')}`;
  return one<any>(c,
    `INSERT INTO tickets (company_id, branch_id, receipt_channel_id, ticket_no, ticket_ref, source, order_type, status, table_id, pax,
        client_id, customer_name, customer_phone, delivery_company_id, delivery_zone_id, delivery_address, notes, currency,
        public_token, waiter_id, created_by, scheduled_for, delivery_lat, delivery_lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
    [ctx.companyId, ctx.branchId, channelId, no, ref, i.source, i.order_type, i.status ?? 'open',
      i.order_type === 'dine_in' ? i.table_id ?? null : null, i.pax ?? 1, i.client_id ?? null, i.customer_name ?? null,
      i.customer_phone ?? null, i.delivery_company_id ?? null,
      i.delivery_zone_id ?? null, i.delivery_address ?? null, i.notes ?? null, ctx.currency, randomToken(18),
      i.waiter_id ?? null, i.created_by ?? null, i.scheduled_for ?? null, i.delivery_lat ?? null, i.delivery_lng ?? null]);
}

export async function ticketDetail(c: Queryable, id: number) {
  const t = await one<any>(c,
    `SELECT t.*, dt.name AS table_name, cl.name AS client_name, cl.phone AS client_phone, cl.address AS client_address,
            cl.tax_id AS client_tax_id, dc.name AS delivery_company_name, dz.name AS delivery_zone_name,
            rc.name AS channel_name, rc.code AS channel_code, w.full_name AS waiter_name
       FROM tickets t
       LEFT JOIN dining_tables dt ON dt.id = t.table_id
       LEFT JOIN clients cl ON cl.id = t.client_id
       LEFT JOIN delivery_companies dc ON dc.id = t.delivery_company_id
       LEFT JOIN delivery_zones dz ON dz.id = t.delivery_zone_id
       LEFT JOIN receipt_channels rc ON rc.id = t.receipt_channel_id
       LEFT JOIN users w ON w.id = t.waiter_id
      WHERE t.id = $1`, [id]);
  if (!t) throw notFound('Ticket not found');
  t.lines = await many(c, 'SELECT * FROM ticket_lines WHERE ticket_id = $1 ORDER BY id', [id]);
  t.payments = await many(c,
    `SELECT p.*, pm.name AS method_name FROM payments p JOIN payment_methods pm ON pm.id = p.payment_method_id WHERE p.ticket_id = $1 ORDER BY p.id`, [id]);
  t.commissions = await many(c, 'SELECT * FROM delivery_commissions WHERE ticket_id = $1 ORDER BY id', [id]);
  t.balance_due = round2(Math.max(0, t.total - t.paid_amount + t.change_amount));
  delete t.public_token;
  return t;
}

/** Find the register session for this terminal; auto-open one when `create` is set. */
export async function currentSession(c: Client, ctx: BranchCtx, registerId: number | null, userId: number, create = true) {
  let regId = registerId;
  if (!regId) {
    const r = await one<{ id: number }>(c, 'SELECT id FROM registers WHERE branch_id = $1 AND active ORDER BY id LIMIT 1', [ctx.branchId]);
    if (!r) throw badRequest('No register configured for this branch');
    regId = r.id;
  }
  const s = await one<any>(c, `SELECT * FROM pos_sessions WHERE register_id = $1 AND status = 'open'`, [regId]);
  if (s || !create) return s ?? null;
  return one<any>(c,
    `INSERT INTO pos_sessions (branch_id, register_id, opened_by) VALUES ($1,$2,$3)
     ON CONFLICT (register_id) WHERE status = 'open' DO UPDATE SET opened_at = pos_sessions.opened_at RETURNING *`,
    [ctx.branchId, regId, userId]);
}
