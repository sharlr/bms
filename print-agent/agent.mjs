// BMS in-store print agent.
// Runs on any PC / Raspberry Pi inside the restaurant LAN. It connects OUT to the BMS server over WSS
// (no inbound ports needed), receives KOT / receipt jobs for its branch and sends ESC/POS bytes to
// network printers (tcp://ip:9100). Kitchen KOTs go to the kitchen printer, drinks to the beverage printer.
import net from 'node:net';
import { io } from 'socket.io-client';

const { BMS_URL, BMS_TENANT, BMS_DEVICE_TOKEN, ALLOWED_PRINTERS = '' } = process.env;
if (!BMS_URL || !BMS_TENANT || !BMS_DEVICE_TOKEN) {
  console.error('Set BMS_URL, BMS_TENANT and BMS_DEVICE_TOKEN (see .env.example)');
  process.exit(1);
}
const allow = ALLOWED_PRINTERS.split(',').map((s) => s.trim()).filter(Boolean);

// Only ever connect to printers on the local network (defence if the server were compromised).
const isPrivate = (h) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(h) || /\.local$/.test(h);
function target(connection) {
  const m = /^tcp:\/\/([a-zA-Z0-9.-]+):(\d{1,5})$/.exec(connection ?? '');
  if (!m) throw new Error(`Unsupported printer connection "${connection}"`);
  const [, host, port] = m;
  if (allow.length ? !allow.includes(`${host}:${port}`) : !isPrivate(host)) throw new Error(`Printer ${host}:${port} not allowed`);
  return { host, port: Number(port) };
}

// ---------- ESC/POS rendering ----------
const ESC = '\x1b', GS = '\x1d';
const INIT = ESC + '@', BOLD_ON = ESC + 'E\x01', BOLD_OFF = ESC + 'E\x00', BIG = GS + '!\x11', NORMAL = GS + '!\x00';
const CENTER = ESC + 'a\x01', LEFT = ESC + 'a\x00', CUT = GS + 'V\x42\x00', BEEP = ESC + 'B\x03\x02';
const ascii = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e\n]/g, '?');
const money = (n) => Number(n ?? 0).toFixed(2);
const qty = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(2));
const lr = (l, r, w) => { l = ascii(l); r = ascii(r); return l.slice(0, Math.max(1, w - r.length - 1)).padEnd(w - r.length) + r; };
const line = (w) => '-'.repeat(w);

function renderKot(p, w) {
  let out = INIT + BEEP + CENTER + BIG + BOLD_ON + (p.type === 'void' ? '*** VOID ***' : ascii(p.station ?? (p.route === 'beverage' ? 'BAR' : 'KITCHEN')).toUpperCase()) + '\n' + NORMAL;
  if (p.kot_no) out += `KOT #${p.kot_no}\n`;
  out += BOLD_OFF + LEFT + ascii(`${p.ticket_ref}  ${p.table ? 'Table ' + p.table : (p.order_type ?? '').toUpperCase()}`) + '\n';
  if (p.pax) out += `Guests: ${p.pax}\n`;
  if (p.staff) out += ascii(`Staff: ${p.staff}`) + '\n';
  if (p.customer) out += ascii(`Customer: ${p.customer}`) + '\n';
  out += new Date(p.created_at ?? Date.now()).toLocaleString() + '\n' + line(w) + '\n';
  for (const l of p.lines ?? []) {
    out += BIG + BOLD_ON + ascii(`${qty(l.qty)} x ${l.name}${l.size ? ` (${l.size})` : ''}`) + NORMAL + BOLD_OFF + '\n';
    if (l.seat) out += `   Seat ${l.seat}\n`;
    for (const m of l.modifiers ?? []) out += ascii(`   + ${m.name}`) + '\n';
    if (l.notes) out += ascii(`   NOTE: ${l.notes}`) + '\n';
    if (l.allergy) out += BOLD_ON + ascii(`   !! ALLERGY: ${l.allergy}`) + BOLD_OFF + '\n';
  }
  if (p.reason) out += ascii(`Reason: ${p.reason}`) + '\n';
  if (p.notes) out += line(w) + '\n' + ascii(`Order note: ${p.notes}`) + '\n';
  return out + '\n\n\n' + CUT;
}

