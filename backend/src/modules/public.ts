import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one, tx } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { id, parse, qty, text } from '../lib/validate.js';
import { deviceBranchCtx, loadBranch, type BranchCtx } from '../plugins/context.js';
import { Events } from '../realtime.js';
import { sendToKitchen } from '../services/kot.js';
import { markOnlinePaid, provider } from '../services/onlinepay.js';
import { addLine, branchLocalTime, checkSchedule, createTicket, isAdvance, recalc } from '../services/tickets.js';
import { branchMenu, orderTypeQ } from './menu.js';

const PUBLIC_READ = { rateLimit: { max: 120, timeWindow: '1 minute' } };
const PUBLIC_WRITE = { rateLimit: { max: 8, timeWindow: '1 minute' } };

const orderLines = z.array(z.object({
  menu_item_id: id, size_id: id.nullish(), qty: qty.refine((v) => v <= 50 && Number.isInteger(v), 'Max 50 per line'),
  modifier_ids: z.array(id).max(20).default([]), notes: text(200).nullish(), allergy_note: text(200).nullish(),
})).min(1).max(50);

async function publicBranch(req: FastifyRequest, branchId: number, requireOnline: boolean): Promise<BranchCtx & { online: boolean }> {
  const b = await one<any>(req.tenant.pool,
    `SELECT b.online_ordering FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.id = $1 AND b.active AND c.active`, [branchId]);
  if (!b) throw notFound('Restaurant not found');
  if (requireOnline && !b.online_ordering) throw badRequest('Online ordering is not available at this restaurant');
  return { ...(await loadBranch(req, branchId)), online: b.online_ordering };
}

async function tableByToken(req: FastifyRequest, token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound('Unknown table');
  const t = await one<any>(req.tenant.pool,
    `SELECT dt.id, dt.name, dt.branch_id, b.name AS branch_name, c.name AS company_name
       FROM dining_tables dt JOIN branches b ON b.id = dt.branch_id JOIN companies c ON c.id = b.company_id
      WHERE dt.qr_token = $1 AND dt.active AND b.active AND c.active`, [token]);
  if (!t) throw notFound('Unknown table');
  return t;
}

