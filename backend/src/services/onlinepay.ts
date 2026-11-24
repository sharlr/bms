import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { one, type Client } from '../lib/db.js';
import { round2 } from '../lib/money.js';
import type { BranchCtx } from '../plugins/context.js';
import type { Events } from '../realtime.js';
import { sendToKitchen } from './kot.js';
import { isAdvance } from './tickets.js';

export interface CheckoutInput { paymentId: number; amount: number; currency: string; description: string; tenant: string; orderToken: string }
export interface Provider { name: string; createCheckout(p: CheckoutInput): Promise<{ providerRef: string; redirectUrl: string }> }

/** Test provider: our own page lets you approve or decline. No money moves. */
const sandbox: Provider = {
  name: 'sandbox',
  async createCheckout(p) {
    const ref = `sbx_${randomToken(16)}`;
    return { providerRef: ref, redirectUrl: `${config.PUBLIC_ORIGIN}/${p.tenant}/pay/sandbox/${p.paymentId}?ref=${ref}` };
  },
};

// shortcut: one platform-wide provider; move to per-tenant merchant credentials when the CACPay adapter is added.
export const provider: Provider | null = config.PAYMENT_PROVIDER === 'sandbox' ? sandbox : null;

/**
 * Confirm a successful online payment (idempotent): records a payment on the ticket and, since the order is
 * now paid, accepts it and sends it to the kitchen. The cashier closes the ticket at handover (attaching it to the register).
 */
export async function markOnlinePaid(c: Client, ctx: BranchCtx, paymentId: number, ev: Events) {
  const op = await one<any>(c, `SELECT * FROM online_payments WHERE id = $1 FOR UPDATE`, [paymentId]);
  if (!op || op.status === 'paid') return op;
  const t = await one<any>(c, `SELECT * FROM tickets WHERE id = $1 AND branch_id = $2 FOR UPDATE`, [op.ticket_id, ctx.branchId]);
  if (!t) return op;
  await c.query(`UPDATE online_payments SET status = 'paid', paid_at = now() WHERE id = $1`, [paymentId]);
  let m = await one<any>(c, `SELECT * FROM payment_methods WHERE company_id = $1 AND name = 'Online payment' ORDER BY id LIMIT 1`, [ctx.companyId]);
  if (!m) m = await one<any>(c, `INSERT INTO payment_methods (company_id, name, method_type, sort) VALUES ($1, 'Online payment', 'other', 90) RETURNING *`, [ctx.companyId]);
  await c.query(
    `INSERT INTO payments (ticket_id, company_id, branch_id, payment_method_id, method_type, currency_code, amount, rate, base_amount, kind, reference, value_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,$7,'payment',$8,$9)`,
    [t.id, ctx.companyId, ctx.branchId, m.id, m.method_type, op.currency, op.amount, `${op.provider}:${op.provider_ref}`, t.scheduled_for]);
  await c.query(`UPDATE tickets SET paid_amount = $2, updated_at = now() WHERE id = $1`, [t.id, round2(t.paid_amount + op.amount)]);
  if (isAdvance(t.scheduled_for)) await c.query(`UPDATE tickets SET status = 'open' WHERE id = $1 AND status = 'pending'`, [t.id]);
  else if (t.status === 'pending' || t.status === 'open') await sendToKitchen(c, ctx, t.id, null, ev);
  ev.branch(ctx.branchId, 'order:paid', { ticket_id: t.id, ticket_ref: t.ticket_ref, amount: op.amount });
  return { ...op, status: 'paid' };
}
