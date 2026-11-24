import { randomToken } from '../lib/crypto.js';
import { one, type Client } from '../lib/db.js';
import { DEFAULT_ROLES } from '../lib/permissions.js';

export async function seedRoles(c: Client) {
  for (const [name, perms] of Object.entries(DEFAULT_ROLES)) {
    await c.query(
      `INSERT INTO roles (name, permissions, is_system) VALUES ($1, $2, true) ON CONFLICT (name) DO NOTHING`,
      [name, perms],
    );
  }
}

/** Defaults every new company needs: receipt channels, payment methods, expense categories. */
export async function seedCompanyDefaults(c: Client, companyId: number) {
  const channels: [string, string, string][] = [
    ['POS', 'POS Counter', 'pos'], ['WAITER', 'Waiter Orders', 'waiter'], ['TAKEAWAY', 'Takeaway Counter', 'takeaway'],
    ['KIOSK', 'Self-Service Kiosk', 'kiosk'], ['QR', 'Table QR Orders', 'qr'], ['ONLINE', 'Online Orders', 'online'],
    ['DELIVERY', 'Delivery Orders', 'delivery'],
  ];
  for (const [code, name, type] of channels) {
    await c.query(
      `INSERT INTO receipt_channels (company_id, code, name, channel_type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [companyId, code, name, type],
    );
  }
  const methods: [string, string][] = [['Cash', 'cash'], ['Card', 'card'], ['Mobile Money', 'mobile_money'], ['Client Credit', 'credit']];
  let sort = 0;
  for (const [name, type] of methods) {
    await c.query(`INSERT INTO payment_methods (company_id, name, method_type, sort) VALUES ($1,$2,$3,$4)`, [companyId, name, type, sort++]);
  }
  await c.query(`INSERT INTO prep_stations (company_id, name, color, sort) VALUES ($1, 'Kitchen', '#2563eb', 1), ($1, 'Bar', '#0891b2', 2) ON CONFLICT DO NOTHING`, [companyId]);
  let n = 0;
  for (const text of ['Well done', 'Medium', 'Rare', 'No onions', 'No garlic', 'No salt', 'Extra spicy', 'Not spicy', 'Extra cheese', 'Sauce on the side', 'No ice', 'Less sugar']) {
    await c.query('INSERT INTO cooking_notes (company_id, text, sort) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [companyId, text, ++n]);
  }
  for (const name of ['Supplies', 'Transport', 'Utilities', 'Repairs', 'Staff Meals', 'Other']) {
    await c.query(`INSERT INTO expense_categories (company_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [companyId, name]);
  }
}

/** Defaults every new branch needs: a register and a floor with a few tables. */
export async function seedBranchDefaults(c: Client, branchId: number, tableCount = 6) {
  await c.query(`INSERT INTO registers (branch_id, name) VALUES ($1, 'Main Register')`, [branchId]);
  const floor = await one<{ id: number }>(c, `INSERT INTO floors (branch_id, name) VALUES ($1, 'Main Hall') RETURNING id`, [branchId]);
  for (let i = 1; i <= tableCount; i++) {
    const col = (i - 1) % 4;
    const row = Math.floor((i - 1) / 4);
    await c.query(
      `INSERT INTO dining_tables (branch_id, floor_id, name, seats, pos_x, pos_y, qr_token) VALUES ($1,$2,$3,4,$4,$5,$6)`,
      [branchId, floor!.id, `T${i}`, 30 + col * 130, 30 + row * 130, randomToken(18)],
    );
  }
}
