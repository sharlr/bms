// End-to-end smoke test of the BMS API against a real PostgreSQL.
// Usage: BMS_TEST_URL=http://localhost:4000/api PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node tests/e2e.mjs
// Creates two throw-away tenants. Run against a dev/staging stack, never production.
const BASE = process.env.BMS_TEST_URL ?? 'http://localhost:4000/api';
let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  ✓', msg); else { failures++; console.log('  ✗', msg); } };

class Client {
  constructor(name) { this.name = name; this.jar = {}; this.headers = {}; }
  async req(method, path, body, extra = {}) {
    const h = { 'content-type': 'application/json', ...this.headers, ...extra };
    if (method !== 'GET') h['x-requested-with'] = h['x-requested-with'] ?? 'bms';
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of r.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v === '' || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc)) delete this.jar[k]; else this.jar[k] = v;
    }
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}, e) { return this.req('POST', p, b, e); }
  patch(p, b) { return this.req('PATCH', p, b); }
  put(p, b) { return this.req('PUT', p, b); }
}
const must = (r, label) => { if (r.status >= 400) { console.log(`  ✗ ${label}: ${r.status}`, r.data); failures++; throw new Error(label); } return r.data; };

// ---------- Platform ----------
console.log('Platform & provisioning');
const plat = new Client('platform');
must(await plat.post('/platform/login', { email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD }), 'platform login');
const slug = 'pizzahut' + Date.now().toString(36).slice(-4);
const prov = must(await plat.post('/platform/tenants', {
  slug, name: 'Pizza Hut Test', company_name: 'PH Foods Ltd', currency: 'KES', branch_name: 'Westlands', branch_code: 'WL',
  admin_username: 'owner', admin_full_name: 'Owner One', admin_password: 'OwnerPassw0rd', admin_pin: '4826',
}), 'provision tenant');
ok(prov.url.endsWith('/' + slug), `tenant provisioned at ${prov.url}`);
const slug2 = 'kfc' + Date.now().toString(36).slice(-4);
must(await plat.post('/platform/tenants', {
  slug: slug2, name: 'Other', company_name: 'Other Co', currency: 'USD', branch_name: 'Main', branch_code: 'MN',
  admin_username: 'owner', admin_full_name: 'Other Owner', admin_password: 'OwnerPassw0rd',
}), 'provision 2nd tenant');
ok((await plat.post('/platform/tenants', { slug: 'api' })).status === 400, 'reserved/invalid slug rejected');
const slug3 = 'djib' + Date.now().toString(36).slice(-4);
const tDj = must(await plat.post('/platform/tenants', {
  slug: slug3, name: 'Djibouti Test', company_name: 'DJ Co', currency: 'DJF', branch_name: 'Plateau', branch_code: 'PL',
  admin_username: 'owner', admin_full_name: 'DJ Owner', admin_password: 'OwnerPassw0rd',
}), 'tenant with DJF base currency');
ok(tDj.slug === slug3, 'DJF (Djibouti franc) accepted as base currency');
ok((await plat.req('DELETE', `/platform/tenants/${tDj.id}`, { confirm: slug3 })).status === 409, 'active tenant cannot be deleted (suspend first)');
must(await plat.post(`/platform/tenants/${tDj.id}/status`, { status: 'suspended' }), 'suspend tenant');
ok((await plat.req('DELETE', `/platform/tenants/${tDj.id}`, { confirm: 'nope' })).status === 400, 'delete needs the slug typed');
const delRes = must(await plat.req('DELETE', `/platform/tenants/${tDj.id}`, { confirm: slug3 }), 'delete tenant');
ok(delRes.archive?.includes(`_deleted/${slug3}_`) && !(await plat.get('/platform/tenants')).data.some((x) => x.slug === slug3), 'tenant deleted with a final archive kept');
ok((await new Client('x').get(`/t/${slug3}/auth/me`)).status === 404, 'deleted tenant URL no longer works');
const t3b = must(await plat.post('/platform/tenants', {
  slug: slug3, name: 'Djibouti Again', company_name: 'DJ Co', currency: 'DJF', branch_name: 'Plateau', branch_code: 'PL',
  admin_username: 'owner', admin_full_name: 'DJ Owner', admin_password: 'OwnerPassw0rd',
}), 'recreate same slug');
ok(t3b.slug === slug3, 'database and role were really dropped (slug can be provisioned again)');
await new Client('warm').get(`/t/${slug3}/auth/me`); // cache the tenant, so the rename must invalidate it
must(await plat.patch(`/platform/tenants/${t3b.id}`, { name: 'Djibouti Plateau' }), 'rename tenant');
const renamed = must(await new Client('y').get(`/t/${slug3}/auth/me`), 'me after rename');
ok(renamed.tenant.name === 'Djibouti Plateau' && renamed.tenant.slug === slug3, 'tenant display name renamed immediately, URL unchanged');
ok((await plat.patch(`/platform/tenants/${t3b.id}`, { name: '  ' })).status === 400, 'empty tenant name rejected');

const T = `/t/${slug}`;
// ---------- Auth ----------
console.log('Auth & security');
const admin = new Client('admin');
ok((await admin.post(`${T}/auth/login`, { username: 'owner', password: 'OwnerPassw0rd' }, { 'x-requested-with': 'nope' })).status === 403, 'CSRF header enforced');
ok((await admin.post(`${T}/auth/login`, { username: 'owner', password: 'wrong' })).status === 401, 'bad password rejected');
must(await admin.post(`${T}/auth/login`, { username: 'owner', password: 'OwnerPassw0rd' }), 'admin login');
const me = must(await admin.get(`${T}/auth/me`), 'me');
const branchId = me.context.branches[0].id;
const companyId = me.context.companies[0].id;
admin.headers['x-branch-id'] = String(branchId);
ok(me.user.is_tenant_admin && me.context.branches.length === 1, 'context switcher data returned');
const other = new Client('other');
must(await other.post(`/t/${slug2}/auth/login`, { username: 'owner', password: 'OwnerPassw0rd' }), 'tenant2 login');
// Tenant isolation: tenant2 session cookie replayed against tenant1
const cross = new Client('cross'); cross.jar = Object.fromEntries(Object.entries(other.jar).map(([k, v]) => [k.replace(slug2, slug), v]));
ok((await cross.get(`${T}/companies`)).status === 401, 'tenant2 session token is useless on tenant1 (separate DB)');
ok((await other.get(`/t/${slug2}/companies`)).data.every((c) => c.name !== 'PH Foods Ltd'), 'tenant2 cannot see tenant1 companies');

