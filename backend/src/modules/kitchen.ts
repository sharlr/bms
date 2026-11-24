import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, type Client, type Queryable } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { id, idParam, parse } from '../lib/validate.js';
import { branchCtx, requirePerm, type BranchCtx } from '../plugins/context.js';
import type { Events } from '../realtime.js';
import { withTicket } from './pos.js';

const DONE = ['ready', 'served'];
const STARTED = ['preparing', 'ready', 'served'];

/**
 * Derive each KOT's status from its lines, mark the guest as served when nothing is left to cook,
 * and tell the POS when the whole order is ready.
 */
async function syncTicket(c: Client, ctx: BranchCtx, ticketId: number, ev: Events, justReady: boolean) {
  const kots = await many<any>(c, `SELECT id, status, lines FROM kot_orders WHERE ticket_id = $1 AND status <> 'cancelled'`, [ticketId]);
  for (const k of kots) {
    const ids = (k.lines as any[]).map((l) => l.line_id);
    const ls = await many<any>(c, `SELECT kitchen_status FROM ticket_lines WHERE id = ANY($1) AND status = 'active'`, [ids]);
    if (!ls.length) continue;
    const st = ls.every((l) => l.kitchen_status === 'served') ? 'served'
      : ls.every((l) => DONE.includes(l.kitchen_status)) ? 'ready'
        : ls.some((l) => STARTED.includes(l.kitchen_status)) ? 'preparing' : k.status === 'new' ? 'new' : 'accepted';
    if (st !== k.status) await c.query(`UPDATE kot_orders SET status = $2, updated_at = now() WHERE id = $1`, [k.id, st]);
  }
  const t = await one<any>(c,
    `SELECT t.id, t.ticket_ref, t.order_type, t.customer_name, dt.name AS table_name,
            (SELECT count(*)::int FROM ticket_lines l WHERE l.ticket_id = t.id AND l.status = 'active' AND l.kitchen_status NOT IN ('ready','served')) AS pending
       FROM tickets t LEFT JOIN dining_tables dt ON dt.id = t.table_id WHERE t.id = $1`, [ticketId]);
  if (t.pending === 0) {
    await c.query(`UPDATE tickets SET guest_status = 'served' WHERE id = $1 AND guest_status = 'ordered'`, [ticketId]);
    if (justReady) ev.branch(ctx.branchId, 'order:ready', { ticket_id: t.id, ticket_ref: t.ticket_ref, table_name: t.table_name, order_type: t.order_type, customer_name: t.customer_name });
  }
  ev.branch(ctx.branchId, 'kds:update', { ticket_id: ticketId });
  ev.branch(ctx.branchId, 'tables:changed', { ticket_id: ticketId });
}

/** Kitchen staff of this branch: active users whose role explicitly grants kds.view. */
async function kitchenStaff(c: Queryable, ctx: BranchCtx) {
  return many<{ id: number; full_name: string; color: string }>(c,
    `SELECT u.id, u.full_name, u.color FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.active AND 'kds.view' = ANY(r.permissions)
        AND EXISTS (SELECT 1 FROM user_access ua WHERE ua.user_id = u.id AND ua.company_id = $1 AND (ua.branch_id IS NULL OR ua.branch_id = $2))
      ORDER BY u.full_name`, [ctx.companyId, ctx.branchId]);
}

/** The cook a line is assigned to: a chosen kitchen staff member, else the signed-in user. */
async function cookFor(c: Queryable, ctx: BranchCtx, cookId: number | undefined, userId: number) {
  if (!cookId) return userId;
  if (!(await kitchenStaff(c, ctx)).some((s) => s.id === cookId)) throw badRequest('Not a kitchen staff member of this branch');
  return cookId;
}

