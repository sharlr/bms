import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { Loading } from '../../components/ui';
import { useSession } from '../../session';
import { dt, fmt, fmtQty, ORDER_TYPES, today } from '../../util';

/** Date range + branch scope shared by the range reports; children render the loaded data. */
function RangeReport({ title, path, children }: { title: string; path: string; children: (data: any) => ReactNode }) {
  const { branchId } = useSession();
  const [from, setFrom] = useState(today().slice(0, 8) + '01');
  const [to, setTo] = useState(today());
  const [all, setAll] = useState(false);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setData(null);
    setErr('');
    api.get(`${path}?from=${from}&to=${to}${all ? '' : `&branch_ids=${branchId}`}`).then(setData).catch((e) => setErr(e.message));
  }, [path, from, to, all, branchId]);
  return (
    <div className="stack">
      <div className="row between no-print"><h1>{title}</h1><button onClick={() => window.print()}>🖨 Print</button></div>
      <div className="card row no-print" style={{ alignItems: 'flex-end' }}>
        <label className="field">From<input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="field">To<input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        <label className="field">Branches<select value={all ? 'all' : 'one'} onChange={(e) => setAll(e.target.value === 'all')}>
          <option value="one">Selected branch (top bar)</option><option value="all">All my branches</option></select></label>
        <button onClick={() => { setFrom(today()); setTo(today()); }}>Today</button>
        <button onClick={() => { setFrom(today().slice(0, 8) + '01'); setTo(today()); }}>This month</button>
      </div>
      {err && <div className="card bad">{err}</div>}
      {!data && !err && <Loading />}
      {data && (
        <div className="printable stack">
          <div className="muted small">{title} · {data.period.from} → {data.period.to}{data.currencies.length === 1 ? ` · amounts in ${data.currencies[0]}` : ` · ⚠ mixed currencies (${data.currencies.join(', ')})`}</div>
          {children(data)}
        </div>
      )}
    </div>
  );
}

const Table = ({ head, rows, num = [], foot }: { head: string[]; rows: ReactNode[][]; num?: number[]; foot?: ReactNode[] }) => (
  <div className="table-wrap"><table className="data">
    <thead><tr>{head.map((h, i) => <th key={i} className={num.includes(i) ? 'num' : ''}>{h}</th>)}</tr></thead>
    <tbody>
      {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={num.includes(j) ? 'num' : ''}>{c}</td>)}</tr>)}
      {rows.length === 0 && <tr><td colSpan={head.length} className="muted">Nothing in this period.</td></tr>}
    </tbody>
    {foot && rows.length > 0 && <tfoot><tr>{foot.map((c, j) => <td key={j} className={num.includes(j) ? 'num' : ''}><b>{c}</b></td>)}</tr></tfoot>}
  </table></div>
);
const SOURCES: Record<string, string> = { qr: 'Table QR code', online: 'Online order', kiosk: 'Kiosk' };
const sumOf = (rows: any[], k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);