// ---------- Setup: printers, menu, stock ----------
console.log('Setup: printers, menu, sizes, branch pricing, recipes');
const stationList = must(await admin.get(`${T}/prep-stations`), 'stations');
const stKitchen = stationList.find((x) => x.name === 'Kitchen'), stBar = stationList.find((x) => x.name === 'Bar');
ok(stKitchen && stBar, 'every company starts with a Kitchen and a Bar station');
const stGrill = must(await admin.post(`${T}/prep-stations`, { name: 'Grill', color: '#b45309' }), 'add a third station');
must(await admin.post(`${T}/printers`, { name: 'Kitchen', kind: 'kot', station_id: stKitchen.id, connection: 'tcp://192.168.1.50:9100' }), 'kitchen printer');
must(await admin.post(`${T}/printers`, { name: 'Bar', kind: 'kot', station_id: stBar.id, connection: 'tcp://192.168.1.51:9100' }), 'bar printer');
must(await admin.post(`${T}/printers`, { name: 'Grill A', kind: 'kot', station_id: stGrill.id, connection: 'tcp://192.168.1.52:9100' }), 'grill printer 1');
must(await admin.post(`${T}/printers`, { name: 'Grill B', kind: 'kot', station_id: stGrill.id, connection: 'tcp://192.168.1.53:9100' }), 'grill printer 2');
ok((await admin.post(`${T}/printers`, { name: 'Bad', kind: 'kot', connection: 'tcp://192.168.1.54:9100' })).status === 400, 'KOT printer must belong to a kitchen / bar');
const food = must(await admin.post(`${T}/menu/categories`, { name: 'Pizza', station_id: stKitchen.id, color: '#dc2626' }), 'food cat');
const drinks = must(await admin.post(`${T}/menu/categories`, { name: 'Drinks', station_id: stBar.id, color: '#2563eb' }), 'drink cat');
const pizza = must(await admin.post(`${T}/menu/items`, {
  category_id: food.id, name: 'Margherita', tracks_stock: true, sizes: ['Small', 'Medium', 'Large'],
  prices: [{ size_name: 'Small', branch_id: null, price: 500 }, { size_name: 'Medium', branch_id: null, price: 800 },
    { size_name: 'Large', branch_id: null, price: 1100 }, { size_name: 'Large', branch_id: branchId, price: 1200 }],
}), 'pizza w/ sizes');
const coke = must(await admin.post(`${T}/menu/items`, { category_id: drinks.id, name: 'Coke', tracks_stock: false, prices: [{ branch_id: null, price: 150 }] }), 'coke');
const items = must(await admin.get(`${T}/menu/items`), 'items');
const pz = items.find((i) => i.id === pizza.id);
const large = pz.sizes.find((s) => s.name === 'Large');
const grp = must(await admin.post(`${T}/menu/modifier-groups`, { name: 'Extras', max_select: 3 }), 'mod group');
const xcheese = must(await admin.post(`${T}/menu/modifiers`, { group_id: grp.id, name: 'Extra cheese', price_delta: 100 }), 'modifier');
must(await admin.put(`${T}/menu/items/${pizza.id}/modifier-groups`, [grp.id]), 'link modifiers');
const dough = must(await admin.post(`${T}/inventory/ingredients`, { name: 'Dough', unit: 'g', cost_per_unit: 0.2 }), 'ingredient');
const cheese = must(await admin.post(`${T}/inventory/ingredients`, { name: 'Mozzarella', unit: 'g', cost_per_unit: 1.1 }), 'ingredient2');
must(await admin.put(`${T}/inventory/recipes`, { menu_item_id: pizza.id, size_id: large.id, lines: [{ ingredient_id: dough.id, qty: 400 }, { ingredient_id: cheese.id, qty: 250 }] }), 'recipe');
must(await admin.post(`${T}/inventory/stock/adjust`, { ingredient_id: dough.id, kind: 'purchase', qty_change: 1000, unit_cost: 0.2 }), 'purchase dough');
must(await admin.post(`${T}/inventory/stock/adjust`, { ingredient_id: cheese.id, kind: 'purchase', qty_change: 600 }), 'purchase cheese');
must(await admin.put(`${T}/inventory/stock/${cheese.id}/min`, { min_qty: 300 }), 'min qty');
const palette = must(await admin.get(`${T}/menu/palette`), 'palette');
ok(palette.items.find((i) => i.id === pizza.id).sizes.find((s) => s.name === 'Large').price === 1200, 'branch price overrides company price (Large = 1200)');
const notesList = must(await admin.get(`${T}/menu/cooking-notes?active=true`), 'cooking notes');
ok(notesList.length === 12 && notesList[0].text === 'Well done', 'new restaurant gets 12 default cooking notes');
const extraNote = must(await admin.post(`${T}/menu/cooking-notes`, { text: 'Extra crispy' }), 'add cooking note');
must(await admin.patch(`${T}/menu/cooking-notes/${extraNote.id}`, { active: false }), 'hide cooking note');
ok(!(await admin.get(`${T}/menu/cooking-notes?active=true`)).data.some((n) => n.text === 'Extra crispy'), 'inactive notes are not offered at the POS');
const cookie = (c) => Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ');
const putImg = (type, body) => fetch(`${BASE}${T}/menu/items/${pizza.id}/image`, { method: 'PUT', body, headers: { 'content-type': type, 'x-requested-with': 'bms', 'x-branch-id': String(branchId), cookie: cookie(admin) } });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const upImg = await putImg('image/png', png);
const imgUrl = (await upImg.json()).image_url;
ok(upImg.status === 200 && imgUrl.startsWith(`/api/t/${slug}/public/menu-images/${pizza.id}?v=`), 'menu item photo uploaded');
const imgGet = await fetch(`${BASE.replace(/\/api$/, '')}${imgUrl}`);
ok(imgGet.status === 200 && imgGet.headers.get('content-type') === 'image/png' && Buffer.from(await imgGet.arrayBuffer()).equals(png), 'photo served by the app (public, for QR/online menus)');
ok((await putImg('image/png', Buffer.from('<html><script>alert(1)</script></html>'))).status === 400, 'file pretending to be an image is rejected');
ok((await putImg('image/svg+xml', Buffer.from('<svg/>'))).status >= 400, 'SVG uploads are not accepted');
ok((await admin.get(`${T}/menu/palette`)).data.items.find((i) => i.id === pizza.id).image_url === imgUrl, 'POS menu shows the photo');
must(await admin.put(`${T}/menu/items/${coke.id}/prices`, [{ size_id: null, branch_id: null, price: 150 }, { size_id: null, branch_id: null, order_type: 'delivery', price: 180 }]), 'delivery price for coke');
const palDelivery = must(await admin.get(`${T}/menu/palette?order_type=delivery`), 'delivery palette');
ok(palDelivery.items.find((i) => i.id === coke.id).price === 180 && palette.items.find((i) => i.id === coke.id).price === 150, 'menu shows delivery price 180 vs dine-in 150');

