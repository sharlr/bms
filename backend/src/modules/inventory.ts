import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, tx } from '../lib/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { round2 } from '../lib/money.js';
import { id, idParam, parse, qty, text } from '../lib/validate.js';
import { audit, branchCtx, requirePerm, requireUser } from '../plugins/context.js';
import { Events } from '../realtime.js';
import { applyMovement, recipeFor } from '../services/stock.js';

export function inventoryRoutes(app: FastifyInstance) {
  app.get('/inventory/stock', async (req) => {
    requireUser(req);
    const ctx = await branchCtx(req);
    return many(req.tenant.pool,
      `SELECT i.id AS ingredient_id, i.name, i.unit, i.cost_per_unit, coalesce(s.qty, 0) AS qty, coalesce(s.min_qty, 0) AS min_qty,
              coalesce(s.qty, 0) < coalesce(s.min_qty, 0) AS low, round(coalesce(s.qty,0) * i.cost_per_unit, 2) AS value
         FROM ingredients i LEFT JOIN branch_stock s ON s.ingredient_id = i.id AND s.branch_id = $2
        WHERE i.company_id = $1 AND i.active ORDER BY i.name`, [ctx.companyId, ctx.branchId]);
  });

  app.get('/inventory/low-stock', async (req) => {
    requireUser(req);
    const ctx = await branchCtx(req);
    return many(req.tenant.pool,
      `SELECT i.id AS ingredient_id, i.name, i.unit, s.qty, s.min_qty FROM branch_stock s JOIN ingredients i ON i.id = s.ingredient_id
        WHERE s.branch_id = $1 AND s.min_qty > 0 AND s.qty < s.min_qty AND i.active ORDER BY (s.qty / nullif(s.min_qty,0)), i.name`, [ctx.branchId]);
  });

  app.put('/inventory/stock/:id/min', async (req) => {
    requirePerm(req, 'inventory.manage');
    const ctx = await branchCtx(req);
    const { id: ingId } = parse(idParam, req.params);
    const b = parse(z.object({ min_qty: z.coerce.number().min(0).max(1e9) }), req.body);
    if (!(await one(req.tenant.pool, 'SELECT 1 FROM ingredients WHERE id = $1 AND company_id = $2', [ingId, ctx.companyId]))) throw notFound();
    await req.tenant.pool.query(
      `INSERT INTO branch_stock (branch_id, ingredient_id, min_qty) VALUES ($1,$2,$3)
       ON CONFLICT (branch_id, ingredient_id) DO UPDATE SET min_qty = EXCLUDED.min_qty`, [ctx.branchId, ingId, b.min_qty]);
    return { ok: true };
  });

  app.post('/inventory/stock/adjust', async (req) => {
    const a = requirePerm(req, 'inventory.manage');
    const ctx = await branchCtx(req);
    const b = parse(z.object({
      ingredient_id: id, kind: z.enum(['purchase', 'adjustment', 'opening']),
      qty_change: z.coerce.number().finite().optional(), counted_qty: z.coerce.number().min(0).optional(),
      unit_cost: z.coerce.number().min(0).optional(), note: text(300).optional(),
    }).refine((x) => x.qty_change !== undefined || x.counted_qty !== undefined, 'qty_change or counted_qty required'), req.body);
    const ev = new Events(req.tenant.slug);
    const res = await tx(req.tenant.pool, async (c) => {
      if (!(await one(c, 'SELECT 1 FROM ingredients WHERE id = $1 AND company_id = $2', [b.ingredient_id, ctx.companyId]))) throw badRequest('Invalid ingredient');
      let change = b.qty_change ?? 0;
      if (b.counted_qty !== undefined) {
        const cur = await one<any>(c, 'SELECT qty FROM branch_stock WHERE branch_id = $1 AND ingredient_id = $2 FOR UPDATE', [ctx.branchId, b.ingredient_id]);
        change = b.counted_qty - (cur?.qty ?? 0);
      }
      if (b.kind === 'purchase' && change <= 0) throw badRequest('Purchase quantity must be positive');
      if (b.kind === 'purchase' && b.unit_cost !== undefined) await c.query('UPDATE ingredients SET cost_per_unit = $2 WHERE id = $1', [b.ingredient_id, b.unit_cost]);
      const low = await applyMovement(c, {
        branchId: ctx.branchId, ingredientId: b.ingredient_id, change, kind: b.kind, userId: a.user.id, unitCost: b.unit_cost ?? null, note: b.note ?? null,
      });
      if (low) ev.branch(ctx.branchId, 'stock:low', low);
      return { change };
    });
    ev.flush();
    await audit(req, 'stock.adjust', 'ingredients', b.ingredient_id, { kind: b.kind, change: res.change });
    return { ok: true, ...res };
  });

  // Ticket-referenced ledger; filter by ticket_ref for audits.
  app.get('/inventory/movements', async (req) => {
    requireUser(req);
    const ctx = await branchCtx(req);
    const q = parse(z.object({
      ingredient_id: id.optional(), ticket_ref: text(40).optional(), kind: text(20).optional(),
      from: z.string().date().optional(), to: z.string().date().optional(),
    }), req.query);
    return many(req.tenant.pool,
      `SELECT m.*, i.name AS ingredient_name, i.unit, u.full_name AS user_name FROM stock_movements m
         JOIN ingredients i ON i.id = m.ingredient_id LEFT JOIN users u ON u.id = m.user_id
        WHERE m.branch_id = $1 AND ($2::bigint IS NULL OR m.ingredient_id = $2) AND ($3::text IS NULL OR m.ticket_ref = $3)
          AND ($4::text IS NULL OR m.kind = $4) AND ($5::date IS NULL OR m.created_at >= $5::date)
          AND ($6::date IS NULL OR m.created_at < $6::date + 1)
        ORDER BY m.id DESC LIMIT 1000`,
      [ctx.branchId, q.ingredient_id ?? null, q.ticket_ref ?? null, q.kind ?? null, q.from ?? null, q.to ?? null]);
  });

  // ---------- Recipes ----------
  app.get('/inventory/recipes', async (req) => {
    requireUser(req);
    const ctx = await branchCtx(req);
    const q = parse(z.object({ menu_item_id: id.optional() }), req.query);
    const recipes = await many<any>(req.tenant.pool,
      `SELECT r.*, i.name AS item_name, s.name AS size_name FROM recipes r JOIN menu_items i ON i.id = r.menu_item_id
         LEFT JOIN item_sizes s ON s.id = r.size_id
        WHERE i.company_id = $1 AND ($2::bigint IS NULL OR r.menu_item_id = $2) ORDER BY i.name, s.sort NULLS FIRST`,
      [ctx.companyId, q.menu_item_id ?? null]);
    const lines = await many<any>(req.tenant.pool,
      `SELECT rl.*, g.name AS ingredient_name, g.unit, g.cost_per_unit FROM recipe_lines rl JOIN ingredients g ON g.id = rl.ingredient_id
        WHERE rl.recipe_id = ANY($1) ORDER BY g.name`, [recipes.map((r) => r.id)]);
    return recipes.map((r) => {
      const ls = lines.filter((l) => l.recipe_id === r.id);
      return { ...r, lines: ls, cost: round2(ls.reduce((s, l) => s + l.qty * l.cost_per_unit, 0)) };
    });
  });

  app.put('/inventory/recipes', async (req) => {
    requirePerm(req, 'inventory.manage');
    const ctx = await branchCtx(req);
    const b = parse(z.object({
      menu_item_id: id, size_id: id.nullable(), notes: text(500).nullable().optional(),
      lines: z.array(z.object({ ingredient_id: id, qty })).min(1).max(100),
    }), req.body);
    const out = await tx(req.tenant.pool, async (c) => {
      if (!(await one(c, 'SELECT 1 FROM menu_items WHERE id = $1 AND company_id = $2', [b.menu_item_id, ctx.companyId]))) throw badRequest('Invalid item');
      if (b.size_id && !(await one(c, 'SELECT 1 FROM item_sizes WHERE id = $1 AND item_id = $2', [b.size_id, b.menu_item_id]))) throw badRequest('Invalid size');
      for (const l of b.lines)
        if (!(await one(c, 'SELECT 1 FROM ingredients WHERE id = $1 AND company_id = $2', [l.ingredient_id, ctx.companyId]))) throw badRequest('Invalid ingredient');
      const r = await one<any>(c,
        `INSERT INTO recipes (menu_item_id, size_id, notes) VALUES ($1,$2,$3)
         ON CONFLICT (menu_item_id, coalesce(size_id, 0)) DO UPDATE SET notes = EXCLUDED.notes RETURNING id`,
        [b.menu_item_id, b.size_id, b.notes ?? null]);
      await c.query('DELETE FROM recipe_lines WHERE recipe_id = $1', [r.id]);
      for (const l of b.lines) {
        await c.query(`INSERT INTO recipe_lines (recipe_id, ingredient_id, qty) VALUES ($1,$2,$3)
                       ON CONFLICT (recipe_id, ingredient_id) DO UPDATE SET qty = recipe_lines.qty + EXCLUDED.qty`, [r.id, l.ingredient_id, l.qty]);
      }
      return r;
    });
    await audit(req, 'recipe.save', 'recipes', out.id);
    return { id: out.id };
  });

  app.delete('/inventory/recipes/:id', async (req) => {
    requirePerm(req, 'inventory.manage');
    const ctx = await branchCtx(req);
    const { id: rid } = parse(idParam, req.params);
    const r = await req.tenant.pool.query(
      `DELETE FROM recipes r USING menu_items i WHERE r.id = $1 AND i.id = r.menu_item_id AND i.company_id = $2`, [rid, ctx.companyId]);
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });

  // ---------- Waste ----------
  app.get('/waste', async (req) => {
    requireUser(req);
    const ctx = await branchCtx(req);
    const q = parse(z.object({ from: z.string().date().optional(), to: z.string().date().optional() }), req.query);
    return many(req.tenant.pool,
      `SELECT w.*, g.name AS ingredient_name, g.unit, i.name AS item_name, s.name AS size_name, u.full_name AS user_name
         FROM waste_logs w LEFT JOIN ingredients g ON g.id = w.ingredient_id LEFT JOIN menu_items i ON i.id = w.menu_item_id
         LEFT JOIN item_sizes s ON s.id = w.size_id JOIN users u ON u.id = w.user_id
        WHERE w.branch_id = $1 AND ($2::date IS NULL OR w.created_at >= $2::date) AND ($3::date IS NULL OR w.created_at < $3::date + 1)
        ORDER BY w.id DESC LIMIT 1000`, [ctx.branchId, q.from ?? null, q.to ?? null]);
  });

  app.post('/waste', async (req, reply) => {
    const a = requirePerm(req, 'waste.record');
    const ctx = await branchCtx(req);
    const b = parse(z.object({
      ingredient_id: id.nullish(), menu_item_id: id.nullish(), size_id: id.nullish(), qty,
      reason: z.enum(['spilled', 'damaged', 'spoiled', 'expired', 'overcooked', 'other']), notes: text(300).nullish(),
      deducts_stock: z.boolean().default(true),
    }).refine((x) => !!x.ingredient_id !== !!x.menu_item_id, 'Choose either an ingredient or a menu item'), req.body);
    const ev = new Events(req.tenant.slug);
    const row = await tx(req.tenant.pool, async (c) => {
      let cost = 0;
      let consumption: { ingredient_id: number; qty: number; cost: number }[] = [];
      if (b.ingredient_id) {
        const g = await one<any>(c, 'SELECT cost_per_unit FROM ingredients WHERE id = $1 AND company_id = $2', [b.ingredient_id, ctx.companyId]);
        if (!g) throw badRequest('Invalid ingredient');
        consumption = [{ ingredient_id: b.ingredient_id, qty: b.qty, cost: g.cost_per_unit }];
      } else {
        if (!(await one(c, 'SELECT 1 FROM menu_items WHERE id = $1 AND company_id = $2', [b.menu_item_id, ctx.companyId]))) throw badRequest('Invalid item');
        consumption = (await recipeFor(c, b.menu_item_id!, b.size_id ?? null)).map((r) => ({ ingredient_id: r.ingredient_id, qty: r.qty * b.qty, cost: r.cost_per_unit }));
      }
      cost = round2(consumption.reduce((s, x) => s + x.qty * x.cost, 0));
      const w = await one<any>(c,
        `INSERT INTO waste_logs (company_id, branch_id, ingredient_id, menu_item_id, size_id, qty, reason, cost_amount, deducts_stock, notes, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [ctx.companyId, ctx.branchId, b.ingredient_id ?? null, b.menu_item_id ?? null, b.size_id ?? null, b.qty, b.reason, cost, b.deducts_stock, b.notes ?? null, a.user.id]);
      if (b.deducts_stock) {
        for (const x of consumption) {
          const low = await applyMovement(c, { branchId: ctx.branchId, ingredientId: x.ingredient_id, change: -x.qty, kind: 'waste', userId: a.user.id,
            wasteId: w.id, unitCost: x.cost, note: b.reason });
          if (low) ev.branch(ctx.branchId, 'stock:low', low);
        }
      }
      return w;
    });
    ev.flush();
    reply.code(201);
    return row;
  });
}
