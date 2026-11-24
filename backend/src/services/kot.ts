import { many, nextSeq, one, type Client } from '../lib/db.js';
import type { BranchCtx } from '../plugins/context.js';
import type { Events } from '../realtime.js';
import { deductForLine, type LowStock } from './stock.js';

/** Queue a kitchen ticket on every active printer of a station in this branch (or record that there is none). */
export async function printToStation(c: Client, ctx: BranchCtx, stationId: number, refId: number, payload: object, ev: Events) {
  const printers = await many<any>(c,
    `SELECT id, connection, chars_per_line FROM printers WHERE branch_id = $1 AND kind = 'kot' AND station_id = $2 AND active ORDER BY id`,
    [ctx.branchId, stationId]);
  if (!printers.length) {
    await c.query(`INSERT INTO print_jobs (branch_id, kind, ref_id, payload, status) VALUES ($1,'kot',$2,$3,'no_printer')`, [ctx.branchId, refId, JSON.stringify(payload)]);
    return;
  }
  for (const p of printers) {
    const job = await one<any>(c,
      `INSERT INTO print_jobs (branch_id, printer_id, kind, ref_id, payload) VALUES ($1,$2,'kot',$3,$4) RETURNING *`,
      [ctx.branchId, p.id, refId, JSON.stringify(payload)]);
    ev.print(ctx.branchId, { ...job, connection: p.connection, chars_per_line: p.chars_per_line });
  }
}

/**
 * Accept / send an order: new lines are deducted from stock (if the item tracks stock), grouped by route
 * and dispatched as one KOT per preparation station (each kitchen / bar) to its printers and its KDS tab.
 */
export async function sendToKitchen(c: Client, ctx: BranchCtx, ticketId: number, userId: number | null, ev: Events) {
  const t = await one<any>(c,
    `SELECT t.*, dt.name AS table_name, u.full_name AS waiter_name FROM tickets t
       LEFT JOIN dining_tables dt ON dt.id = t.table_id LEFT JOIN users u ON u.id = coalesce(t.waiter_id, t.created_by)
      WHERE t.id = $1 AND t.branch_id = $2`, [ticketId, ctx.branchId]);
  if (!t) return { sent: 0 };
  const lines = await many<any>(c,
    `SELECT l.*, i.tracks_stock FROM ticket_lines l JOIN menu_items i ON i.id = l.menu_item_id
      WHERE l.ticket_id = $1 AND l.status = 'active' AND l.kitchen_status = 'new' ORDER BY l.id FOR UPDATE OF l`, [ticketId]);

  if (t.status === 'pending') await c.query(`UPDATE tickets SET status = 'open' WHERE id = $1`, [ticketId]);
  if (!lines.length) return { sent: 0 };

  const low: LowStock[] = [];
  for (const l of lines) {
    if (l.tracks_stock && !l.stock_deducted) low.push(...(await deductForLine(c, ctx.branchId, t, l, userId)));
  }

  // One kitchen ticket per preparation station (any number of kitchens / bars).
  const stationIds = [...new Set(lines.map((l) => l.station_id).filter((s): s is number => s != null))];
  for (const stationId of stationIds) {
    const group = lines.filter((l) => l.station_id === stationId);
    const st = await one<any>(c, 'SELECT id, name, color FROM prep_stations WHERE id = $1', [stationId]);
    const kotNo = await nextSeq(c, ctx.branchId, 'kot');
    const payloadLines = group.map((l) => ({
      line_id: l.id, name: l.item_name, size: l.size_name, qty: l.qty, modifiers: l.modifiers,
      notes: l.notes, allergy: l.allergy_note, seat: l.seat_no,
    }));
    const kot = await one<any>(c,
      `INSERT INTO kot_orders (ticket_id, branch_id, station_id, kot_no, lines) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [ticketId, ctx.branchId, stationId, kotNo, JSON.stringify(payloadLines)]);
    await printToStation(c, ctx, stationId, kot.id, {
      type: 'kot', station: st.name, kot_no: kotNo, ticket_ref: t.ticket_ref, order_type: t.order_type, table: t.table_name,
      pax: t.pax, staff: t.waiter_name, customer: t.customer_name, notes: t.notes, created_at: kot.created_at, lines: payloadLines,
    }, ev);
    ev.branch(ctx.branchId, 'kds:new', { ...kot, station_name: st.name, ticket_ref: t.ticket_ref, table_name: t.table_name, order_type: t.order_type });
  }

  await c.query(
    `UPDATE ticket_lines SET kitchen_status = CASE WHEN station_id IS NULL THEN 'served' ELSE 'sent' END, sent_at = now()
      WHERE id = ANY($1)`, [lines.map((l) => l.id)]);
  await c.query(`UPDATE tickets SET guest_status = CASE WHEN guest_status = 'seated' THEN 'ordered' ELSE guest_status END WHERE id = $1`, [ticketId]);
  for (const l of low) ev.branch(ctx.branchId, 'stock:low', l);
  ev.branch(ctx.branchId, 'tables:changed', { ticket_id: ticketId });
  return { sent: lines.length };
}