// ---------- Terminal: device + PIN ----------
console.log('Terminal registration & PIN login');
const term = new Client('terminal');
term.headers['x-branch-id'] = String(branchId);
must(await term.post(`${T}/auth/login`, { username: 'owner', password: 'OwnerPassw0rd' }), 'manager login on terminal');
must(await term.post(`${T}/auth/devices`, { name: 'Counter 1', mode: 'pos' }), 'register device');
await term.post(`${T}/auth/logout`);
const staff = must(await term.get(`${T}/auth/staff`), 'staff grid');
ok(staff.length === 1 && staff[0].full_name === 'Owner One', 'staff grid lists PIN users for this branch');
ok((await new Client('x').get(`${T}/auth/staff`)).status === 401, 'staff grid hidden from unregistered browsers');
ok((await term.post(`${T}/auth/pin`, { user_id: staff[0].id, pin: '1111' })).status === 401, 'wrong PIN rejected');
must(await term.post(`${T}/auth/pin`, { user_id: staff[0].id, pin: '4826' }), 'PIN login');
delete term.headers['x-branch-id']; // device-bound session: branch comes from the device

// ---------- Dine-in flow ----------
console.log('Dine-in: floor, PAX, order, KOT routing, stock');
const floor = must(await term.get(`${T}/pos/floor`), 'floor');
ok(floor.tables.length === 6, 'floor plan with 6 seeded tables');
const t1 = floor.tables[0];
let tk = must(await term.post(`${T}/pos/tables/${t1.id}/open`, { pax: 3 }), 'open table');
ok(tk.pax === 3 && tk.table_name === t1.name, 'table opened with PAX 3');
ok((await term.post(`${T}/pos/tables/${t1.id}/open`, { pax: 2 })).status === 409, 'occupied table cannot be re-opened');
tk = must(await term.post(`${T}/pos/tickets/${tk.id}/lines`, { menu_item_id: pizza.id, size_id: large.id, qty: 2, modifier_ids: [xcheese.id], notes: 'well done', allergy_note: 'nut allergy', seat_no: 1 }), 'add pizza');
tk = must(await term.post(`${T}/pos/tickets/${tk.id}/lines`, { menu_item_id: coke.id, qty: 3, seat_no: 2 }), 'add coke');
ok(tk.subtotal === 2 * 1300 + 450, `subtotal ${tk.subtotal} = 2x(1200+100) + 3x150`);
ok((await term.post(`${T}/pos/tickets/${tk.id}/lines`, { menu_item_id: pizza.id, qty: 1 })).status === 400, 'size required for sized item');
const sent = must(await term.post(`${T}/pos/tickets/${tk.id}/send`), 'send to kitchen');
ok(sent.sent === 2, 'two lines sent');
const kds = must(await term.get(`${T}/kds/orders`), 'kds');
const myKots = kds.filter((k) => k.ticket_id === tk.id);
ok(myKots.length === 2 && myKots.some((k) => k.station_name === 'Kitchen') && myKots.some((k) => k.station_name === 'Bar'), 'food → Kitchen KOT, drinks → Bar KOT');
const jobs = must(await term.get(`${T}/print/jobs`), 'print jobs');
ok(jobs.filter((j) => j.kind === 'kot' && j.status === 'pending').length >= 2, 'print jobs queued for both printers');
// Any number of stations: an item can override its category's station, or skip the kitchen ticket.
const steak = must(await admin.post(`${T}/menu/items`, { category_id: food.id, name: 'Steak', station_id: stGrill.id, prices: [{ branch_id: null, price: 900 }] }), 'item routed to Grill');
const water = must(await admin.post(`${T}/menu/items`, { category_id: drinks.id, name: 'Water', no_kot: true, prices: [{ branch_id: null, price: 50 }] }), 'item without kitchen ticket');
let tg = must(await term.post(`${T}/pos/tickets`, { order_type: 'takeaway' }), 'multi-station ticket');
for (const it of [{ menu_item_id: steak.id }, { menu_item_id: pizza.id, size_id: pz.sizes.find((s) => s.name === 'Small').id }, { menu_item_id: coke.id }, { menu_item_id: water.id }]) tg = must(await term.post(`${T}/pos/tickets/${tg.id}/lines`, { ...it, qty: 1 }), 'line');
must(await term.post(`${T}/pos/tickets/${tg.id}/send`), 'send multi-station order');
const tgKots = (await term.get(`${T}/kds/orders`)).data.filter((k) => k.ticket_id === tg.id);
ok(tgKots.length === 3 && ['Grill', 'Kitchen', 'Bar'].every((n) => tgKots.some((k) => k.station_name === n)), 'one order split into Grill, Kitchen and Bar tickets');
const grillOnly = must(await term.get(`${T}/kds/orders?station_id=${stGrill.id}`), 'grill KDS');
ok(grillOnly.every((k) => k.station_id === stGrill.id) && grillOnly.some((k) => k.ticket_id === tg.id), 'each KDS screen can show just its own station');
const grillKot = tgKots.find((k) => k.station_name === 'Grill');
ok((await term.get(`${T}/print/jobs`)).data.filter((j) => j.kind === 'kot' && ['Grill A', 'Grill B'].includes(j.printer)).length === 2, 'a station with 2 printers prints on both');
ok((await term.get(`${T}/pos/tickets/${tg.id}`)).data.lines.find((l) => l.item_name === 'Water').kitchen_status === 'served' && !grillKot.lines.some((l) => l.name === 'Water'), '"No kitchen ticket" item is not sent anywhere');
let mv = must(await term.get(`${T}/inventory/movements?ticket_ref=${tk.ticket_ref}`), 'movements');
ok(mv.length === 2 && mv.every((m) => m.kind === 'sale' && m.ticket_ref === tk.ticket_ref), 'stock movements carry the ticket reference');
let stock = must(await term.get(`${T}/inventory/stock`), 'stock');
ok(stock.find((s) => s.ingredient_id === dough.id).qty === 200, 'dough 1000 - 2x400 = 200');
ok(stock.find((s) => s.ingredient_id === cheese.id).low === true, 'cheese below minimum → low stock');
must(await term.post(`${T}/kds/orders/${myKots[0].id}/status`, { status: 'preparing' }), 'kds status');

// Void 1 pizza with return to stock
const pzLine = tk.lines.find((l) => l.menu_item_id === pizza.id);
tk = must(await term.post(`${T}/pos/tickets/${tk.id}/lines/${pzLine.id}/void`, { reason: 'Customer changed mind', qty: 1 }), 'void 1 pizza');
ok(tk.subtotal === 1300 + 450, 'subtotal after partial void');
stock = must(await term.get(`${T}/inventory/stock`), 'stock');
ok(stock.find((s) => s.ingredient_id === dough.id).qty === 600, 'voided pizza returned to stock (dough 600)');

