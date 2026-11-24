export const PERMISSIONS = {
  'pos.access': 'Use the POS terminal',
  'pos.order': 'Create orders and add items',
  'pos.payment': 'Take payments and close tickets',
  'pos.credit_sale': 'Sell on credit to clients',
  'pos.discount': 'Apply discounts',
  'pos.void_line': 'Void sent order lines',
  'pos.cancel_ticket': 'Cancel whole tickets',
  'pos.clear_table': 'Cancel orders and clear a table',
  'pos.refund': 'Issue refunds',
  'pos.split': 'Split checks',
  'pos.accept_online': 'Accept QR / online / kiosk orders',
  'pos.register': 'Open / close the register',
  'kds.view': 'Use the kitchen display',
  'expenses.record': 'Record counter expenses',
  'expenses.void': 'Void counter expenses',
  'waste.record': 'Record waste',
  'inventory.manage': 'Manage ingredients, recipes and stock',
  'menu.manage': 'Manage menu, sizes, prices, modifiers',
  'floor.manage': 'Manage floors and tables',
  'delivery.manage': 'Manage delivery partners and commission rules',
  'rates.manage': 'Manage exchange rates',
  'clients.manage': 'Manage clients and coupons',
  'reports.x': 'Print X reports',
  'reports.z': 'Run Z report (close register)',
  'reports.monthly': 'View monthly / consolidated reports',
  'users.manage': 'Manage users and roles',
  'org.manage': 'Manage companies, branches, printers, devices, channels',
  'backup.manage': 'Create, download and schedule backups (restore and delete: tenant admins only)',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const DEFAULT_ROLES: Record<string, Permission[] | ['*']> = {
  Administrator: ['*'],
  Manager: ALL_PERMISSIONS.filter((p) => p !== 'users.manage' && p !== 'org.manage' && p !== 'backup.manage'),
  Cashier: ['pos.access', 'pos.order', 'pos.payment', 'pos.credit_sale', 'pos.split', 'pos.accept_online',
    'pos.register', 'expenses.record', 'reports.x', 'waste.record'],
  Waiter: ['pos.access', 'pos.order', 'pos.split'],
  'Takeaway Staff': ['pos.access', 'pos.order', 'pos.payment', 'pos.accept_online', 'pos.split'],
  Kitchen: ['kds.view', 'waste.record'],
};
