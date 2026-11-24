import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomToken } from '../lib/crypto.js';
import { many, one } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { id, idParam, parse, reqText, text } from '../lib/validate.js';
import { audit, branchCtx, loadBranch, requirePerm } from '../plugins/context.js';
import { Events } from '../realtime.js';
import { branchLocalTime, checkSchedule, createTicket, ticketDetail } from '../services/tickets.js';
import { withTicket } from './pos.js';

const phone = z.string().regex(/^\+?[0-9 ()-]{6,20}$/, 'Enter a valid phone number');
const dateQ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeQ = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const booking = z.object({
  customer_name: reqText(80), customer_phone: phone, pax: z.coerce.number().int().min(1).max(100),
  date: dateQ, time: timeQ, special_request: text(500).nullish(),
});
const SELECT = `SELECT r.*, dt.name AS table_name, to_char(r.reserved_for AT TIME ZONE b.timezone, 'YYYY-MM-DD') AS local_date,
                       to_char(r.reserved_for AT TIME ZONE b.timezone, 'HH24:MI') AS local_time, t.ticket_ref
                  FROM reservations r JOIN branches b ON b.id = r.branch_id
                  LEFT JOIN dining_tables dt ON dt.id = r.table_id LEFT JOIN tickets t ON t.id = r.ticket_id`;