// Multi-currency + split payment
console.log('Billing: multi-currency, split payments, change');
const rates = must(await admin.post(`${T}/rates`, { currency_code: 'USD', rate: 130 }), 'USD rate');
const methods = must(await term.get(`${T}/payment-methods`), 'methods');
const cash = methods.find((m) => m.method_type === 'cash'), card = methods.find((m) => m.method_type === 'card'), credit = methods.find((m) => m.method_type === 'credit');
let pay = must(await term.post(`${T}/pos/tickets/${tk.id}/payments`, { payments: [{ payment_method_id: card.id, currency_code: 'KES', amount: 750 }] }), 'partial card');
ok(pay.balance_due === 1000 && pay.ticket.status === 'open', 'partial payment leaves 1000 due');
ok((await term.post(`${T}/pos/tickets/${tk.id}/payments`, { payments: [{ payment_method_id: card.id, currency_code: 'KES', amount: 5000 }] })).status === 400, 'card overpayment rejected');
pay = must(await term.post(`${T}/pos/tickets/${tk.id}/payments`, { payments: [{ payment_method_id: cash.id, currency_code: 'USD', amount: 8 }] }), 'USD cash');
ok(pay.ticket.status === 'paid' && pay.change === 40, `paid with USD 8 (=1040 KES), change ${pay.change}`);

// Split check
console.log('Split checks, discounts, cancellation');
let t2 = must(await term.post(`${T}/pos/tables/${floor.tables[1].id}/open`, { pax: 2 }), 'open t2');
t2 = must(await term.post(`${T}/pos/tickets/${t2.id}/lines`, { menu_item_id: coke.id, qty: 4, seat_no: 1 }), 'coke x4');
t2 = must(await term.post(`${T}/pos/tickets/${t2.id}/lines`, { menu_item_id: pizza.id, size_id: large.id, qty: 1, seat_no: 2 }), 'pizza');
must(await term.post(`${T}/pos/tickets/${t2.id}/send`), 'send t2');
const split = must(await term.post(`${T}/pos/tickets/${t2.id}/split`, { mode: 'seat', seat_no: 2 }), 'split by seat');
ok(split.split.total === 1200 && split.original.total === 600, 'split by seat: 1200 / 600');
const split2 = must(await term.post(`${T}/pos/tickets/${t2.id}/split`, { mode: 'items', lines: [{ line_id: split.original.lines[0].id, qty: 1 }] }), 'split by items qty');
ok(split2.split.total === 150 && split2.original.total === 450, 'split 1 of 4 cokes');
let d = must(await term.post(`${T}/pos/tickets/${t2.id}/discount`, { discount_type: 'percent', value: 10 }), 'discount');
ok(d.discount_amount === 45 && d.total === 405, '10% discount');
must(await admin.post(`${T}/coupons`, { code: 'SAVE50', discount_type: 'fixed', value: 50 }), 'coupon');
d = must(await term.post(`${T}/pos/tickets/${split2.split.id}/discount`, { coupon_code: 'save50' }), 'apply coupon');
ok(d.total === 100, 'coupon applied');
const canc = must(await term.post(`${T}/pos/tickets/${split2.split.id}/cancel`, { reason: 'Test cancel' }), 'cancel ticket');
ok(canc.status === 'cancelled', 'ticket cancelled');
must(await term.post(`${T}/pos/tickets/${t2.id}/payments`, { payments: [{ payment_method_id: cash.id, currency_code: 'KES', amount: 405 }] }), 'pay t2');
must(await term.post(`${T}/pos/tickets/${split.split.id}/payments`, { payments: [{ payment_method_id: cash.id, currency_code: 'KES', amount: 1200 }] }), 'pay split');

// Clear table
let t3 = must(await term.post(`${T}/pos/tables/${floor.tables[2].id}/open`, { pax: 1 }), 'open t3');
must(await term.post(`${T}/pos/tickets/${t3.id}/lines`, { menu_item_id: coke.id, qty: 1 }), 'line t3');
must(await term.post(`${T}/pos/tables/${floor.tables[2].id}/clear`, { reason: 'Walked out' }), 'clear table');
const fl2 = must(await term.get(`${T}/pos/floor`), 'floor');
ok(!fl2.tables.find((x) => x.id === floor.tables[2].id).ticket_id, 'table cleared and free');

// ---------- Credit sale ----------
console.log('Credit sale & refund');
const client = must(await admin.post(`${T}/clients`, { name: 'Acme Corp', phone: '0700000000', credit_allowed: true, credit_limit: 5000 }), 'client');
let tc = must(await term.post(`${T}/pos/tickets`, { order_type: 'takeaway', client_id: client.id }), 'takeaway w/ client');
must(await term.post(`${T}/pos/tickets/${tc.id}/lines`, { menu_item_id: coke.id, qty: 2 }), 'line');
tc = must(await term.post(`${T}/pos/tickets/${tc.id}/payments`, { payments: [{ payment_method_id: credit.id, currency_code: 'KES', amount: 300 }] }), 'credit pay').ticket;
const rc = must(await term.get(`${T}/pos/tickets/${tc.id}/receipt`), 'receipt');
ok(rc.credit_client?.name === 'Acme Corp', 'credit client printed on receipt');
const rf = must(await term.post(`${T}/pos/tickets/${tc.id}/refund`, { lines: [{ line_id: tc.lines[0].id, qty: 1 }], reason: 'Flat drink', payment_method_id: credit.id }), 'partial refund');
ok(rf.refund_status === 'partial' && rf.refunded_amount === 150, 'partial refund 150');
const cl = must(await admin.get(`${T}/clients/${client.id}`), 'client');
ok(cl.balance === 150, 'client credit balance 300 - 150 = 150');

// ---------- Delivery commissions ----------
console.log('Delivery partners, commission rules');
const dco = must(await admin.post(`${T}/delivery/companies`, { name: 'FastBike' }), 'delivery co');
must(await admin.post(`${T}/delivery/rules`, { delivery_company_id: dco.id, basis: 'delivery', commission_type: 'fixed', value: 100 }), 'per-delivery fixed rule');
must(await admin.post(`${T}/delivery/rules`, { delivery_company_id: dco.id, basis: 'item', commission_type: 'percent', value: 10, menu_item_id: pizza.id }), 'per-item % rule');
const mkDelivery = async () => {
  let t = must(await term.post(`${T}/pos/tickets`, { order_type: 'delivery', delivery_company_id: dco.id, customer_name: 'Jane', customer_phone: '0711 222 333', delivery_address: '12 Main St, Apt 4' }), 'delivery ticket');
  must(await term.post(`${T}/pos/tickets/${t.id}/lines`, { menu_item_id: pizza.id, size_id: large.id, qty: 1 }), 'line');
  return must(await term.post(`${T}/pos/tickets/${t.id}/payments`, { payments: [{ payment_method_id: card.id, currency_code: 'KES', amount: 1200 }] }), 'pay delivery').ticket;
};
// cheese is low now; top up
must(await admin.post(`${T}/inventory/stock/adjust`, { ingredient_id: cheese.id, kind: 'purchase', qty_change: 5000 }), 'top up');
must(await admin.post(`${T}/inventory/stock/adjust`, { ingredient_id: dough.id, kind: 'purchase', qty_change: 5000 }), 'top up');
const dA = await mkDelivery(); const dB = await mkDelivery();
const sumC = (t) => t.commissions.reduce((s, c) => s + c.amount, 0);
ok(sumC(dA) === 220, `first delivery commission 100 fixed + 10% of 1200 = ${sumC(dA)}`);
ok(sumC(dB) === 220 && dB.delivery_batch_id === undefined, `same client & address again: full commission, no grouping (${sumC(dB)})`);

