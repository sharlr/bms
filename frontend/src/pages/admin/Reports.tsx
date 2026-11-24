import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Modal, useAction } from '../../components/ui';
import { useSession } from '../../session';
import { dt, fmt, fmtQty, ORDER_TYPES, thisMonth } from '../../util';

const T = ({ head, rows }: { head: string[]; rows: (string | number | null | undefined)[][] }) => (
  <table className="data"><thead><tr>{head.map((h, i) => <th key={i} className={i > 0 && typeof rows[0]?.[i] === 'number' ? 'num' : ''}>{h}</th>)}</tr></thead>
    <tbody>{rows.length ? rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === 'number' ? 'num' : ''}>{typeof c === 'number' ? fmt(c) : c}</td>)}</tr>)
      : <tr><td colSpan={head.length} className="muted">None</td></tr>}</tbody></table>
);

/** Rendering of an X or Z report (shift / register session). */
export function SessionReportView({ data, title }: { data: any; title: string }) {
  const s = data.session;
  return (
    <div className="printable stack">
      <div className="card">
        <h1>{title}</h1>
        <div>{s.company} · {s.branch} [{s.branch_code}] · {s.register}</div>
        <div className="small muted">Opened {dt(s.opened_at)} by {s.opened_by}{s.closed_at ? ` · Closed ${dt(s.closed_at)} by ${s.closed_by}` : ' · register still open'} · Currency {s.currency}</div>
      </div>
      <div className="grid2">
        <div className="stat"><div className="l">Net sales</div><div className="v">{fmt(data.sales.net)}</div></div>
        <div className="stat"><div className="l">Tickets / guests</div><div className="v">{data.sales.tickets} / {data.sales.guests}</div></div>
        <div className="stat"><div className="l">Discounts</div><div className="v">{fmt(data.discounts.total)}</div></div>
        <div className="stat"><div className="l">Refunds</div><div className="v">{fmt(data.refunds.total)}</div></div>
        <div className="stat"><div className="l">Counter expenses</div><div className="v">{fmt(data.expenses.total)}</div></div>
        <div className="stat"><div className="l">Cancelled / voided</div><div className="v bad">{fmt(data.cancellations.total)}</div></div>
      </div>
      <div className="report-section"><h2>Sales summary</h2>
        <T head={['', 'Amount']} rows={[['Gross', data.sales.gross], ['Discounts', -data.sales.discounts], ['Tax', data.sales.tax], ['Net', data.sales.net], ['Credit sales', data.credit_sales]]} /></div>
      <div className="report-section"><h2>By order type</h2><T head={['Type', 'Tickets', 'Total']} rows={data.by_order_type.map((r: any) => [ORDER_TYPES[r.order_type], String(r.tickets), r.total])} /></div>
      <div className="report-section"><h2>By receipt channel</h2><T head={['Channel', 'Tickets', 'Total']} rows={data.by_channel.map((r: any) => [r.channel, String(r.tickets), r.total])} /></div>
      <div className="report-section"><h2>Payment modes & currencies</h2>
        <T head={['Method', 'Currency', 'Count', 'Amount (currency)', `Amount (${s.currency})`]} rows={data.payments.map((p: any) => [p.method, p.currency_code, String(p.count), p.amount, p.base_amount])} />
        <h3 style={{ marginTop: '.8rem' }}>Currency totals</h3>
        <T head={['Currency', 'Received', 'Refunded', `Net (${s.currency})`]} rows={data.currencies.map((c: any) => [c.currency_code, c.received ?? 0, c.refunded, c.net_base])} />
      </div>
      <div className="report-section"><h2>Cash drawer</h2>
        <T head={['', 'Amount']} rows={[['Opening float', data.cash.opening_float], ['+ Cash sales', data.cash.cash_sales], ['− Change given', data.cash.change_given],
          ['− Cash refunds', data.cash.cash_refunds], ['− Cash counter expenses', data.cash.cash_expenses], ['= Expected in drawer', data.cash.expected],
          ...(data.cash.counted != null ? [['Counted', data.cash.counted], ['Difference', data.cash.difference]] : [])]} /></div>
      <div className="report-section"><h2>Counter expenses</h2>
        <T head={['Category', 'Description', 'Amount', `Amount (${s.currency})`, 'Staff']} rows={data.expenses.items.map((e: any) => [e.category, e.description, `${fmt(e.amount)} ${e.currency_code}`, e.base_amount, e.user_name])} /></div>
      <div className="report-section"><h2>Delivery company commissions</h2>
        <T head={['Partner', 'Deliveries', 'Sales', 'Commission']} rows={data.delivery_commissions.map((d: any) => [d.delivery_company, String(d.deliveries), d.sales, d.commission])} /></div>
      <div className="report-section"><h2>Discounts</h2>
        <T head={['Ticket', 'Type', 'Coupon', 'Amount']} rows={data.discounts.items.map((d: any) => [d.ticket_ref, d.discount_type === 'percent' ? `${d.discount_value}%` : 'fixed', d.coupon ?? '', d.discount_amount])} /></div>
      <div className="report-section"><h2>Refunds</h2>
        <T head={['Ticket', 'Reason', 'Staff', 'Time', 'Amount']} rows={data.refunds.items.map((r: any) => [r.ticket_ref, r.reason, r.user_name, dt(r.created_at), r.amount])} /></div>
      <div className="report-section"><h2>Cancelled lines (voids)</h2>
        <T head={['Ticket', 'Item', 'Qty', 'Reason', 'By', 'Approved', 'Amount']} rows={data.cancellations.lines.map((c: any) => [c.ticket_ref, c.item_name, fmtQty(c.qty), c.reason, c.user_name, c.approved_by, c.amount])} /></div>
      <div className="report-section"><h2>Cancelled tickets / cleared tables</h2>
        <T head={['Ticket', 'Kind', 'Reason', 'By', 'Approved', 'Amount']} rows={data.cancellations.tickets.map((c: any) => [c.ticket_ref, c.kind === 'table_clear' ? 'Table cleared' : 'Ticket cancelled', c.reason, c.user_name, c.approved_by, c.amount])} /></div>
      {data.open_tickets.count > 0 && <div className="card warn">⚠ {data.open_tickets.count} ticket(s) still open in this branch (unpaid {fmt(data.open_tickets.amount)}) — they must be settled or cancelled before the Z report.</div>}
      <div className="small muted">Generated {dt(data.generated_at)}</div>
    </div>
  );
}

