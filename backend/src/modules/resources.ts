import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomToken } from '../lib/crypto.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { ALL_PERMISSIONS } from '../lib/permissions.js';
import { color, id, money, reqText, text } from '../lib/validate.js';
import { registerCrud } from './crud.js';

const active = z.boolean();
const sort = z.coerce.number().int().min(0).max(10000);
const coord = z.coerce.number().int().min(-50).max(5000);
const planItem = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  kind: z.enum(['wall', 'room', 'bar', 'kitchen', 'door', 'window', 'plant', 'restroom', 'stage', 'text']),
  x: coord, y: coord, w: z.coerce.number().int().min(4).max(5000), h: z.coerce.number().int().min(4).max(5000),
  label: text(40).optional(), color: color.optional(),
});

export function resourceRoutes(app: FastifyInstance) {
  registerCrud(app, {
    path: '/registers', table: 'registers', scope: 'branch', readPerm: null, writePerm: 'org.manage',
    schema: z.object({ name: reqText(60), active }).partial({ active: true }),
  });

  registerCrud(app, {
    path: '/printers', table: 'printers', scope: 'branch', readPerm: null, writePerm: 'org.manage',
    schema: z.object({
      name: reqText(60), kind: z.enum(['kot', 'receipt']), station_id: id.nullable(),
      connection: z.string().regex(/^(tcp:\/\/[a-zA-Z0-9.-]{1,253}:\d{1,5}|browser|)$/, 'Use tcp://host:port or browser'),
      chars_per_line: z.coerce.number().int().min(24).max(80), active,
    }).partial({ active: true, chars_per_line: true, connection: true, station_id: true }),
    refs: { station_id: { table: 'prep_stations', scope: 'company' } },
    beforeWrite: (_req, d) => { if (d.kind === 'kot' && !d.station_id) throw badRequest('Choose the kitchen / bar this printer serves'); if (d.kind === 'receipt') d.station_id = null; },
  });

  registerCrud(app, {
    path: '/receipt-channels', table: 'receipt_channels', scope: 'company', readPerm: null, writePerm: 'org.manage',
    refs: { branch_id: { table: 'branches', scope: 'company' } },
    schema: z.object({
      code: z.string().regex(/^[A-Z0-9_]{2,20}$/), name: reqText(80), branch_id: id.nullable(),
      channel_type: z.enum(['pos', 'waiter', 'takeaway', 'kiosk', 'qr', 'online', 'delivery']), active,
    }).partial({ active: true, branch_id: true }),
  });

  registerCrud(app, {
    path: '/payment-methods', table: 'payment_methods', scope: 'company', readPerm: null, writePerm: 'org.manage',
    orderBy: 'sort, id',
    schema: z.object({
      name: reqText(60), method_type: z.enum(['cash', 'card', 'credit', 'mobile_money', 'voucher', 'other']), sort, active,
    }).partial({ sort: true, active: true }),
  });

  registerCrud(app, {
    path: '/clients', table: 'clients', scope: 'company', readPerm: null, writePerm: 'clients.manage', orderBy: 'name',
    filters: ['credit_allowed', 'active'],
    schema: z.object({
      name: reqText(120), phone: text(40).nullable(), email: z.string().email().max(120).nullable().or(z.literal('')),
      address: text(300).nullable(), tax_id: text(60).nullable(), credit_allowed: z.boolean(), credit_limit: money,
      notes: text(500).nullable(), active,
    }).partial({ phone: true, email: true, address: true, tax_id: true, credit_allowed: true, credit_limit: true, notes: true, active: true }),
  });

  registerCrud(app, {
    path: '/coupons', table: 'coupons', scope: 'company', readPerm: 'clients.manage', writePerm: 'clients.manage',
    schema: z.object({
      code: z.string().regex(/^[A-Za-z0-9_-]{3,30}$/).transform((s) => s.toUpperCase()),
      discount_type: z.enum(['percent', 'fixed']), value: money, min_order: money, valid_from: z.coerce.date().nullable(),
      valid_to: z.coerce.date().nullable(), max_uses: z.coerce.number().int().positive().nullable(), active,
    }).partial({ min_order: true, valid_from: true, valid_to: true, max_uses: true, active: true }),
  });

  registerCrud(app, {
    path: '/menu/categories', table: 'menu_categories', scope: 'company', readPerm: null, writePerm: 'menu.manage',
    orderBy: 'sort, name', refs: { parent_id: { table: 'menu_categories', scope: 'company' }, station_id: { table: 'prep_stations', scope: 'company' } },
    schema: z.object({
      name: reqText(80), parent_id: id.nullable(), color, station_id: id.nullable(), sort, active,
    }).partial({ parent_id: true, color: true, station_id: true, sort: true, active: true }),
  });

  registerCrud(app, {
    path: '/menu/sizes', table: 'item_sizes', scope: 'parent', parent: { column: 'item_id', table: 'menu_items' },
    readPerm: null, writePerm: 'menu.manage', orderBy: 'sort, id', filters: ['item_id'],
    schema: z.object({ item_id: id, name: reqText(40), sort, active }).partial({ sort: true, active: true }),
  });

  registerCrud(app, {
    path: '/menu/modifier-groups', table: 'modifier_groups', scope: 'company', readPerm: null, writePerm: 'menu.manage',
    schema: z.object({
      name: reqText(80), min_select: z.coerce.number().int().min(0).max(20), max_select: z.coerce.number().int().min(1).max(50), active,
    }).partial({ min_select: true, max_select: true, active: true }),
  });

  registerCrud(app, {
    path: '/menu/modifiers', table: 'modifiers', scope: 'parent', parent: { column: 'group_id', table: 'modifier_groups' },
    readPerm: null, writePerm: 'menu.manage', orderBy: 'sort, id', filters: ['group_id'],
    schema: z.object({ group_id: id, name: reqText(80), price_delta: z.coerce.number().min(-100000).max(100000), sort, active })
      .partial({ price_delta: true, sort: true, active: true }),
  });

  registerCrud(app, {
    path: '/menu/cooking-notes', table: 'cooking_notes', scope: 'company', readPerm: null, writePerm: 'menu.manage',
    orderBy: 'sort, text', filters: ['active'],
    schema: z.object({ text: reqText(60), sort, active }).partial({ sort: true, active: true }),
  });

  // Preparation stations: as many kitchens / bars as the company needs.
  registerCrud(app, {
    path: '/prep-stations', table: 'prep_stations', scope: 'company', readPerm: null, writePerm: 'menu.manage',
    orderBy: 'sort, name', filters: ['active'],
    schema: z.object({ name: reqText(40), color, sort, active }).partial({ color: true, sort: true, active: true }),
  });

  registerCrud(app, {
    path: '/expense-categories', table: 'expense_categories', scope: 'company', readPerm: null, writePerm: 'org.manage',
    orderBy: 'name', schema: z.object({ name: reqText(60), active }).partial({ active: true }),
  });

  registerCrud(app, {
    path: '/inventory/ingredients', table: 'ingredients', scope: 'company', readPerm: null, writePerm: 'inventory.manage',
    orderBy: 'name',
    schema: z.object({ name: reqText(100), unit: reqText(20), cost_per_unit: z.coerce.number().min(0).max(1e7), active })
      .partial({ cost_per_unit: true, active: true }),
  });

  registerCrud(app, {
    path: '/delivery/companies', table: 'delivery_companies', scope: 'company', readPerm: null, writePerm: 'delivery.manage',
    orderBy: 'sort, name',
    schema: z.object({
      name: reqText(80), phone: text(40).nullable(), email: z.string().email().max(120).nullable().or(z.literal('')),
      available_online: z.boolean(), sort, active,
    }).partial({ phone: true, email: true, available_online: true, sort: true, active: true }),
  });

  registerCrud(app, {
    path: '/delivery/zones', table: 'delivery_zones', scope: 'company', readPerm: null, writePerm: 'delivery.manage',
    orderBy: 'name', schema: z.object({ name: reqText(80), active }).partial({ active: true }),
  });

  registerCrud(app, {
    path: '/delivery/rules', table: 'delivery_commission_rules', scope: 'parent',
    parent: { column: 'delivery_company_id', table: 'delivery_companies' },
    readPerm: 'delivery.manage', writePerm: 'delivery.manage', orderBy: 'delivery_company_id, priority DESC, id',
    filters: ['delivery_company_id'],
    refs: {
      branch_id: { table: 'branches', scope: 'company' }, zone_id: { table: 'delivery_zones', scope: 'company' },
      client_id: { table: 'clients', scope: 'company' }, menu_item_id: { table: 'menu_items', scope: 'company' },
    },
    schema: z.object({
      delivery_company_id: id, branch_id: id.nullable(), basis: z.enum(['delivery', 'item', 'zone', 'client']),
      commission_type: z.enum(['fixed', 'percent']), value: z.coerce.number().min(0).max(1e7),
      zone_id: id.nullable(), client_id: id.nullable(), menu_item_id: id.nullable(),
      priority: z.coerce.number().int().min(-100).max(100), active,
    }).partial({ branch_id: true, zone_id: true, client_id: true, menu_item_id: true, priority: true, active: true }),
  });

  registerCrud(app, {
    path: '/floors', table: 'floors', scope: 'branch', readPerm: null, writePerm: 'floor.manage', orderBy: 'sort, id',
    schema: z.object({
      name: reqText(60), sort, active,
      width: z.coerce.number().int().min(400).max(5000), height: z.coerce.number().int().min(300).max(5000),
      // Drawing elements; stored as jsonb (stringified here because pg would send a JS array as a Postgres array).
      layout: z.array(planItem).max(500).transform((v) => JSON.stringify(v)),
    }).partial({ sort: true, active: true, width: true, height: true, layout: true }),
  });

  registerCrud(app, {
    path: '/tables', table: 'dining_tables', scope: 'branch', readPerm: null, writePerm: 'floor.manage', orderBy: 'floor_id, name',
    filters: ['floor_id'], refs: { floor_id: { table: 'floors', scope: 'branch' } },
    schema: z.object({
      floor_id: id, name: reqText(20), seats: z.coerce.number().int().min(1).max(100), shape: z.enum(['square', 'round', 'rect']),
      pos_x: z.coerce.number().int().min(0).max(5000), pos_y: z.coerce.number().int().min(0).max(5000),
      width: z.coerce.number().int().min(30).max(600), height: z.coerce.number().int().min(30).max(600), active,
    }).partial({ seats: true, shape: true, pos_x: true, pos_y: true, width: true, height: true, active: true }),
    beforeWrite: (_req, data, isCreate) => { if (isCreate) data.qr_token = randomToken(18); },
  });

  registerCrud(app, {
    path: '/roles', table: 'roles', scope: 'tenant', readPerm: 'users.manage', writePerm: 'users.manage', orderBy: 'name',
    remove: 'none',
    // Roles are tenant-wide: only tenant administrators may create or change them (prevents self-escalation).
    beforeWrite: (req) => { if (!req.auth?.user.is_tenant_admin) throw forbidden('Only tenant administrators can edit roles'); },
    schema: z.object({
      name: reqText(60),
      permissions: z.array(z.enum(['*', ...ALL_PERMISSIONS] as [string, ...string[]])).max(100),
    }),
  });
}