// ---------- Public QR & online ----------
console.log('Customer QR / online ordering');
must(await admin.patch(`/t/${slug}/branches/${branchId}`, { online_ordering: true }), 'enable online');
const tables = must(await admin.get(`${T}/tables`), 'tables');
const pub = new Client('customer');
const tinfo = must(await pub.get(`${T}/public/table/${tables[4].qr_token}`), 'qr table');
ok(tinfo.table_name === tables[4].name, 'QR resolves company/branch/table');
const pm = must(await pub.get(`${T}/public/branches/${branchId}/menu?table=${tables[4].qr_token}`), 'public menu');
ok(pm.items.length === 4, 'public menu');
const qo = must(await pub.post(`${T}/public/orders`, { table_token: tables[4].qr_token, order_type: 'dine_in', lines: [{ menu_item_id: coke.id, qty: 2 }] }), 'QR order');
const dlv = must(await pub.get(`${T}/public/branches/${branchId}/delivery-companies`), 'delivery partners');
ok(dlv.some((x) => x.name === 'FastBike'), 'client can list delivery partners');
const oo = must(await pub.post(`${T}/public/orders`, { branch_id: branchId, order_type: 'delivery', delivery_company_id: dco.id, customer_name: 'Bob', customer_phone: '0799 888 777', delivery_address: '5 Hill Rd', delivery_lat: 11.59, delivery_lng: 43.14, lines: [{ menu_item_id: pizza.id, size_id: large.id, qty: 1 }] }), 'online order');
const track = must(await pub.get(`${T}/public/orders/${oo.order_token}`), 'track');
ok(track.status === 'pending' && track.delivery_company === 'FastBike', 'online order pending with chosen partner');
ok((await pub.get(`${T}/pos/floor`)).status === 401, 'customer cannot reach staff API');
const pending = must(await term.get(`${T}/pos/tickets?status=pending`), 'pending');
const qrTicket = pending.find((p) => p.ticket_ref === qo.ticket_ref);
must(await term.post(`${T}/pos/tickets/${qrTicket.id}/send`), 'accept QR order');

// ---------- Customer pays online (sandbox provider) ----------
console.log('Online payment');
ok(track.can_pay === true && track.balance_due === 1200, 'online order can be paid online');
const co = must(await pub.post(`${T}/public/orders/${oo.order_token}/pay`, {}), 'start checkout');
const m = /\/pay\/sandbox\/(\d+)\?ref=([\w-]+)$/.exec(co.redirect_url);
ok(!!m, 'redirected to checkout page');
ok((await pub.post(`${T}/public/pay/sandbox/${m[1]}`, { ref: 'sbx_wrongwrongwrongwrong', approve: true })).status === 404, 'checkout cannot be confirmed without its secret reference');
must(await pub.post(`${T}/public/pay/sandbox/${m[1]}`, { ref: m[2], approve: true }), 'approve payment');
const paidTrack = must(await pub.get(`${T}/public/orders/${oo.order_token}`), 'track after pay');
ok(paidTrack.balance_due === 0 && paidTrack.status === 'open' && !paidTrack.can_pay, 'paid order is accepted and sent to the kitchen');
must(await pub.post(`${T}/public/pay/sandbox/${m[1]}`, { ref: m[2], approve: true }), 'approve twice');
const onlineTicket = (await term.get(`${T}/pos/tickets?status=active`)).data.find((x) => x.customer_name === 'Bob');
ok(onlineTicket.paid_amount === 1200, 'repeat confirmation does not double-charge');
const closed = must(await term.post(`${T}/pos/tickets/${onlineTicket.id}/payments`, { payments: [] }), 'close prepaid ticket');
ok(closed.ticket.status === 'paid', 'cashier closes the prepaid ticket without a new payment');
ok((await term.post(`${T}/pos/tickets/${qrTicket.id}/payments`, { payments: [] })).status === 400, 'empty payment rejected when money is still due');

// ---------- Online table reservations ----------
console.log('Reservations');
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const resv = must(await pub.post(`${T}/public/reservations`, { branch_id: branchId, customer_name: 'Amina', customer_phone: '+253 77 12 34 56', pax: 4, date: tomorrow, time: '19:30', special_request: 'Birthday cake' }), 'book a table online');
ok(resv.status === 'pending' && resv.token, 'online reservation received, waiting for confirmation');
ok((await pub.post(`${T}/public/reservations`, { branch_id: branchId, customer_name: 'Late', customer_phone: '0700000000', pax: 2, date: '2020-01-01', time: '19:00' })).status === 400, 'reservation in the past rejected');
let staffList = must(await term.get(`${T}/reservations?from=${tomorrow}&to=${tomorrow}`), 'staff reservation list');
const amina = staffList.find((r) => r.customer_name === 'Amina');
ok(amina && amina.local_time === '19:30' && amina.pax === 4 && amina.special_request === 'Birthday cake', 'staff see name, phone, pax, time and request');
must(await term.patch(`${T}/reservations/${amina.id}`, { status: 'confirmed', table_id: floor.tables[5].id }), 'confirm + assign table');
ok((await pub.get(`${T}/public/reservations/${resv.token}`)).data.status === 'confirmed', 'customer sees the confirmation');
const seatedTk = must(await term.post(`${T}/reservations/${amina.id}/seat`, {}), 'seat the guests');
ok(seatedTk.table_id === floor.tables[5].id && seatedTk.pax === 4 && seatedTk.notes === 'Birthday cake', 'seating opens the table with the booked guests and request');
const resv2 = must(await pub.post(`${T}/public/reservations`, { branch_id: branchId, customer_name: 'Omar', customer_phone: '0711000000', pax: 2, date: tomorrow, time: '20:00' }), 'second booking');
must(await pub.post(`${T}/public/reservations/${resv2.token}/cancel`, {}), 'customer cancels');
ok((await pub.get(`${T}/public/reservations/${resv2.token}`)).data.status === 'cancelled', 'customer can cancel their reservation');

