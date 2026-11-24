import { many, one, type Client } from '../lib/db.js';
import { round3 } from '../lib/money.js';

export interface LowStock { ingredient_id: number; name: string; qty: number; min_qty: number; unit: string }

interface Move {
  branchId: number; ingredientId: number; change: number; kind: string; userId: number | null;
  ticketId?: number | null; lineId?: number | null; ticketRef?: string | null; wasteId?: number | null;
  unitCost?: number | null; note?: string | null;
}

/** Apply one ledger movement and update the branch balance. Returns a LowStock entry if it just crossed the minimum. */
export async function applyMovement(c: Client, m: Move): Promise<LowStock | null> {
  const s = await one<any>(c,
    `INSERT INTO branch_stock (branch_id, ingredient_id, qty) VALUES ($1,$2,$3)
     ON CONFLICT (branch_id, ingredient_id) DO UPDATE SET qty = branch_stock.qty + EXCLUDED.qty
     RETURNING qty, min_qty`, [m.branchId, m.ingredientId, round3(m.change)]);
  await c.query(
    `INSERT INTO stock_movements (branch_id, ingredient_id, qty_change, balance_after, kind, ticket_id, ticket_line_id, ticket_ref,
        waste_id, unit_cost, note, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [m.branchId, m.ingredientId, round3(m.change), s.qty, m.kind, m.ticketId ?? null, m.lineId ?? null, m.ticketRef ?? null,
      m.wasteId ?? null, m.unitCost ?? null, m.note ?? null, m.userId]);
  const before = s.qty - m.change;
  if (m.change < 0 && s.min_qty > 0 && s.qty < s.min_qty && before >= s.min_qty) {
    const i = await one<any>(c, 'SELECT name, unit FROM ingredients WHERE id = $1', [m.ingredientId]);
    return { ingredient_id: m.ingredientId, name: i.name, unit: i.unit, qty: s.qty, min_qty: s.min_qty };
  }
  return null;
}

export async function recipeFor(c: Client, itemId: number, sizeId: number | null) {
  const r = await one<{ id: number }>(c,
    `SELECT id FROM recipes WHERE menu_item_id = $1 AND (size_id = $2 OR size_id IS NULL) ORDER BY size_id NULLS LAST LIMIT 1`,
    [itemId, sizeId]);
  if (!r) return [];
  return many<{ ingredient_id: number; qty: number; cost_per_unit: number }>(c,
    `SELECT rl.ingredient_id, rl.qty, i.cost_per_unit FROM recipe_lines rl JOIN ingredients i ON i.id = rl.ingredient_id WHERE rl.recipe_id = $1`,
    [r.id]);
}

/** Deduct recipe ingredients for a confirmed line. Every movement carries the POS ticket reference. */
export async function deductForLine(c: Client, branchId: number, ticket: { id: number; ticket_ref: string }, line: any, userId: number | null) {
  const low: LowStock[] = [];
  for (const rl of await recipeFor(c, line.menu_item_id, line.size_id)) {
    const l = await applyMovement(c, {
      branchId, ingredientId: rl.ingredient_id, change: -(rl.qty * line.qty), kind: 'sale', userId,
      ticketId: ticket.id, lineId: line.id, ticketRef: ticket.ticket_ref, unitCost: rl.cost_per_unit,
    });
    if (l) low.push(l);
  }
  await c.query('UPDATE ticket_lines SET stock_deducted = true WHERE id = $1', [line.id]);
  return low;
}

/** Move a share of a line's consumption to another ticket line (partial split) — net stock unchanged, ledger stays per-ticket. */
export async function transferLineStock(
  c: Client, branchId: number, from: { id: number; ticket_ref: string }, fromLineId: number,
  to: { id: number; ticket_ref: string }, toLineId: number, fraction: number, userId: number | null,
) {
  const rows = await many<{ ingredient_id: number; outstanding: number }>(c,
    `SELECT ingredient_id, -sum(qty_change) AS outstanding FROM stock_movements
      WHERE ticket_line_id = $1 AND kind IN ('sale','sale_reversal','refund_return') GROUP BY ingredient_id`, [fromLineId]);
  for (const r of rows) {
    const q = round3(r.outstanding * fraction);
    if (q <= 0) continue;
    await applyMovement(c, { branchId, ingredientId: r.ingredient_id, change: q, kind: 'sale_reversal', userId,
      ticketId: from.id, lineId: fromLineId, ticketRef: from.ticket_ref, note: `Split to ${to.ticket_ref}` });
    await applyMovement(c, { branchId, ingredientId: r.ingredient_id, change: -q, kind: 'sale', userId,
      ticketId: to.id, lineId: toLineId, ticketRef: to.ticket_ref, note: `Split from ${from.ticket_ref}` });
  }
}

/**
 * Return `fraction` (0..1] of what a line has consumed and not yet returned. Callers pass
 * voidedQty / qtyStillOutstanding, so repeated partial voids/refunds stay exact.
 */
export async function returnForLine(
  c: Client, branchId: number, ticket: { id: number; ticket_ref: string }, lineId: number, fraction: number,
  kind: 'sale_reversal' | 'refund_return', userId: number | null,
) {
  const rows = await many<{ ingredient_id: number; sold: number; returned: number }>(c,
    `SELECT ingredient_id,
            -sum(qty_change) FILTER (WHERE kind = 'sale') AS sold,
            coalesce(sum(qty_change) FILTER (WHERE kind IN ('sale_reversal','refund_return')), 0) AS returned
       FROM stock_movements WHERE ticket_line_id = $1 GROUP BY ingredient_id`, [lineId]);
  for (const r of rows) {
    const outstanding = (r.sold ?? 0) - r.returned;
    const qty = round3(outstanding * Math.min(1, fraction));
    if (qty > 0) {
      await applyMovement(c, {
        branchId, ingredientId: r.ingredient_id, change: qty, kind, userId,
        ticketId: ticket.id, lineId, ticketRef: ticket.ticket_ref,
      });
    }
  }
}