export function kitchenRoutes(app: FastifyInstance) {
  app.get('/kds/staff', async (req) => {
    requirePerm(req, 'kds.view');
    return kitchenStaff(req.tenant.pool, await branchCtx(req));
  });

  app.get('/kds/orders', async (req) => {
    requirePerm(req, 'kds.view');
    const ctx = await branchCtx(req);
    const q = parse(z.object({ station_id: id.optional(), include_served: z.coerce.boolean().optional() }), req.query);
    const kots = await many<any>(req.tenant.pool,
      `SELECT k.*, st.name AS station_name, st.color AS station_color, t.ticket_ref, t.order_type, t.pax, t.customer_name, t.notes AS ticket_notes, t.scheduled_for, dt.name AS table_name
         FROM kot_orders k JOIN prep_stations st ON st.id = k.station_id JOIN tickets t ON t.id = k.ticket_id LEFT JOIN dining_tables dt ON dt.id = t.table_id
        WHERE k.branch_id = $1 AND ($2::bigint IS NULL OR k.station_id = $2)
          AND k.created_at > now() - interval '18 hours'
          AND ($3 OR k.status NOT IN ('served','cancelled'))
        ORDER BY k.created_at`, [ctx.branchId, q.station_id ?? null, !!q.include_served]);
    // Live per-line state (who took it, current status, voided) on top of the KOT snapshot.
    const ids = kots.flatMap((k) => (k.lines as any[]).map((l) => l.line_id));
    const states = await many<any>(req.tenant.pool,
      `SELECT l.id, l.kitchen_status, l.status, l.kitchen_at, u.full_name AS chef FROM ticket_lines l LEFT JOIN users u ON u.id = l.kitchen_by WHERE l.id = ANY($1)`, [ids]);
    const byId = new Map(states.map((s) => [s.id, s]));
    return kots.map((k) => ({
      ...k,
      lines: (k.lines as any[]).map((l) => {
        const s = byId.get(l.line_id);
        return { ...l, kitchen_status: s?.kitchen_status ?? 'sent', void: s?.status === 'void', chef: s?.chef ?? null, kitchen_at: s?.kitchen_at ?? null };
      }),
    }));
  });

  // Whole ticket at once (Take all / All ready / Served).
  app.post('/kds/orders/:id/status', async (req) => {
    const a = requirePerm(req, 'kds.view');
    const { id: kid } = parse(idParam, req.params);
    const b = parse(z.object({ status: z.enum(['accepted', 'preparing', 'ready', 'served']), cook_id: id.optional() }), req.body);
    return withTicket(req, async (c, ctx, ev) => {
      const k = await one<any>(c,
        `UPDATE kot_orders SET status = $3, updated_at = now() WHERE id = $1 AND branch_id = $2 AND status <> 'cancelled' RETURNING *`,
        [kid, ctx.branchId, b.status]);
      if (!k) throw notFound();
      const lineIds = (k.lines as any[]).map((l) => l.line_id);
      await c.query(
        `UPDATE ticket_lines SET kitchen_status = $2,
            kitchen_by = CASE WHEN kitchen_by IS NULL AND $2 IN ('preparing','ready') THEN $3 ELSE kitchen_by END,
            kitchen_at = CASE WHEN kitchen_at IS NULL AND $2 IN ('preparing','ready') THEN now() ELSE kitchen_at END
          WHERE id = ANY($1) AND status = 'active'
            -- only move lines forward: "take all" must not pull back lines that are already ready
            AND CASE $2 WHEN 'preparing' THEN kitchen_status IN ('new','sent','accepted')
                        WHEN 'ready' THEN kitchen_status IN ('new','sent','accepted','preparing') ELSE true END`, [lineIds, b.status, await cookFor(c, ctx, b.cook_id, a.user.id)]);
      await syncTicket(c, ctx, k.ticket_id, ev, b.status === 'ready');
      return k;
    });
  });

  // One line: a cook takes charge of it (preparing), then marks it ready / served.
  app.post('/kds/lines/:id/status', async (req) => {
    const a = requirePerm(req, 'kds.view');
    const { id: lid } = parse(idParam, req.params);
    const b = parse(z.object({ status: z.enum(['preparing', 'ready', 'served', 'sent']), cook_id: id.optional() }), req.body);
    return withTicket(req, async (c, ctx, ev) => {
      const l = await one<any>(c,
        `SELECT l.id, l.ticket_id FROM ticket_lines l JOIN tickets t ON t.id = l.ticket_id
          WHERE l.id = $1 AND t.branch_id = $2 AND l.status = 'active' AND l.kitchen_status <> 'new' FOR UPDATE OF l`, [lid, ctx.branchId]);
      if (!l) throw notFound('Line not found');
      // 'sent' = release the line back to the queue (undo "take").
      await c.query(
        `UPDATE ticket_lines SET kitchen_status = $2,
            kitchen_by = CASE WHEN $2 = 'sent' THEN NULL WHEN $2 = 'preparing' OR kitchen_by IS NULL THEN $3 ELSE kitchen_by END,
            kitchen_at = CASE WHEN $2 = 'sent' THEN NULL WHEN $2 = 'preparing' OR kitchen_at IS NULL THEN now() ELSE kitchen_at END
          WHERE id = $1`, [lid, b.status, await cookFor(c, ctx, b.cook_id, a.user.id)]);
      await syncTicket(c, ctx, l.ticket_id, ev, b.status === 'ready');
      return { ok: true };
    });
  });

  app.get('/print/jobs', async (req) => {
    requirePerm(req, 'org.manage');
    const ctx = await branchCtx(req);
    return many(req.tenant.pool,
      `SELECT pj.id, pj.kind, pj.status, pj.attempts, pj.error, pj.created_at, pj.printed_at, p.name AS printer
         FROM print_jobs pj LEFT JOIN printers p ON p.id = pj.printer_id WHERE pj.branch_id = $1 ORDER BY pj.id DESC LIMIT 200`, [ctx.branchId]);
  });
}