// ---------- Delivery booked in advance, map pin, prepaid ----------
console.log('Advance delivery');
const advBody = { branch_id: branchId, order_type: 'delivery', delivery_company_id: dco.id, customer_name: 'Sara', customer_phone: '0722000000', delivery_address: 'Plateau du Serpent, villa 12', pax: 6, date: tomorrow, time: '13:00', notes: 'Ring twice', lines: [{ menu_item_id: coke.id, qty: 2 }] };
ok((await pub.post(`${T}/public/orders`, advBody)).status === 400, 'delivery without a map pin rejected');
const adv = must(await pub.post(`${T}/public/orders`, { ...advBody, delivery_lat: 11.5721, delivery_lng: 43.1456 }), 'book delivery for tomorrow');
let advTrack = must(await pub.get(`${T}/public/orders/${adv.order_token}`), 'track advance order');
ok(advTrack.scheduled_for && advTrack.scheduled_for.startsWith(tomorrow) && advTrack.pax === 6 && advTrack.total === 360, 'advance delivery saved with date/time, pax and delivery price');
const advPay = must(await pub.post(`${T}/public/orders/${adv.order_token}/pay`, {}), 'prepay advance order');
const am = /\/pay\/sandbox\/(\d+)\?ref=([\w-]+)$/.exec(advPay.redirect_url);
must(await pub.post(`${T}/public/pay/sandbox/${am[1]}`, { ref: am[2], approve: true }), 'approve prepayment');
advTrack = must(await pub.get(`${T}/public/orders/${adv.order_token}`), 'track after prepay');
ok(advTrack.status === 'open' && advTrack.lines.every((l) => l.kitchen_status === 'new'), 'prepaid advance order accepted but NOT sent to the kitchen yet');
const advTicket = (await term.get(`${T}/pos/tickets?status=scheduled`)).data.find((x) => x.customer_name === 'Sara');
ok(!!advTicket, 'POS lists it under "Booked for later"');
const advDetail = must(await term.get(`${T}/pos/tickets/${advTicket.id}`), 'advance ticket detail');
ok(advDetail.delivery_lat === 11.5721 && advDetail.delivery_lng === 43.1456, 'staff get the delivery pin');
const todayStr = new Date().toISOString().slice(0, 10);
const setBefore = must(await admin.get(`${T}/reports/settlements?from=${todayStr}&to=${todayStr}&branch_ids=${branchId}`), 'settlements today');
const setTomorrow = must(await admin.get(`${T}/reports/settlements?from=${tomorrow}&to=${tomorrow}&branch_ids=${branchId}`), 'settlements tomorrow');
ok(!setBefore.receipts.some((r) => r.ticket_ref === advDetail.ticket_ref) && setTomorrow.receipts.some((r) => r.ticket_ref === advDetail.ticket_ref), 'prepayment counts as a receipt on the delivery date, not the booking date');
must(await term.post(`${T}/pos/tickets/${advTicket.id}/payments`, { payments: [] }), 'hand over & close (cooked now)');
const setAfter = must(await admin.get(`${T}/reports/settlements?from=${todayStr}&to=${todayStr}&branch_ids=${branchId}`), 'settlements after handover');
ok(setAfter.receipts.some((r) => r.ticket_ref === advDetail.ticket_ref), 'handed over early: receipt moves to the actual delivery day');

// ---------- Kitchen takes individual lines ----------
console.log('Kitchen per-line handling');
let kt = must(await term.post(`${T}/pos/tickets`, { order_type: 'takeaway', customer_name: 'Kim' }), 'kitchen ticket');
for (let i = 0; i < 3; i++) kt = must(await term.post(`${T}/pos/tickets/${kt.id}/lines`, { menu_item_id: pizza.id, size_id: large.id, qty: 1, notes: `pizza ${i + 1}` }), 'line');
must(await term.post(`${T}/pos/tickets/${kt.id}/send`), 'send 3 pizzas');
const kotOf = async () => (await term.get(`${T}/kds/orders`)).data.find((k) => k.ticket_id === kt.id);
let kot = await kotOf();
ok(kot.lines.length === 3 && kot.lines.every((l) => l.kitchen_status === 'sent'), 'KDS shows 3 pending lines');
const kitchenRole = (await admin.get(`${T}/roles`)).data.find((r) => r.name === 'Kitchen');
const chefA = must(await admin.post(`${T}/users`, { username: 'chef.ana', full_name: 'Chef Ana', role_id: kitchenRole.id, pin: '7391', access: [{ company_id: companyId, branch_id: branchId }] }), 'kitchen user');
const kStaff = must(await term.get(`${T}/kds/staff`), 'kitchen staff list');
ok(kStaff.length === 1 && kStaff[0].full_name === 'Chef Ana', 'KDS lists kitchen staff only (not admins/cashiers)');
ok((await term.post(`${T}/kds/lines/${kot.lines[0].line_id}/status`, { status: 'preparing', cook_id: me.user.id })).status === 400, 'cannot assign an item to a non-kitchen user');
must(await term.post(`${T}/kds/lines/${kot.lines[0].line_id}/status`, { status: 'preparing', cook_id: chefA.id }), 'Chef Ana takes line 1');
kot = await kotOf();
ok(kot.lines[0].kitchen_status === 'preparing' && kot.lines[0].chef === 'Chef Ana' && kot.lines[1].kitchen_status === 'sent' && kot.status === 'preparing', 'chosen cook takes 1 of 3 — others stay pending');
must(await term.post(`${T}/kds/lines/${kot.lines[0].line_id}/status`, { status: 'ready' }), 'line 1 ready');
must(await term.post(`${T}/kds/lines/${kot.lines[0].line_id}/status`, { status: 'served' }), 'serve the ready item alone');
kot = await kotOf();
ok(kot.lines[0].kitchen_status === 'served' && kot.lines[1].kitchen_status === 'sent', 'a ready item can be served on its own');
must(await term.post(`${T}/kds/orders/${kot.id}/status`, { status: 'preparing', cook_id: chefA.id }), 'take all remaining');
kot = await kotOf();
ok(kot.lines[0].kitchen_status === 'served' && kot.lines[2].kitchen_status === 'preparing', '"take all" does not pull back a finished line');
must(await term.post(`${T}/kds/orders/${kot.id}/status`, { status: 'ready' }), 'all ready');
kot = await kotOf();
ok(kot.status === 'ready' && kot.lines.slice(1).every((l) => l.kitchen_status === 'ready'), 'ticket ready when every remaining line is ready');
must(await term.post(`${T}/pos/tickets/${kt.id}/payments`, { payments: [{ payment_method_id: cash.id, currency_code: 'KES', amount: 3600 }] }), 'pay kitchen ticket');