function useSessionInfo() {
  const [info, setInfo] = useState<any>(null);
  const load = useCallback(() => api.get('/pos/session').then(setInfo), []);
  useEffect(() => { load(); }, [load]);
  return { info, load };
}

function SessionPicker({ info, value, onChange }: { info: any; value: number | null; onChange: (id: number) => void }) {
  if (!info?.open_sessions?.length) return <div className="card">No open register session in this branch.</div>;
  return (
    <div className="row">Register session
      <select style={{ maxWidth: 360 }} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
        {info.open_sessions.map((s: any) => <option key={s.id} value={s.id}>{info.registers.find((r: any) => r.id === s.register_id)?.name} — opened {dt(s.opened_at)} by {s.opened_by}</option>)}
      </select>
    </div>
  );
}

export function XReport() {
  const { info } = useSessionInfo();
  const [sid, setSid] = useState<number | null>(null);
  const [data, setData] = useState<any>(null);
  const run = useAction();
  useEffect(() => { if (info?.open_sessions?.[0] && !sid) setSid(info.open_sessions[0].id); }, [info, sid]);
  useEffect(() => { if (sid) api.get(`/reports/session?session_id=${sid}`).then(setData); }, [sid]);
  return (
    <div className="stack">
      <div className="row between no-print"><h1>X Report</h1>
        <button className="primary" disabled={!sid} onClick={async () => { const r = await run(() => api.post('/reports/x', { session_id: sid }), 'X report recorded'); if (r) { setData(r.data); setTimeout(() => window.print(), 100); } }}>Record & print X report</button></div>
      <p className="muted no-print">Mid-shift status of the register without closing it.</p>
      <div className="no-print"><SessionPicker info={info} value={sid} onChange={setSid} /></div>
      {data && <SessionReportView data={data} title="X Report (register remains open)" />}
    </div>
  );
}