export function reservationRoutes(app: FastifyInstance) {
  // ---------- Customer (public) ----------
  app.post('/public/reservations', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(booking.extend({ branch_id: id }).strict(), req.body);
    const br = await one<any>(req.tenant.pool,
      `SELECT b.id, b.online_ordering, b.auto_accept_self_orders FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.id = $1 AND b.active AND c.active`, [b.branch_id]);
    if (!br?.online_ordering) throw badRequest('Online booking is not available at this restaurant');
    const ctx = await loadBranch(req, b.branch_id);
    const at = await branchLocalTime(req.tenant.pool, ctx.branchId, b.date, b.time);
    checkSchedule(at);
    const r = await one<any>(req.tenant.pool,
      `INSERT INTO reservations (company_id, branch_id, customer_name, customer_phone, pax, reserved_for, special_request, status, source, public_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'online',$9) RETURNING id, public_token, status`,
      [ctx.companyId, ctx.branchId, b.customer_name, b.customer_phone, b.pax, at, b.special_request ?? null,
        br.auto_accept_self_orders ? 'confirmed' : 'pending', randomToken(18)]);
    const ev = new Events(req.tenant.slug);
    ev.branch(ctx.branchId, 'reservation:new', { id: r.id, customer_name: b.customer_name, pax: b.pax, date: b.date, time: b.time });
    ev.flush();
    reply.code(201);
    return { token: r.public_token, status: r.status };
  });

  app.get('/public/reservations/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }), req.params);
    const r = await one<any>(req.tenant.pool,
      `SELECT r.customer_name, r.pax, r.status, r.special_request, br.name AS branch, co.name AS company,
              to_char(r.reserved_for AT TIME ZONE br.timezone, 'YYYY-MM-DD') AS date, to_char(r.reserved_for AT TIME ZONE br.timezone, 'HH24:MI') AS time
         FROM reservations r JOIN branches br ON br.id = r.branch_id JOIN companies co ON co.id = br.company_id WHERE r.public_token = $1`, [token]);
    if (!r) throw notFound();
    return r;
  });

  app.post('/public/reservations/:token/cancel', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }), req.params);
    const r = await one<any>(req.tenant.pool,
      `UPDATE reservations SET status = 'cancelled', updated_at = now() WHERE public_token = $1 AND status IN ('pending','confirmed') RETURNING id, branch_id`, [token]);
    if (!r) throw conflict('This reservation can no longer be cancelled');
    const ev = new Events(req.tenant.slug);
    ev.branch(r.branch_id, 'reservation:changed', { id: r.id });
    ev.flush();
    return { ok: true };
  });

  // ---------- Staff ----------
  app.get('/reservations', async (req) => {
    requirePerm(req, 'pos.access');
    const ctx = await branchCtx(req);
    const q = parse(z.object({ from: dateQ, to: dateQ }), req.query);
    return many(req.tenant.pool,
      `${SELECT} WHERE r.branch_id = $1 AND (r.reserved_for AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date ORDER BY r.reserved_for`,
      [ctx.branchId, q.from, q.to]);
  });

  // Phone / walk-in booking taken by staff.
  app.post('/reservations', async (req, reply) => {
    const a = requirePerm(req, 'pos.order');
    const ctx = await branchCtx(req);
    const b = parse(booking.extend({ table_id: id.nullish() }).strict(), req.body);
    if (b.table_id && !(await one(req.tenant.pool, 'SELECT 1 FROM dining_tables WHERE id = $1 AND branch_id = $2 AND active', [b.table_id, ctx.branchId]))) throw badRequest('Invalid table');
    const at = await branchLocalTime(req.tenant.pool, ctx.branchId, b.date, b.time);
    checkSchedule(at);
    const r = await one<any>(req.tenant.pool,
      `INSERT INTO reservations (company_id, branch_id, table_id, customer_name, customer_phone, pax, reserved_for, special_request, status, source, public_token, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed','staff',$9,$10) RETURNING id`,
      [ctx.companyId, ctx.branchId, b.table_id ?? null, b.customer_name, b.customer_phone, b.pax, at, b.special_request ?? null, randomToken(18), a.user.id]);
    reply.code(201);
    return one(req.tenant.pool, `${SELECT} WHERE r.id = $1`, [r.id]);
  });

  app.patch('/reservations/:id', async (req) => {
    requirePerm(req, 'pos.order');
    const ctx = await branchCtx(req);
    const { id: rid } = parse(idParam, req.params);
    const b = parse(booking.partial().extend({
      status: z.enum(['pending', 'confirmed', 'cancelled', 'no_show']).optional(), table_id: id.nullish(),
    }).strict(), req.body);
    const cur = await one<any>(req.tenant.pool, `${SELECT} WHERE r.id = $1 AND r.branch_id = $2`, [rid, ctx.branchId]);
    if (!cur) throw notFound();
    if (cur.status === 'seated') throw conflict('This reservation is already seated');
    if (b.table_id && !(await one(req.tenant.pool, 'SELECT 1 FROM dining_tables WHERE id = $1 AND branch_id = $2 AND active', [b.table_id, ctx.branchId]))) throw badRequest('Invalid table');
    const at = b.date || b.time ? await branchLocalTime(req.tenant.pool, ctx.branchId, b.date ?? cur.local_date, b.time ?? cur.local_time) : null;
    if (at) checkSchedule(at);
    await req.tenant.pool.query(
      `UPDATE reservations SET customer_name = coalesce($2, customer_name), customer_phone = coalesce($3, customer_phone), pax = coalesce($4, pax),
          reserved_for = coalesce($5, reserved_for), special_request = CASE WHEN $6::boolean THEN $7 ELSE special_request END,
          status = coalesce($8, status), table_id = CASE WHEN $9::boolean THEN $10 ELSE table_id END, updated_at = now() WHERE id = $1`,
      [rid, b.customer_name ?? null, b.customer_phone ?? null, b.pax ?? null, at, b.special_request !== undefined, b.special_request ?? null,
        b.status ?? null, b.table_id !== undefined, b.table_id ?? null]);
    await audit(req, 'reservation.update', 'reservations', rid, { status: b.status });
    return one(req.tenant.pool, `${SELECT} WHERE r.id = $1`, [rid]);
  });

  // Guests arrived: open a dine-in ticket on the table with the booked number of guests.
  app.post('/reservations/:id/seat', async (req) => {
    const a = requirePerm(req, 'pos.order');
    const { id: rid } = parse(idParam, req.params);
    const b = parse(z.object({ table_id: id.optional() }), req.body);
    const ticketId = await withTicket(req, async (c, ctx, ev) => {
      const r = await one<any>(c, `SELECT * FROM reservations WHERE id = $1 AND branch_id = $2 FOR UPDATE`, [rid, ctx.branchId]);
      if (!r) throw notFound();
      if (r.status !== 'pending' && r.status !== 'confirmed') throw conflict(`Reservation is ${r.status}`);
      const tableId = b.table_id ?? r.table_id;
      if (!tableId) throw badRequest('Choose a table');
      const t = await createTicket(c, ctx, {
        order_type: 'dine_in', source: 'pos', channel_type: 'pos', table_id: tableId, pax: r.pax, waiter_id: a.user.id, created_by: a.user.id,
        customer_name: r.customer_name, customer_phone: r.customer_phone, notes: r.special_request,
      });
      await c.query(`UPDATE reservations SET status = 'seated', table_id = $2, ticket_id = $3, updated_at = now() WHERE id = $1`, [rid, tableId, t.id]);
      ev.branch(ctx.branchId, 'tables:changed', { table_id: tableId });
      return t.id as number;
    });
    return ticketDetail(req.tenant.pool, ticketId);
  });
}