// ---------- Expenses & reports ----------
console.log('Counter expenses, X / Z / monthly reports');
const cats = must(await term.get(`${T}/expense-categories`), 'cats');
must(await term.post(`${T}/expenses`, { category_id: cats[0].id, description: 'Gas refill', amount: 500 }), 'expense');
const x = must(await term.post(`${T}/reports/x`, {}), 'X report');
ok(x.report_type === 'X' && x.data.cancellations.lines.length === 1 && x.data.cancellations.tickets.length === 2, 'X report lists 1 voided line + cancelled ticket + cleared table');
ok(x.data.expenses.total === 500, 'X report includes counter expenses');
ok(x.data.delivery_commissions[0]?.commission === 760, 'X report includes delivery commissions (3 pizza deliveries x 220 + 1 drinks-only delivery x 100)');
ok(x.data.currencies.some((c) => c.currency_code === 'USD' && c.received === 8), 'X report shows USD received');
const zTry = await term.post(`${T}/reports/z`, { counted_cash: 0 });
ok(zTry.status === 409 && /Close all tickets/.test(zTry.data.message) && zTry.data.message.includes('WL-'), 'Z refused while tickets are open, and lists them');
ok((await term.post(`${T}/reports/z`, { counted_cash: 0, force: true })).status === 409, 'no "close anyway" override (force is ignored)');
for (const ot of must(await term.get(`${T}/pos/tickets?status=active`), 'open tickets')) {
  must(await term.post(`${T}/pos/tickets/${ot.id}/cancel`, { reason: 'End of day test cleanup' }), `cancel ${ot.ticket_ref}`);
}
const z = must(await term.post(`${T}/reports/z`, { counted_cash: 1000 }), 'Z report');
ok(z.report_type === 'Z' && z.data.session.status === 'closed', 'Z closes the register session');
console.log('    expected cash', z.data.cash.expected, 'net sales', z.data.sales.net);
const month = new Date().toISOString().slice(0, 7);
const mr = must(await admin.get(`${T}/reports/monthly?month=${month}`), 'monthly');
ok(mr.by_channel.length >= 3 && mr.totals.tickets >= 6, `monthly report: ${mr.totals.tickets} tickets over ${mr.by_channel.length} channels`);
const mrB = must(await admin.get(`${T}/reports/monthly?month=${month}&branch_id=${branchId}`), 'monthly branch');
ok(mrB.totals.net === mr.totals.net, 'branch filter consistent');
const today = new Date().toISOString().slice(0, 10);
const dash = must(await admin.get(`${T}/reports/dashboard?from=${month}-01&to=${today}&branch_ids=${branchId}`), 'dashboard');
ok(dash.kpis.sales === mr.totals.net && dash.by_branch.length === 1 && dash.daily.length >= 1, 'dashboard KPIs match monthly report');
ok(dash.kpis.owed_by_clients === 150, 'dashboard owed by clients = credit balance');
const R = `from=${month}-01&to=${today}&branch_ids=${branchId}`;
const staffRep = must(await admin.get(`${T}/reports/staff?${R}`), 'staff report');
ok(staffRep.cashiers[0]?.full_name === 'Owner One' && staffRep.cashiers[0].tickets === mr.totals.tickets, 'cashier report: every settled ticket credited to the cashier who closed it');
ok(staffRep.cooks.some((c) => c.full_name === 'Chef Ana' && c.items === 3), 'cook report: 3 pizzas cooked by Chef Ana');
ok(staffRep.waiters.some((w) => w.full_name === 'Owner One' && w.orders >= 8), 'waiter report: orders handled per waiter');
ok(staffRep.self_orders.some((s) => s.source === 'qr') && staffRep.self_orders.some((s) => s.source === 'online' && s.paid === 2), 'self-order report: QR and online orders by customers');
const setRep = must(await admin.get(`${T}/reports/settlements?${R}`), 'settlement report');
ok(setRep.summary.some((g) => g.method === 'Cash' && g.currency_code === 'USD') && setRep.summary.some((g) => g.method === 'Online payment'), 'settlements grouped by method and currency');
ok(setRep.receipts.some((r) => r.kind === 'refund') && Math.abs(setRep.total_base - setRep.receipts.reduce((s, r) => s + r.base_amount, 0)) < 0.01, 'settlement receipts listed incl. refunds, totals add up');
const itemRep = must(await admin.get(`${T}/reports/items?${R}`), 'item sales report');
ok(itemRep.items.some((i) => i.item_name === 'Margherita' && i.size_name === 'Large'), 'item-wise sales per item & size');
ok(Math.abs(itemRep.totals.net_amount - (mr.totals.net - mr.totals.refunds)) < 0.05, `item sales net (${itemRep.totals.net_amount}) = sales − refunds (${mr.totals.net - mr.totals.refunds})`);
ok((await admin.get(`${T}/reports/items?from=${today}&to=2020-01-01`)).status === 400, 'inverted date range rejected');
must(await admin.patch(`${T}/auth/profile`, { theme: 'navy', language: 'fr', position: 'Owner' }), 'profile prefs');
const me2 = must(await admin.get(`${T}/auth/me`), 'me after prefs');
ok(me2.user.theme === 'navy' && me2.user.language === 'fr' && me2.user.position === 'Owner', 'profile theme/language/position saved');
ok((await admin.patch(`${T}/auth/profile`, { theme: 'rainbow' })).status === 400, 'unknown theme rejected');

// ---------- Line edit keeps fields that were not sent ----------
console.log('Line edit semantics');
let te = must(await term.post(`${T}/pos/tickets`, { order_type: 'takeaway' }), 'ticket for edit');
te = must(await term.post(`${T}/pos/tickets/${te.id}/lines`, { menu_item_id: pizza.id, size_id: large.id, qty: 3, modifier_ids: [xcheese.id] }), 'line');
te = must(await term.patch(`${T}/pos/tickets/${te.id}/lines/${te.lines[0].id}`, { notes: 'no basil' }), 'patch notes only');
ok(te.lines[0].qty === 3 && te.lines[0].modifiers.length === 1 && te.lines[0].notes === 'no basil', 'PATCH notes keeps qty & modifiers');
te = must(await term.post(`${T}/pos/tickets/${te.id}/lines`, { menu_item_id: coke.id, qty: 1 }), 'coke takeaway');
ok(te.lines.find((l) => l.menu_item_id === coke.id).unit_price === 150, 'takeaway coke charged 150');
te = must(await term.patch(`${T}/pos/tickets/${te.id}`, { order_type: 'delivery' }), 'switch to delivery');
ok(te.lines.find((l) => l.menu_item_id === coke.id).unit_price === 180, 'switching to delivery reprices coke to 180');
const fl0 = must(await admin.get(`${T}/floors`), 'floors')[0];
must(await admin.patch(`${T}/floors/${fl0.id}`, { width: 1400, height: 900, layout: [
  { id: 'w1', kind: 'wall', x: 0, y: 0, w: 1400, h: 12 }, { id: 'bar1', kind: 'bar', x: 600, y: 700, w: 260, h: 50, label: 'Main bar' }] }), 'save plan layout');
const fpPlan = must(await term.get(`${T}/pos/floor`), 'floor with plan').floors.find((f) => f.id === fl0.id);
ok(fpPlan.width === 1400 && fpPlan.layout.length === 2 && fpPlan.layout[1].label === 'Main bar', 'drawn plan layout is saved and shown on the POS');
ok((await admin.patch(`${T}/floors/${fl0.id}`, { layout: [{ id: 'x', kind: 'spaceship', x: 0, y: 0, w: 10, h: 10 }] })).status === 400, 'unknown plan element rejected');
const big = must(await term.post(`${T}/pos/tables/${floor.tables[3].id}/open`, { pax: 20 }), 'open 4-seat table with 20 guests');
ok(big.pax === 20, 'PAX above seat count is accepted');

