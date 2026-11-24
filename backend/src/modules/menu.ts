import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, tx, type Queryable } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { id, idParam, money, parse, reqText, text } from '../lib/validate.js';
import { audit, branchCtx, companyCtx, requirePerm, requireUser, type BranchCtx } from '../plugins/context.js';

export const orderTypeQ = z.object({ order_type: z.enum(['dine_in', 'takeaway', 'delivery']).default('dine_in') });
const priceRow = z.object({ size_id: id.nullable(), branch_id: id.nullable(), order_type: z.enum(['dine_in', 'takeaway', 'delivery']).nullable().default(null), price: money });
const itemSchema = z.object({
  category_id: id, name: reqText(120), description: text(1000).nullable(), sku: text(60).nullable(),
  image_url: z.string().max(500).regex(/^(https:\/\/[^\s"'<>]+|\/[^\s"'<>]*)$/, 'Image must be an https:// URL').nullable().or(z.literal('')),
  station_id: id.nullable(), no_kot: z.boolean(), tracks_stock: z.boolean(),
  allergens: z.array(text(40)).max(20), available_online: z.boolean(), sort: z.coerce.number().int().min(0).max(10000),
  active: z.boolean(),
});
const ITEM_COLS = Object.keys(itemSchema.shape);

const MAX_IMAGE = 1024 * 1024; // browser resizes before upload; also the edge proxy body limit
// The declared type must match the file's real signature (blocks HTML/SVG/script disguised as an image).
const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

/** Full menu for one branch with prices resolved for the order type (same precedence as resolveItem). Shared by POS, kiosk and online menu. */
export async function branchMenu(c: Queryable, ctx: BranchCtx, onlineOnly = false, orderType = 'dine_in') {
  const categories = await many(c,
    `SELECT id, parent_id, name, color, sort FROM menu_categories WHERE company_id = $1 AND active ORDER BY sort, name`, [ctx.companyId]);
  const items = await many<any>(c,
    `SELECT i.id, i.category_id, i.name, i.description, i.image_url, i.allergens, i.tracks_stock, i.sort,
            CASE WHEN i.no_kot THEN NULL ELSE coalesce(i.station_id, cat.station_id) END AS station_id
       FROM menu_items i JOIN menu_categories cat ON cat.id = i.category_id
      WHERE i.company_id = $1 AND i.active AND cat.active ${onlineOnly ? 'AND i.available_online' : ''}
      ORDER BY i.sort, i.name`, [ctx.companyId]);
  const ids = items.map((i) => i.id);
  const sizes = await many<any>(c, 'SELECT id, item_id, name, sort FROM item_sizes WHERE item_id = ANY($1) AND active ORDER BY sort, id', [ids]);
  const prices = await many<any>(c,
    `SELECT DISTINCT ON (item_id, coalesce(size_id, 0)) item_id, size_id, price FROM item_prices
      WHERE item_id = ANY($1) AND (branch_id = $2 OR branch_id IS NULL) AND (order_type = $3 OR order_type IS NULL)
      ORDER BY item_id, coalesce(size_id, 0), branch_id NULLS LAST, order_type NULLS LAST`, [ids, ctx.branchId, orderType]);
  const links = await many<any>(c, 'SELECT item_id, group_id FROM item_modifier_groups WHERE item_id = ANY($1)', [ids]);
  const groups = await many<any>(c,
    `SELECT id, name, min_select, max_select FROM modifier_groups WHERE company_id = $1 AND active ORDER BY name`, [ctx.companyId]);
  const mods = await many<any>(c,
    `SELECT m.id, m.group_id, m.name, m.price_delta FROM modifiers m JOIN modifier_groups g ON g.id = m.group_id
      WHERE g.company_id = $1 AND m.active ORDER BY m.sort, m.id`, [ctx.companyId]);
  const priceOf = (itemId: number, sizeId: number | null) => prices.find((p) => p.item_id === itemId && p.size_id === sizeId)?.price ?? null;
  const out = items.map((i) => {
    const s = sizes.filter((x) => x.item_id === i.id).map((x) => ({ id: x.id, name: x.name, price: priceOf(i.id, x.id) }))
      .filter((x) => x.price !== null);
    return {
      ...i, sizes: s, price: s.length ? null : priceOf(i.id, null),
      modifier_group_ids: links.filter((l) => l.item_id === i.id).map((l) => l.group_id),
    };
  }).filter((i) => i.sizes.length || i.price !== null); // hide items without a price at this branch
  return {
    categories, items: out,
    modifier_groups: groups.map((g) => ({ ...g, modifiers: mods.filter((m) => m.group_id === g.id) })),
  };
}

async function checkItemRefs(c: Queryable, companyId: number, itemId: number | null, body: any) {
  if (body.category_id && !(await one(c, 'SELECT 1 FROM menu_categories WHERE id = $1 AND company_id = $2', [body.category_id, companyId])))
    throw badRequest('Invalid category');
  if (body.station_id && !(await one(c, 'SELECT 1 FROM prep_stations WHERE id = $1 AND company_id = $2', [body.station_id, companyId])))
    throw badRequest('Invalid kitchen / bar');
  for (const g of body.modifier_group_ids ?? [])
    if (!(await one(c, 'SELECT 1 FROM modifier_groups WHERE id = $1 AND company_id = $2', [g, companyId]))) throw badRequest('Invalid modifier group');
  for (const p of body.prices ?? []) {
    if (p.branch_id && !(await one(c, 'SELECT 1 FROM branches WHERE id = $1 AND company_id = $2', [p.branch_id, companyId]))) throw badRequest('Invalid branch in prices');
    if (p.size_id && (!itemId || !(await one(c, 'SELECT 1 FROM item_sizes WHERE id = $1 AND item_id = $2', [p.size_id, itemId])))) throw badRequest('Invalid size in prices');
  }
}

export function menuRoutes(app: FastifyInstance) {
  app.get('/menu/palette', async (req) => {
    requirePerm(req, 'pos.access');
    return branchMenu(req.tenant.pool, await branchCtx(req), false, parse(orderTypeQ, req.query).order_type);
  });

  app.get('/menu/items', async (req) => {
    requireUser(req);
    const companyId = await companyCtx(req);
    const items = await many<any>(req.tenant.pool, 'SELECT * FROM menu_items WHERE company_id = $1 ORDER BY sort, name', [companyId]);
    const ids = items.map((i) => i.id);
    const sizes = await many<any>(req.tenant.pool, 'SELECT * FROM item_sizes WHERE item_id = ANY($1) ORDER BY sort, id', [ids]);
    const prices = await many<any>(req.tenant.pool, 'SELECT * FROM item_prices WHERE item_id = ANY($1)', [ids]);
    const links = await many<any>(req.tenant.pool, 'SELECT * FROM item_modifier_groups WHERE item_id = ANY($1)', [ids]);
    return items.map((i) => ({
      ...i,
      sizes: sizes.filter((s) => s.item_id === i.id),
      prices: prices.filter((p) => p.item_id === i.id),
      modifier_group_ids: links.filter((l) => l.item_id === i.id).map((l) => l.group_id),
    }));
  });

  const extra = z.object({
    sizes: z.array(reqText(40)).max(10).optional(),
    // On create, sizes don't have ids yet: prices reference them by name.
    prices: z.array(priceRow.omit({ size_id: true }).extend({ size_name: text(40).optional() })).max(500).optional(),
    modifier_group_ids: z.array(id).max(30).optional(),
  });

  app.post('/menu/items', async (req, reply) => {
    requirePerm(req, 'menu.manage');
    const companyId = await companyCtx(req);
    const b = parse(itemSchema.partial({
      description: true, sku: true, image_url: true, station_id: true, no_kot: true, tracks_stock: true, allergens: true, available_online: true, sort: true, active: true,
    }).merge(extra).strict(), req.body);
    const row = await tx(req.tenant.pool, async (c) => {
      await checkItemRefs(c, companyId, null, { ...b, prices: (b.prices ?? []).map((p) => ({ ...p, size_id: null })) });
      const cols = ITEM_COLS.filter((k) => (b as any)[k] !== undefined);
      const item = await one<any>(c,
        `INSERT INTO menu_items (company_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
        [companyId, ...cols.map((k) => ((b as any)[k] === '' ? null : (b as any)[k]))]);
      const sizeIds = new Map<string, number>();
      let s = 0;
      for (const name of b.sizes ?? []) {
        const r = await one<any>(c, 'INSERT INTO item_sizes (item_id, name, sort) VALUES ($1,$2,$3) RETURNING id', [item.id, name, s++]);
        sizeIds.set(name, r.id);
      }
      for (const p of b.prices ?? []) {
        const sizeId = p.size_name ? sizeIds.get(p.size_name) ?? null : null;
        if (p.size_name && !sizeId) throw badRequest(`Unknown size ${p.size_name}`);
        await c.query('INSERT INTO item_prices (item_id, size_id, branch_id, order_type, price) VALUES ($1,$2,$3,$4,$5)', [item.id, sizeId, p.branch_id, p.order_type, p.price]);
      }
      for (const g of b.modifier_group_ids ?? []) await c.query('INSERT INTO item_modifier_groups (item_id, group_id) VALUES ($1,$2)', [item.id, g]);
      return item;
    });
    await audit(req, 'create', 'menu_items', row.id);
    reply.code(201);
    return row;
  });

  app.patch('/menu/items/:id', async (req) => {
    requirePerm(req, 'menu.manage');
    const companyId = await companyCtx(req);
    const { id: itemId } = parse(idParam, req.params);
    const b = parse(itemSchema.partial().strict(), req.body);
    await checkItemRefs(req.tenant.pool, companyId, itemId, b);
    const cols = Object.keys(b);
    if (!cols.length) throw badRequest('Nothing to update');
    const row = await one(req.tenant.pool,
      `UPDATE menu_items SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND company_id = $2 RETURNING *`,
      [itemId, companyId, ...cols.map((k) => ((b as any)[k] === '' ? null : (b as any)[k]))]);
    if (!row) throw notFound();
    await audit(req, 'update', 'menu_items', itemId, { fields: cols });
    return row;
  });

  // ---------- Item photos (stored in the tenant DB, served by the app) ----------
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: MAX_IMAGE }, (_req, body, done) => done(null, body));

  app.put('/menu/items/:id/image', { bodyLimit: MAX_IMAGE }, async (req) => {
    requirePerm(req, 'menu.manage');
    const companyId = await companyCtx(req);
    const { id: itemId } = parse(idParam, req.params);
    const mime = String(req.headers['content-type'] ?? '').split(';')[0];
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || !IMAGE_MAGIC[mime]?.(data)) throw badRequest('Upload a JPEG, PNG or WebP image');
    if (!(await one(req.tenant.pool, 'SELECT 1 FROM menu_items WHERE id = $1 AND company_id = $2', [itemId, companyId]))) throw notFound();
    const url = `/api/t/${req.tenant.slug}/public/menu-images/${itemId}?v=${Date.now()}`; // ?v= busts browser caches on change
    await tx(req.tenant.pool, async (c) => {
      await c.query(
        `INSERT INTO item_images (item_id, mime, data) VALUES ($1,$2,$3)
         ON CONFLICT (item_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`, [itemId, mime, data]);
      await c.query('UPDATE menu_items SET image_url = $2 WHERE id = $1', [itemId, url]);
    });
    await audit(req, 'image.upload', 'menu_items', itemId, { bytes: data.length });
    return { image_url: url };
  });

  app.delete('/menu/items/:id/image', async (req) => {
    requirePerm(req, 'menu.manage');
    const companyId = await companyCtx(req);
    const { id: itemId } = parse(idParam, req.params);
    const r = await req.tenant.pool.query('UPDATE menu_items SET image_url = NULL WHERE id = $1 AND company_id = $2', [itemId, companyId]);
    if (!r.rowCount) throw notFound();
    await req.tenant.pool.query('DELETE FROM item_images WHERE item_id = $1', [itemId]);
    return { ok: true };
  });

  // Public: menus (QR / online / kiosk) are public, so are their photos.
  app.get('/public/menu-images/:id', async (req, reply) => {
    const { id: itemId } = parse(idParam, req.params);
    const img = await one<{ mime: string; data: Buffer }>(req.tenant.pool, 'SELECT mime, data FROM item_images WHERE item_id = $1', [itemId]);
    if (!img) throw notFound();
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.type(img.mime).send(img.data);
  });

  app.delete('/menu/items/:id', async (req) => {
    requirePerm(req, 'menu.manage');
    const companyId = await companyCtx(req);
    const { id: itemId } = parse(idParam, req.params);
    const r = await req.tenant.pool.query('UPDATE menu_items SET active = false WHERE id = $1 AND company_id = $2', [itemId, companyId]);
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });

  // Replace the whole price matrix (size x branch) of an item.
  app.put('/menu/items/:id/prices', async (req) => {
    requirePerm(req, 'menu.manage');
    const companyId = await companyCtx(req);
    const { id: itemId } = parse(idParam, req.params);
    const prices = parse(z.array(priceRow).max(500), req.body);
    if (!(await one(req.tenant.pool, 'SELECT 1 FROM menu_items WHERE id = $1 AND company_id = $2', [itemId, companyId]))) throw notFound();
    await tx(req.tenant.pool, async (c) => {
      await checkItemRefs(c, companyId, itemId, { prices });
      await c.query('DELETE FROM item_prices WHERE item_id = $1', [itemId]);
      for (const p of prices) await c.query('INSERT INTO item_prices (item_id, size_id, branch_id, order_type, price) VALUES ($1,$2,$3,$4,$5)', [itemId, p.size_id, p.branch_id, p.order_type, p.price]);
    });
    await audit(req, 'prices.update', 'menu_items', itemId, { count: prices.length });
    return { ok: true };
  });

  app.put('/menu/items/:id/modifier-groups', async (req) => {
    requirePerm(req, 'menu.manage');
    const companyId = await companyCtx(req);
    const { id: itemId } = parse(idParam, req.params);
    const groups = parse(z.array(id).max(30), req.body);
    if (!(await one(req.tenant.pool, 'SELECT 1 FROM menu_items WHERE id = $1 AND company_id = $2', [itemId, companyId]))) throw notFound();
    await tx(req.tenant.pool, async (c) => {
      await checkItemRefs(c, companyId, itemId, { modifier_group_ids: groups });
      await c.query('DELETE FROM item_modifier_groups WHERE item_id = $1', [itemId]);
      for (const g of groups) await c.query('INSERT INTO item_modifier_groups (item_id, group_id) VALUES ($1,$2)', [itemId, g]);
    });
    return { ok: true };
  });
}