export function StaffReport() {
  return (
    <RangeReport title="Staff Activity" path="/reports/staff">
      {(d) => <>
        <h2>Cashiers — tickets settled</h2>
        <Table head={['Cashier', 'Role', 'Tickets', 'Dine-in', 'Takeaway / delivery', 'Amount']} num={[2, 3, 4, 5]}
          rows={d.cashiers.map((r: any) => [r.full_name, r.role, r.tickets, r.dine_in, r.takeaway_delivery, fmt(r.amount)])}
          foot={['Total', '', sumOf(d.cashiers, 'tickets'), sumOf(d.cashiers, 'dine_in'), sumOf(d.cashiers, 'takeaway_delivery'), fmt(sumOf(d.cashiers, 'amount'))]} />
        <h2>Waiters — orders handled</h2>
        <Table head={['Waiter / staff', 'Role', 'Orders', 'Guests', 'Paid', 'Cancelled', 'Sales']} num={[2, 3, 4, 5, 6]}
          rows={d.waiters.map((r: any) => [r.full_name, r.role, r.orders, r.guests, r.paid, r.cancelled, fmt(r.amount)])}
          foot={['Total', '', sumOf(d.waiters, 'orders'), sumOf(d.waiters, 'guests'), sumOf(d.waiters, 'paid'), sumOf(d.waiters, 'cancelled'), fmt(sumOf(d.waiters, 'amount'))]} />
        <h2>Cooks — food cooked</h2>
        <Table head={['Cook', 'Role', 'Items cooked', 'Order lines', 'Avg. wait before taken (min)']} num={[2, 3, 4]}
          rows={d.cooks.map((r: any) => [r.full_name, r.role, fmtQty(r.items), r.lines, r.avg_wait_min ?? '—'])}
          foot={['Total', '', fmtQty(sumOf(d.cooks, 'items')), sumOf(d.cooks, 'lines'), '']} />
        <h2>Customers — self orders</h2>
        <Table head={['Ordered via', 'Orders', 'Paid', 'Cancelled', 'Sales']} num={[1, 2, 3, 4]}
          rows={d.self_orders.map((r: any) => [SOURCES[r.source] ?? r.source, r.orders, r.paid, r.cancelled, fmt(r.amount)])}
          foot={['Total', sumOf(d.self_orders, 'orders'), sumOf(d.self_orders, 'paid'), sumOf(d.self_orders, 'cancelled'), fmt(sumOf(d.self_orders, 'amount'))]} />
      </>}
    </RangeReport>
  );
}

export function SettlementReport() {
  return (
    <RangeReport title="Settlement-wise Receipts" path="/reports/settlements">
      {(d) => <>
        <h2>Summary by settlement</h2>
        <Table head={['Settlement', 'Currency', 'Receipts', 'Received', 'Refunded', 'Net', 'Net (base)']} num={[2, 3, 4, 5, 6]}
          rows={d.summary.map((g: any) => [g.method, g.currency_code, g.count, fmt(g.received), fmt(g.refunded), fmt(g.net), fmt(g.net_base)])}
          foot={['Total', '', sumOf(d.summary, 'count'), '', '', '', fmt(d.total_base)]} />
        <h2>Receipts</h2>
        {d.truncated && <div className="card warn">Showing the first 20,000 receipts — narrow the date range.</div>}
        <Table head={['Date', 'Branch', 'Ticket', 'Type', 'Settlement', 'Amount', 'Rate', 'Base', 'Cashier', 'Client / ref']} num={[5, 6, 7]}
          rows={d.receipts.map((r: any) => [dt(r.created_at), r.branch, r.ticket_ref, r.kind === 'refund' ? <span className="pill bad">Refund</span> : ORDER_TYPES[r.order_type],
            r.method, `${fmt(r.amount)} ${r.currency_code}`, r.rate === 1 ? '' : r.rate, fmt(r.base_amount), r.cashier ?? 'online', r.client ?? r.reference ?? ''])} />
      </>}
    </RangeReport>
  );
}

export function ItemSalesReport() {
  return (
    <RangeReport title="Item-wise Sales" path="/reports/items">
      {(d) => <>
        <p className="small muted">Settled tickets only. Voided lines excluded; refunded quantities deducted. "Net amount" spreads ticket discounts over the items.</p>
        <Table head={['Category', 'Item', 'Size', 'Qty sold', 'Refunded', 'Net qty', 'Tickets', 'Gross', 'Net amount']} num={[3, 4, 5, 6, 7, 8]}
          rows={d.items.map((r: any) => [r.category, r.item_name, r.size_name ?? '—', fmtQty(r.qty), r.refunded_qty ? fmtQty(r.refunded_qty) : '', fmtQty(r.net_qty), r.tickets, fmt(r.gross), fmt(r.net_amount)])}
          foot={['Total', '', '', '', '', fmtQty(d.totals.qty), '', fmt(d.totals.gross), fmt(d.totals.net_amount)]} />
      </>}
    </RangeReport>
  );
}
