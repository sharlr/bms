import { many, one, type Client } from '../lib/db.js';
import { round2 } from '../lib/money.js';

interface Rule {
  id: number; basis: 'delivery' | 'item' | 'zone' | 'client'; commission_type: 'fixed' | 'percent'; value: number;
  zone_id: number | null; client_id: number | null; menu_item_id: number | null; branch_id: number | null; priority: number;
}

/**
 * Commission engine. Order-level rule = most specific match: client rule > zone rule > per-delivery rule.
 * Item rules are added on top (item-specific rule beats the "all items" rule for that line).
 * Percent rules apply to the ticket total (order-level) or the line total (item-level).
 */
export async function computeCommission(c: Client, ticketId: number) {
  await c.query('DELETE FROM delivery_commissions WHERE ticket_id = $1', [ticketId]);
  const t = await one<any>(c, 'SELECT * FROM tickets WHERE id = $1', [ticketId]);
  if (!t?.delivery_company_id || t.status === 'cancelled') return [];
  const rules = await many<Rule>(c,
    `SELECT * FROM delivery_commission_rules WHERE delivery_company_id = $1 AND active AND (branch_id = $2 OR branch_id IS NULL)
      ORDER BY priority DESC, branch_id NULLS LAST, id`, [t.delivery_company_id, t.branch_id]);
  const rows: any[] = [];
  const base = round2(t.total - t.refunded_amount);

  const orderRule = rules.find((r) => r.basis === 'client' && r.client_id === t.client_id && t.client_id)
    ?? rules.find((r) => r.basis === 'zone' && r.zone_id === t.delivery_zone_id && t.delivery_zone_id)
    ?? rules.find((r) => r.basis === 'delivery');
  if (orderRule) {
    const amount = orderRule.commission_type === 'percent' ? round2((base * orderRule.value) / 100) : round2(orderRule.value);
    rows.push({ rule: orderRule, base, amount, note: null });
  }

  const itemRules = rules.filter((r) => r.basis === 'item');
  if (itemRules.length) {
    const lines = await many<any>(c,
      `SELECT menu_item_id, item_name, (qty - refunded_qty) AS qty, line_total * (qty - refunded_qty) / qty AS net
         FROM ticket_lines WHERE ticket_id = $1 AND status = 'active' AND qty > refunded_qty`, [ticketId]);
    for (const l of lines) {
      const r = itemRules.find((x) => x.menu_item_id === l.menu_item_id) ?? itemRules.find((x) => x.menu_item_id === null);
      if (!r) continue;
      const amount = r.commission_type === 'percent' ? round2((l.net * r.value) / 100) : round2(r.value * l.qty);
      rows.push({ rule: r, base: round2(l.net), amount, note: `${l.qty} x ${l.item_name}` });
    }
  }

  for (const r of rows) {
    await c.query(
      `INSERT INTO delivery_commissions (ticket_id, branch_id, delivery_company_id, rule_id, basis, commission_type, rule_value,
          base_amount, amount, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [t.id, t.branch_id, t.delivery_company_id, r.rule.id, r.rule.basis, r.rule.commission_type, r.rule.value,
        r.base, r.amount, r.note]);
  }
  return rows;
}