export function ZReport() {
  const { info, load } = useSessionInfo();
  const [sid, setSid] = useState<number | null>(null);
  const [counted, setCounted] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const run = useAction();
  useEffect(() => { if (info?.open_sessions?.[0] && !sid) setSid(info.open_sessions[0].id); }, [info, sid]);
  useEffect(() => { if (sid) api.get(`/reports/session?session_id=${sid}`).then(setPreview); }, [sid]);
  // The server refuses while any ticket of the branch is still open, and lists them.
  const close = async () => {
    const r = await run(() => api.post('/reports/z', { session_id: sid, counted_cash: counted === '' ? null : Number(counted) }));
    if (r) { setResult(r); load(); setSid(null); }
  };
  if (result) return (
    <div className="stack"><div className="row no-print"><button className="primary" onClick={() => window.print()}>Print Z report #{result.report_no}</button><button onClick={() => setResult(null)}>Done</button></div>
      <SessionReportView data={result.data} title={`Z Report #${result.report_no} — End of day`} /></div>
  );
  return (
    <div className="stack">
      <h1>Z Report — close register</h1>
      <p className="muted">Closes the register session and produces the end-of-day report: sales, payment modes, currencies, counter expenses, delivery commissions, discounts, refunds and all cancelled lines/tickets.</p>
      <SessionPicker info={info} value={sid} onChange={setSid} />
      {sid && <div className="card row">
        <label className="field">Counted cash in drawer ({preview?.session.currency})<input type="number" step="any" value={counted} onChange={(e) => setCounted(e.target.value)} /></label>
        <div>Expected: <b>{fmt(preview?.cash.expected)}</b></div>
        <button className="danger lg" onClick={() => { if (confirm('Close this register and run the Z report?')) close(); }}>Close register & run Z</button>
      </div>}
      {preview && <SessionReportView data={preview} title="Preview" />}
    </div>
  );
}

export function ShiftHistory() {
  const [rows, setRows] = useState<any[]>([]);
  const [view, setView] = useState<any>(null);
  useEffect(() => { api.get('/reports/shifts').then(setRows); }, []);
  return (
    <div className="stack">
      <h1>X / Z Report History</h1>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Type</th><th>No.</th><th>Session</th><th>Created</th><th>By</th><th className="num">Net sales</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className="click" onClick={async () => setView(await api.get(`/reports/shifts/${r.id}`))}>
            <td><span className={`pill ${r.report_type === 'Z' ? 'bad' : 'info'}`}>{r.report_type}</span></td><td>#{r.report_no}</td><td>{r.pos_session_id}</td>
            <td>{dt(r.created_at)}</td><td>{r.created_by_name}</td><td className="num">{fmt(r.net_sales)}</td></tr>
        ))}</tbody></table></div>
      {view && <Modal title={`${view.report_type} report #${view.report_no}`} onClose={() => setView(null)} wide>
        <button className="primary no-print" onClick={() => window.print()}>Print</button>
        <SessionReportView data={view.data} title={`${view.report_type} Report #${view.report_no}`} />
      </Modal>}
    </div>
  );
}