// ---------- Privilege escalation guards ----------
console.log('Privilege escalation guards');
const hrRole = must(await admin.post(`${T}/roles`, { name: 'HR', permissions: ['users.manage', 'pos.access', 'pos.order', 'pos.split'] }), 'HR role');
const rolesList = must(await admin.get(`${T}/roles`), 'roles');
const adminRole = rolesList.find((r) => r.name === 'Administrator'), waiterRole = rolesList.find((r) => r.name === 'Waiter');
must(await admin.post(`${T}/users`, { username: 'hrperson', full_name: 'HR Person', role_id: hrRole.id, password: 'HrPassw0rd!x', access: [{ company_id: companyId, branch_id: null }] }), 'create HR user');
const hr = new Client('hr'); hr.headers['x-branch-id'] = String(branchId);
must(await hr.post(`${T}/auth/login`, { username: 'hrperson', password: 'HrPassw0rd!x' }), 'hr login');
ok((await hr.patch(`${T}/users/${me.user.id}`, { password: 'Hacked12345A' })).status === 403, 'non-admin cannot reset tenant admin password');
ok((await hr.post(`${T}/users`, { username: 'evil', full_name: 'Evil', role_id: adminRole.id, password: 'EvilPassw0rd1', access: [] })).status === 403, 'non-admin cannot assign Administrator role');
ok((await hr.patch(`${T}/roles/${hrRole.id}`, { permissions: ['*'] })).status === 403, 'non-admin cannot edit role permissions');
ok((await hr.post(`${T}/users`, { username: 'evil2', full_name: 'Evil', role_id: waiterRole.id, is_tenant_admin: true, access: [] })).status === 403, 'non-admin cannot grant tenant admin');
ok((await hr.post(`${T}/users`, { username: 'waiter1', full_name: 'Waiter One', role_id: waiterRole.id, pin: '5831', access: [{ company_id: companyId, branch_id: branchId }] })).status === 201, 'HR can create a waiter (subset of own permissions)');
ok((await hr.post(`${T}/users`, { username: 'weakpin', full_name: 'W', role_id: waiterRole.id, pin: '1234', access: [] })).status === 400, 'trivial PIN 1234 rejected');
ok((await hr.get(`${T}/reports/monthly?month=${month}`)).status === 403, 'user without reports.monthly is denied');

// ---------- Login with branch + landing page ----------
console.log('Login branch & landing page');
const br2 = must(await admin.post(`/t/${slug}/branches`, { company_id: companyId, name: 'Kilimani', code: 'KL' }), 'second branch');
const cashierRole = (await admin.get(`${T}/roles`)).data.find((r) => r.name === 'Cashier');
must(await admin.post(`${T}/users`, { username: 'cash.ben', full_name: 'Ben Cashier', role_id: cashierRole.id, password: 'CashPassw0rd', access: [{ company_id: companyId, branch_id: branchId }] }), 'cashier user');
const ben = new Client('ben');
ok((await ben.post(`${T}/auth/login`, { username: 'cash.ben', password: 'CashPassw0rd', branch_id: br2.id })).status === 403 && !Object.keys(ben.jar).length, 'login refused for a branch the user is not assigned to (no session created)');
const benLogin = must(await ben.post(`${T}/auth/login`, { username: 'cash.ben', password: 'CashPassw0rd', branch_id: branchId }), 'cashier login with branch');
ok(benLogin.branch_id === branchId && benLogin.company_id === companyId, 'login returns the chosen branch');
const benMe = must(await ben.get(`${T}/auth/me`), 'cashier me');
ok(benMe.user.landing_page === 'auto' && !benMe.user.permissions.includes('reports.monthly') && benMe.user.permissions.includes('pos.access'), 'cashier defaults to automatic landing (→ POS)');
must(await ben.patch(`${T}/auth/profile`, { landing_page: 'orders' }), 'choose landing page');
ok((await ben.get(`${T}/auth/me`)).data.user.landing_page === 'orders', 'each user can choose their landing page');
ok((await ben.patch(`${T}/auth/profile`, { landing_page: 'nowhere' })).status === 400, 'unknown landing page rejected');

// ---------- Backup & restore ----------
console.log('Backup & restore');
ok((await hr.get(`${T}/backups`)).status === 403, 'backups need backup.manage');
const b1 = must(await admin.post(`${T}/backups`, {}), 'manual backup');
ok(b1.version_no === 1 && b1.kind === 'manual' && b1.size_bytes > 1000 && b1.expires_at === null, 'manual backup = version 1, kept until deleted');
const sch = must(await admin.post(`${T}/backups/schedules`, { time: '00:00', timezone: 'Africa/Nairobi', retention_days: 30, enabled: true }), 'add schedule');
let bl = must(await admin.get(`${T}/backups`), 'backup list');
ok(bl.schedules.length === 1 && new Date(bl.schedules[0].next_run_at) > new Date(), 'schedule has a future next run');
must(await admin.patch(`${T}/backups/schedules/${sch.id}`, { enabled: false }), 'disable schedule');
ok((await admin.post(`${T}/backups/schedules`, { time: '25:00', timezone: 'Mars/Base', retention_days: 30, enabled: true })).status === 400, 'invalid schedule rejected');
const dl = await fetch(`${BASE}${T}/backups/${b1.id}/download`, { headers: { cookie: Object.entries(admin.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
const dump = Buffer.from(await dl.arrayBuffer());
ok(dl.status === 200 && dump.subarray(0, 5).toString() === 'PGDMP', 'download returns the pg_dump archive');
must(await admin.post(`${T}/clients`, { name: 'Added After Backup' }), 'change data after backup');
ok((await admin.post(`${T}/backups/${b1.id}/restore`, { confirm: 'wrong' })).status === 400, 'restore needs the tenant name typed');
const rs = must(await admin.post(`${T}/backups/${b1.id}/restore`, { confirm: slug }), 'restore version 1');
ok(rs.restored === 1 && rs.safety_version === 2, 'restore takes a safety backup first');
const clientsAfter = must(await admin.get(`${T}/clients`), 'clients after restore');
ok(!clientsAfter.some((c) => c.name === 'Added After Backup') && clientsAfter.some((c) => c.name === 'Acme Corp'), 'restore brought the data back to the backup point');
const up = await fetch(`${BASE}${T}/backups/upload`, { method: 'POST', body: dump, headers: { 'content-type': 'application/octet-stream', 'x-requested-with': 'bms', cookie: Object.entries(admin.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
ok(up.status === 201 && (await up.json()).kind === 'uploaded', 'backup file can be uploaded for restore');
const bad = await fetch(`${BASE}${T}/backups/upload`, { method: 'POST', body: 'DROP TABLE users;', headers: { 'content-type': 'application/octet-stream', 'x-requested-with': 'bms', cookie: Object.entries(admin.jar).map(([k, v]) => `${k}=${v}`).join('; ') } });
ok(bad.status === 400, 'non-backup upload rejected');
bl = must(await admin.get(`${T}/backups`), 'backup list');
ok(bl.versions.map((v) => v.kind).join(',') === 'uploaded,pre_restore,manual', 'versions listed newest first');
must(await admin.req('DELETE', `${T}/backups/${b1.id}`, {}), 'delete version');
ok((await other.get(`/t/${slug2}/backups`)).data.versions.length === 0, 'other tenant sees none of these backups');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