export function publicRoutes(app: FastifyInstance) {
  app.get('/public/info', { config: PUBLIC_READ }, async (req) => {
    const branches = await many(req.tenant.pool,
      `SELECT b.id, b.name, b.address, b.phone, b.lat, b.lng, c.name AS company_name, c.base_currency AS currency
         FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.active AND c.active AND b.online_ordering ORDER BY c.name, b.name`);
    return { name: req.tenant.name, branches };
  });

  app.get('/public/table/:token', { config: PUBLIC_READ }, async (req) => {
    const { token } = parse(z.object({ token: z.string().max(64) }), req.params);
    const t = await tableByToken(req, token);
    return { table_id: t.id, table_name: t.name, branch_id: t.branch_id, branch_name: t.branch_name, company_name: t.company_name };
  });

  // Manual table entry (customer can't scan): restaurant + table number -> table token. Orders still need staff acceptance.
  app.post('/public/table-lookup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ branch_id: id, table_name: z.string().min(1).max(20) }).strict(), req.body);
    const t = await one<any>(req.tenant.pool,
      `SELECT dt.qr_token FROM dining_tables dt JOIN branches br ON br.id = dt.branch_id
        WHERE dt.branch_id = $1 AND lower(dt.name) = lower($2) AND dt.active AND br.active`, [b.branch_id, b.table_name.trim()]);
    if (!t) throw notFound('Table not found');
    return { token: t.qr_token };
  });

  app.get('/public/branches', { config: PUBLIC_READ }, async (req) =>
    many(req.tenant.pool,
      `SELECT b.id, b.name, c.name AS company_name FROM branches b JOIN companies c ON c.id = b.company_id
        WHERE b.active AND c.active ORDER BY c.name, b.name`));

  app.get('/public/branches/:id/menu', { config: PUBLIC_READ }, async (req) => {
    const { id: bid } = parse(z.object({ id }), req.params);
    const q = parse(z.object({ table: z.string().max(64).optional() }).extend(orderTypeQ.shape), req.query);
    if (q.table) {
      const t = await tableByToken(req, q.table);
      if (t.branch_id !== bid) throw notFound();
    }
    const ctx = await publicBranch(req, bid, !q.table);
    return { currency: ctx.currency, branch: ctx.branchName, company: ctx.companyName, ...(await branchMenu(req.tenant.pool, ctx, true, q.table ? 'dine_in' : q.order_type)) };
  });

  app.get('/public/branches/:id/delivery-companies', { config: PUBLIC_READ }, async (req) => {
    const { id: bid } = parse(z.object({ id }), req.params);
    const ctx = await publicBranch(req, bid, true);
    return many(req.tenant.pool,
      `SELECT id, name FROM delivery_companies WHERE company_id = $1 AND active AND available_online ORDER BY sort, name`, [ctx.companyId]);
  });

  // Customer order: table QR (dine-in) or online takeaway / delivery with chosen delivery partner.
  app.post('/public/orders', { config: PUBLIC_WRITE }, async (req, reply) => {
    const b = parse(z.object({
      branch_id: id.optional(), table_token: z.string().max(64).optional(),
      order_type: z.enum(['dine_in', 'takeaway', 'delivery']),
      delivery_company_id: id.nullish(), customer_name: text(80).optional(), customer_phone: z.string().regex(/^\+?[0-9 ()-]{6,20}$/).optional(),
      delivery_address: text(300).optional(), notes: text(300).optional(), lines: orderLines,
      pax: z.coerce.number().int().min(1).max(100).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      delivery_lat: z.coerce.number().min(-90).max(90).optional(), delivery_lng: z.coerce.number().min(-180).max(180).optional(),
    }).strict(), req.body);

    let ctx: BranchCtx & { online: boolean };
    let table: any = null;
    if (b.table_token) {
      table = await tableByToken(req, b.table_token);
      ctx = await publicBranch(req, table.branch_id, false);
    } else {
      if (!b.branch_id) throw badRequest('Choose a restaurant');
      ctx = await publicBranch(req, b.branch_id, true);
      if (b.order_type === 'dine_in') throw badRequest('Scan the table QR code to order for dine-in');
      if (!b.customer_name || !b.customer_phone) throw badRequest('Name and phone are required');
      if (b.order_type === 'delivery' && !b.delivery_address) throw badRequest('Delivery address is required');
      if (b.order_type === 'delivery' && (b.delivery_lat === undefined || b.delivery_lng === undefined)) throw badRequest('Pin the delivery location on the map');
    }
    // Delivery / pickup booked for a later date & time (branch local time).
    let scheduledFor: Date | null = null;
    if (!table && b.date && b.time) {
      scheduledFor = await branchLocalTime(req.tenant.pool, ctx.branchId, b.date, b.time);
      checkSchedule(scheduledFor);
    }
    const ev = new Events(req.tenant.slug);
    const out = await tx(req.tenant.pool, async (c) => {
      if (b.delivery_company_id &&
        !(await one(c, 'SELECT 1 FROM delivery_companies WHERE id = $1 AND company_id = $2 AND active AND available_online', [b.delivery_company_id, ctx.companyId])))
        throw badRequest('Delivery partner not available');
      let ticket: any = null;
      if (table) {
        ticket = await one(c, `SELECT * FROM tickets WHERE table_id = $1 AND status IN ('pending','open') ORDER BY id LIMIT 1 FOR UPDATE`, [table.id]);
      }
      if (!ticket) {
        ticket = await createTicket(c, ctx, {
          order_type: table ? 'dine_in' : b.order_type, source: table ? 'qr' : 'online', channel_type: table ? 'qr' : 'online',
          table_id: table?.id ?? null, pax: b.pax ?? 1, customer_name: b.customer_name ?? null, customer_phone: b.customer_phone ?? null,
          delivery_company_id: table ? null : b.delivery_company_id ?? null, delivery_address: b.order_type === 'delivery' ? b.delivery_address ?? null : null,
          notes: b.notes ?? null, status: 'pending', scheduled_for: scheduledFor,
          delivery_lat: b.order_type === 'delivery' ? b.delivery_lat ?? null : null, delivery_lng: b.order_type === 'delivery' ? b.delivery_lng ?? null : null,
        });
      }
      for (const l of b.lines) await addLine(c, ctx, ticket.id, l, null, { onlineOnly: true, fromCustomer: true });
      const t = await recalc(c, ticket.id, ctx);
      // Advance bookings wait for staff to send them to the kitchen nearer the time.
      if (ctx.autoAcceptSelfOrders && !isAdvance(scheduledFor)) await sendToKitchen(c, ctx, ticket.id, null, ev);
      ev.branch(ctx.branchId, 'order:new', { ticket_id: ticket.id, ticket_ref: ticket.ticket_ref, source: ticket.source, table: table?.name ?? null, scheduled_for: scheduledFor });
      ev.branch(ctx.branchId, 'tables:changed', { ticket_id: ticket.id });
      return { order_token: ticket.public_token as string, ticket_ref: ticket.ticket_ref as string, total: t.total, currency: ctx.currency };
    });
    ev.flush();
    reply.code(201);
    return out;
  });

  app.get('/public/orders/:token', { config: PUBLIC_READ }, async (req) => {
    const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }), req.params);
    const t = await one<any>(req.tenant.pool,
      `SELECT t.id, t.ticket_ref, t.status, t.order_type, t.total, t.paid_amount, t.currency, t.opened_at, t.scheduled_for, t.pax, dc.name AS delivery_company, dt.name AS table_name
         FROM tickets t LEFT JOIN delivery_companies dc ON dc.id = t.delivery_company_id LEFT JOIN dining_tables dt ON dt.id = t.table_id
        WHERE t.public_token = $1`, [token]);
    if (!t) throw notFound();
    const lines = await many(req.tenant.pool,
      `SELECT item_name, size_name, qty, line_total, kitchen_status FROM ticket_lines WHERE ticket_id = $1 AND status = 'active' ORDER BY id`, [t.id]);
    delete t.id;
    const balance = Math.max(0, Math.round((t.total - t.paid_amount) * 100) / 100);
    return { ...t, lines, balance_due: balance, can_pay: !!provider && balance > 0 && (t.status === 'pending' || t.status === 'open') };
  });

  // ---------- Customer online payment ----------
  app.post('/public/orders/:token/pay', { config: PUBLIC_WRITE }, async (req) => {
    const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }), req.params);
    if (!provider) throw badRequest('Online payment is not available yet — please pay at the restaurant');
    const t = await one<any>(req.tenant.pool, 'SELECT * FROM tickets WHERE public_token = $1', [token]);
    if (!t) throw notFound();
    if (t.status !== 'pending' && t.status !== 'open') throw badRequest('This order can no longer be paid online');
    const due = Math.round((t.total - t.paid_amount) * 100) / 100;
    if (due <= 0) throw badRequest('This order is already paid');
    const op = await one<any>(req.tenant.pool,
      `INSERT INTO online_payments (ticket_id, provider, amount, currency) VALUES ($1,$2,$3,$4) RETURNING id`, [t.id, provider.name, due, t.currency]);
    const co = await provider.createCheckout({ paymentId: op.id, amount: due, currency: t.currency, description: `Order ${t.ticket_ref}`, tenant: req.tenant.slug, orderToken: token });
    await req.tenant.pool.query('UPDATE online_payments SET provider_ref = $2 WHERE id = $1', [op.id, co.providerRef]);
    return { redirect_url: co.redirectUrl };
  });

  // Sandbox checkout page data + approve/decline. The provider_ref in the URL acts as the secret.
  const sandboxPayment = async (req: FastifyRequest, idv: unknown, ref: unknown) => {
    if (provider?.name !== 'sandbox') throw notFound();
    const p = parse(z.object({ id, ref: z.string().regex(/^sbx_[A-Za-z0-9_-]{16,40}$/) }), { id: idv, ref });
    const op = await one<any>(req.tenant.pool,
      `SELECT op.*, t.ticket_ref, t.public_token, t.branch_id FROM online_payments op JOIN tickets t ON t.id = op.ticket_id
        WHERE op.id = $1 AND op.provider = 'sandbox' AND op.provider_ref = $2`, [p.id, p.ref]);
    if (!op) throw notFound();
    return op;
  };
  app.get('/public/pay/sandbox/:id', { config: PUBLIC_READ }, async (req) => {
    const op = await sandboxPayment(req, (req.params as any).id, (req.query as any).ref);
    return { amount: op.amount, currency: op.currency, ticket_ref: op.ticket_ref, status: op.status, order_token: op.public_token };
  });
  app.post('/public/pay/sandbox/:id', { config: PUBLIC_WRITE }, async (req) => {
    const b = parse(z.object({ ref: z.string(), approve: z.boolean() }), req.body);
    const op = await sandboxPayment(req, (req.params as any).id, b.ref);
    if (op.status !== 'pending') return { status: op.status, order_token: op.public_token };
    if (!b.approve) {
      await req.tenant.pool.query(`UPDATE online_payments SET status = 'failed' WHERE id = $1`, [op.id]);
      return { status: 'failed', order_token: op.public_token };
    }
    const ctx = await loadBranch(req, op.branch_id);
    const ev = new Events(req.tenant.slug);
    await tx(req.tenant.pool, (c) => markOnlinePaid(c, ctx, op.id, ev));
    ev.flush();
    return { status: 'paid', order_token: op.public_token };
  });

  // ---------- Kiosk (registered self-service device; no staff login) ----------
  app.get('/kiosk/menu', async (req) => {
    const ctx = await deviceBranchCtx(req, 'kiosk');
    return { currency: ctx.currency, branch: ctx.branchName, ...(await branchMenu(req.tenant.pool, ctx, false, parse(orderTypeQ, req.query).order_type)) };
  });

  app.post('/kiosk/orders', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ctx = await deviceBranchCtx(req, 'kiosk');
    const b = parse(z.object({ order_type: z.enum(['dine_in', 'takeaway']), customer_name: text(60).optional(), lines: orderLines }).strict(), req.body);
    const ev = new Events(req.tenant.slug);
    const out = await tx(req.tenant.pool, async (c) => {
      const ticket = await createTicket(c, ctx, {
        order_type: b.order_type, source: 'kiosk', channel_type: 'kiosk', customer_name: b.customer_name ?? null, status: 'pending',
      });
      for (const l of b.lines) await addLine(c, ctx, ticket.id, l, null, { fromCustomer: true });
      const t = await recalc(c, ticket.id, ctx);
      if (ctx.autoAcceptSelfOrders) await sendToKitchen(c, ctx, ticket.id, null, ev);
      ev.branch(ctx.branchId, 'order:new', { ticket_id: ticket.id, ticket_ref: ticket.ticket_ref, source: 'kiosk' });
      return { order_token: ticket.public_token, ticket_ref: ticket.ticket_ref, ticket_no: ticket.ticket_no, total: t.total, currency: ctx.currency };
    });
    ev.flush();
    reply.code(201);
    return out;
  });
}