export function MonthlyReport() {
  const { me } = useSession();
  const [month, setMonth] = useState(thisMonth());
  const [scope, setScope] = useState<string>('tenant');
  const [data, setData] = useState<any>(null);
  const ctx = me!.context!;
  useEffect(() => {
    const [kind, id] = scope.split(':');
    const q = kind === 'company' ? `&company_id=${id}` : kind === 'branch' ? `&branch_id=${id}` : '';
    api.get(`/reports/monthly?month=${month}${q}`).then(setData).catch(() => setData(null));
  }, [month, scope]);
  return (
    <div className="stack">
      <div className="row between no-print"><h1>Monthly Consolidated Sales</h1><button onClick={() => window.print()}>Print</button></div>
      <div className="row no-print">
        <label className="field">Month<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
        <label className="field">Scope<select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="tenant">Whole tenant (all my companies)</option>
          {ctx.companies.map((c) => <option key={c.id} value={`company:${c.id}`}>Company: {c.name}</option>)}
          {ctx.branches.map((b) => <option key={b.id} value={`branch:${b.id}`}>Branch: {b.company_name} — {b.name}</option>)}
        </select></label>
      </div>
      {data && (
        <div className="printable stack">
          <div className="small muted">Period {data.period.from} → {data.period.to} (branch local time). Amounts are in each company's base currency.</div>
          <div className="grid2">
            <div className="stat"><div className="l">Net sales</div><div className="v">{fmt(data.totals.net)}</div></div>
            <div className="stat"><div className="l">Tickets</div><div className="v">{data.totals.tickets}</div></div>
            <div className="stat"><div className="l">Guests</div><div className="v">{data.totals.guests}</div></div>
            <div className="stat"><div className="l">Discounts / refunds</div><div className="v">{fmt(data.totals.discounts)} / {fmt(data.totals.refunds)}</div></div>
          </div>
          <div className="report-section"><h2>All receipt channels</h2><T head={['Company', 'Channel', 'Type', 'Tickets', 'Total']} rows={data.by_channel.map((r: any) => [r.company, r.channel, r.channel_type, String(r.tickets), r.total])} /></div>
          <div className="report-section"><h2>By company</h2><T head={['Company', 'Currency', 'Tickets', 'Total']} rows={data.by_company.map((r: any) => [r.company, r.currency, String(r.tickets), r.total])} /></div>
          <div className="report-section"><h2>By branch</h2><T head={['Company', 'Branch', 'Tickets', 'Discounts', 'Refunds', 'Total']} rows={data.by_branch.map((r: any) => [r.company, r.branch, String(r.tickets), r.discounts, r.refunds, r.total])} /></div>
          <div className="report-section"><h2>By order type</h2><T head={['Type', 'Tickets', 'Total']} rows={data.by_order_type.map((r: any) => [ORDER_TYPES[r.order_type], String(r.tickets), r.total])} /></div>
          <div className="report-section"><h2>Payments</h2><T head={['Method', 'Currency', 'Amount', 'Base amount']} rows={data.payments.map((r: any) => [r.method, r.currency_code, r.amount, r.base_amount])} /></div>
          <div className="report-section"><h2>Delivery commission summary</h2><T head={['Company', 'Partner', 'Deliveries', 'Sales', 'Commission']} rows={data.delivery_commissions.map((r: any) => [r.company, r.delivery_company, String(r.deliveries), r.sales, r.commission])} /></div>
          <div className="report-section"><h2>Counter expenses</h2><T head={['Branch', 'Category', 'Total']} rows={data.expenses.map((r: any) => [r.branch, r.category, r.total])} /></div>
          <div className="report-section"><h2>Waste</h2><T head={['Branch', 'Reason', 'Entries', 'Cost']} rows={data.waste.map((r: any) => [r.branch, r.reason, String(r.entries), r.cost])} /></div>
          <div className="report-section"><h2>Cancellations</h2><T head={['Branch', 'Kind', 'Count', 'Amount']} rows={data.cancellations.map((r: any) => [r.branch, r.kind, String(r.count), r.amount])} /></div>
          <div className="report-section"><h2>Daily sales</h2><T head={['Day', 'Tickets', 'Total']} rows={data.by_day.map((r: any) => [String(r.day).slice(0, 10), String(r.tickets), r.total])} /></div>
        </div>
      )}
    </div>
  );
}