function renderReceipt(p, w) {
  const b = p.branch, t = p.ticket;
  let out = INIT + CENTER + BOLD_ON + BIG + ascii(b.company_name) + '\n' + NORMAL + BOLD_OFF;
  for (const s of [b.legal_name, b.name, b.address, b.phone && `Tel ${b.phone}`, b.tax_id && `Tax ID ${b.tax_id}`, b.receipt_header]) if (s) out += ascii(s) + '\n';
  out += LEFT + line(w) + '\n' + ascii(`Ticket ${t.ticket_ref}`) + '\n' + new Date(t.closed_at ?? t.opened_at).toLocaleString() + '\n';
  if (t.table_name) out += ascii(`Table ${t.table_name}  Guests ${t.pax}`) + '\n';
  if (t.delivery_company_name) out += ascii(`Delivery: ${t.delivery_company_name}`) + '\n';
  if (p.credit_client) {
    out += line(w) + '\n' + BOLD_ON + 'CREDIT SALE\n' + ascii(`Client: ${p.credit_client.name}`) + BOLD_OFF + '\n';
    if (p.credit_client.phone) out += ascii(`Tel: ${p.credit_client.phone}`) + '\n';
    if (p.credit_client.tax_id) out += ascii(`Tax ID: ${p.credit_client.tax_id}`) + '\n';
  }
  out += line(w) + '\n';
  for (const l of t.lines) {
    out += lr(`${qty(l.qty)} x ${l.item_name}${l.size_name ? ` (${l.size_name})` : ''}`, money(l.line_total), w) + '\n';
    for (const m of l.modifiers ?? []) out += ascii(`   + ${m.name}`) + '\n';
  }
  out += line(w) + '\n' + lr('Subtotal', money(t.subtotal), w) + '\n';
  if (t.discount_amount > 0) out += lr('Discount', '-' + money(t.discount_amount), w) + '\n';
  out += lr(`Tax ${b.tax_rate}%${b.tax_inclusive ? ' incl.' : ''}`, money(t.tax_amount), w) + '\n';
  out += BOLD_ON + lr(`TOTAL ${t.currency}`, money(t.total), w) + BOLD_OFF + '\n';
  for (const pm of t.payments.filter((x) => x.kind === 'payment')) {
    out += lr(`${pm.method_name}${pm.currency_code !== t.currency ? ` ${money(pm.amount)} ${pm.currency_code}` : ''}`, money(pm.base_amount), w) + '\n';
  }
  if (t.change_amount > 0) out += lr('Change', money(t.change_amount), w) + '\n';
  out += line(w) + '\n' + CENTER + ascii(b.receipt_footer ?? 'Thank you!') + '\n';
  if (p.credit_client) out += LEFT + '\n\nSignature: ______________________\n';
  return out + '\n\n\n' + CUT;
}

// ---------- Transport (one job at a time per printer) ----------
const queues = new Map();
function send(host, port, data) {
  const key = `${host}:${port}`;
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port, timeout: 8000 }, () => sock.end(Buffer.from(data, 'latin1')));
    sock.on('timeout', () => { sock.destroy(); reject(new Error('printer timeout')); });
    sock.on('error', reject);
    sock.on('close', (hadErr) => !hadErr && resolve());
  }));
  queues.set(key, next);
  return next;
}

const socket = io(BMS_URL, {
  path: '/api/socket.io', transports: ['websocket'], auth: { tenant: BMS_TENANT, deviceToken: BMS_DEVICE_TOKEN },
  reconnectionDelayMax: 15000,
});
const seen = new Set();
socket.on('connect', () => console.log(new Date().toISOString(), 'connected to', BMS_URL));
socket.on('connect_error', (e) => console.error(new Date().toISOString(), 'connect error:', e.message));
socket.on('print:job', async (job) => {
  if (seen.has(job.id)) return;
  seen.add(job.id);
  if (seen.size > 5000) seen.clear();
  try {
    const { host, port } = target(job.connection);
    const w = job.chars_per_line ?? 42;
    const data = job.kind === 'receipt' ? renderReceipt(job.payload, w) : renderKot(job.payload, w);
    await send(host, port, data);
    socket.emit('print:ack', { jobId: job.id, ok: true });
    console.log(new Date().toISOString(), `printed job ${job.id} (${job.kind}) on ${host}:${port}`);
  } catch (e) {
    seen.delete(job.id);
    socket.emit('print:ack', { jobId: job.id, ok: false, error: e.message });
    console.error(new Date().toISOString(), `job ${job.id} failed:`, e.message);
  }
});
