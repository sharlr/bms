import { useT as useTr } from '../../i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Modal, useAction } from '../../components/ui';
import { useSession } from '../../session';
import { dt, fmt, fmtQty, ORDER_TYPES, thisMonth } from '../../util';

const T = ({ head, rows }: { head: string[]; rows: (string | number | null | undefined)[][] }) => { const tr = useTr(); return ((
  <table className="data"><thead><tr>{head.map((h, i) => <th key={i} className={i > 0 && typeof rows[0]?.[i] === 'number' ? 'num' : ''}>{h}</th>)}</tr></thead>
    <tbody>{rows.length ? rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === 'number' ? 'num' : ''}>{typeof c === 'number' ? fmt(c) : c}</td>)}</tr>)
      : <tr><td colSpan={head.length} className="muted">{tr("None")}</td></tr>}</tbody></table>
)); };

/** Rendering of an X or Z report (shift / register session). */
export function SessionReportView({ data, title }: { data: any; title: string }) {
  const tr = useTr();
  const s = data.session;
  return (
    <div className="printable stack">
      <div className="card">
        <h1>{title}</h1>
        <div>{s.company} · {s.branch} [{s.branch_code}] · {s.register}</div>
        <div className="small muted">{tr("Opened ")}{dt(s.opened_at)} {tr(" by ")}{s.opened_by}{s.closed_at ? tr(" · Closed {0} by {1}", dt(s.closed_at), s.closed_by) : tr(" · register still open")} {tr(" · Currency ")}{s.currency}</div>
      </div>
      <div className="grid2">
        <div className="stat"><div className="l">{tr("Net sales")}</div><div className="v">{fmt(data.sales.net)}</div></div>
        <div className="stat"><div className="l">{tr("Tickets / guests")}</div><div className="v">{data.sales.tickets} / {data.sales.guests}</div></div>
        <div className="stat"><div className="l">{tr("Discounts")}</div><div className="v">{fmt(data.discounts.total)}</div></div>
        <div className="stat"><div className="l">{tr("Refunds")}</div><div className="v">{fmt(data.refunds.total)}</div></div>
        <div className="stat"><div className="l">{tr("Counter expenses")}</div><div className="v">{fmt(data.expenses.total)}</div></div>
        <div className="stat"><div className="l">{tr("Cancelled / voided")}</div><div className="v bad">{fmt(data.cancellations.total)}</div></div>
      </div>
      <div className="report-section"><h2>{tr("Sales summary")}</h2>
        <T head={['', tr("Amount")]} rows={[['Gross', data.sales.gross], ['Discounts', -data.sales.discounts], ['Tax', data.sales.tax], ['Net', data.sales.net], ['Credit sales', data.credit_sales]]} /></div>
      <div className="report-section"><h2>{tr("By order type")}</h2><T head={[tr("Type"), tr("Tickets"), tr("Total")]} rows={data.by_order_type.map((r: any) => [tr(ORDER_TYPES[r.order_type]), String(r.tickets), r.total])} /></div>
      <div className="report-section"><h2>{tr("By receipt channel")}</h2><T head={[tr("Channel"), tr("Tickets"), tr("Total")]} rows={data.by_channel.map((r: any) => [r.channel, String(r.tickets), r.total])} /></div>
      <div className="report-section"><h2>{tr("Payment modes & currencies")}</h2>
        <T head={[tr("Method"), tr("Currency"), tr("Count"), tr("Amount (currency)"), tr("Amount ({0})", s.currency)]} rows={data.payments.map((p: any) => [p.method, p.currency_code, String(p.count), p.amount, p.base_amount])} />
        <h3 style={{ marginTop: '.8rem' }}>{tr("Currency totals")}</h3>
        <T head={[tr("Currency"), tr("Received"), tr("Refunded"), tr("Net ({0})", s.currency)]} rows={data.currencies.map((c: any) => [c.currency_code, c.received ?? 0, c.refunded, c.net_base])} />
      </div>
      <div className="report-section"><h2>{tr("Cash drawer")}</h2>
        <T head={['', tr("Amount")]} rows={[['Opening float', data.cash.opening_float], ['+ Cash sales', data.cash.cash_sales], ['− Change given', data.cash.change_given],
          ['− Cash refunds', data.cash.cash_refunds], ['− Cash counter expenses', data.cash.cash_expenses], ['= Expected in drawer', data.cash.expected],
          ...(data.cash.counted != null ? [['Counted', data.cash.counted], ['Difference', data.cash.difference]] : [])]} /></div>
      <div className="report-section"><h2>{tr("Counter expenses")}</h2>
        <T head={[tr("Category"), tr("Description"), tr("Amount"), tr("Amount ({0})", s.currency), tr("Staff")]} rows={data.expenses.items.map((e: any) => [e.category, e.description, `${fmt(e.amount)} ${e.currency_code}`, e.base_amount, e.user_name])} /></div>
      <div className="report-section"><h2>{tr("Delivery company commissions")}</h2>
        <T head={[tr("Partner"), tr("Deliveries"), tr("Sales"), tr("Commission")]} rows={data.delivery_commissions.map((d: any) => [d.delivery_company, String(d.deliveries), d.sales, d.commission])} /></div>
      <div className="report-section"><h2>{tr("Discounts")}</h2>
        <T head={[tr("Ticket"), tr("Type"), tr("Coupon"), tr("Amount")]} rows={data.discounts.items.map((d: any) => [d.ticket_ref, d.discount_type === 'percent' ? `${d.discount_value}%` : 'fixed', d.coupon ?? '', d.discount_amount])} /></div>
      <div className="report-section"><h2>{tr("Refunds")}</h2>
        <T head={[tr("Ticket"), tr("Reason"), tr("Staff"), tr("Time"), tr("Amount")]} rows={data.refunds.items.map((r: any) => [r.ticket_ref, r.reason, r.user_name, dt(r.created_at), r.amount])} /></div>
      <div className="report-section"><h2>{tr("Cancelled lines (voids)")}</h2>
        <T head={[tr("Ticket"), tr("Item"), tr("Qty"), tr("Reason"), tr("By"), tr("Approved"), tr("Amount")]} rows={data.cancellations.lines.map((c: any) => [c.ticket_ref, c.item_name, fmtQty(c.qty), c.reason, c.user_name, c.approved_by, c.amount])} /></div>
      <div className="report-section"><h2>{tr("Cancelled tickets / cleared tables")}</h2>
        <T head={[tr("Ticket"), tr("Kind"), tr("Reason"), tr("By"), tr("Approved"), tr("Amount")]} rows={data.cancellations.tickets.map((c: any) => [c.ticket_ref, tr(c.kind === 'table_clear' ? 'Table cleared' : 'Ticket cancelled'), c.reason, c.user_name, c.approved_by, c.amount])} /></div>
      {data.open_tickets.count > 0 && <div className="card warn">⚠ {data.open_tickets.count} {tr(" ticket(s) still open in this branch (unpaid ")}{fmt(data.open_tickets.amount)}{tr(") — they must be settled or cancelled before the Z report.")}</div>}
      <div className="small muted">{tr("Generated ")}{dt(data.generated_at)}</div>
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
  const tr = useTr();
  if (!info?.open_sessions?.length) return <div className="card">{tr("No open register session in this branch.")}</div>;
  return (
    <div className="row">{tr("Register session")}<select style={{ maxWidth: 360 }} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
        {info.open_sessions.map((s: any) => <option key={s.id} value={s.id}>{info.registers.find((r: any) => r.id === s.register_id)?.name} {tr(" — opened ")}{dt(s.opened_at)} {tr(" by ")}{s.opened_by}</option>)}
      </select>
    </div>
  );
}

export function XReport() {
  const tr = useTr();
  const { info } = useSessionInfo();
  const [sid, setSid] = useState<number | null>(null);
  const [data, setData] = useState<any>(null);
  const run = useAction();
  useEffect(() => { if (info?.open_sessions?.[0] && !sid) setSid(info.open_sessions[0].id); }, [info, sid]);
  useEffect(() => { if (sid) api.get(`/reports/session?session_id=${sid}`).then(setData); }, [sid]);
  return (
    <div className="stack">
      <div className="row between no-print"><h1>{tr("X Report")}</h1>
        <button className="primary" disabled={!sid} onClick={async () => { const r = await run(() => api.post('/reports/x', { session_id: sid }), tr("X report recorded")); if (r) { setData(r.data); setTimeout(() => window.print(), 100); } }}>{tr("Record & print X report")}</button></div>
      <p className="muted no-print">{tr("Mid-shift status of the register without closing it.")}</p>
      <div className="no-print"><SessionPicker info={info} value={sid} onChange={setSid} /></div>
      {data && <SessionReportView data={data} title={tr("X Report (register remains open)")} />}
    </div>
  );
}

export function ZReport() {
  const tr = useTr();
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
    <div className="stack"><div className="row no-print"><button className="primary" onClick={() => window.print()}>{tr("Print Z report #")}{result.report_no}</button><button onClick={() => setResult(null)}>{tr("Done")}</button></div>
      <SessionReportView data={result.data} title={tr("Z Report #{0} — End of day", result.report_no)} /></div>
  );
  return (
    <div className="stack">
      <h1>{tr("Z Report — close register")}</h1>
      <p className="muted">{tr("Closes the register session and produces the end-of-day report: sales, payment modes, currencies, counter expenses, delivery commissions, discounts, refunds and all cancelled lines/tickets.")}</p>
      <SessionPicker info={info} value={sid} onChange={setSid} />
      {sid && <div className="card row">
        <label className="field">{tr("Counted cash in drawer (")}{preview?.session.currency})<input type="number" step="any" value={counted} onChange={(e) => setCounted(e.target.value)} /></label>
        <div>{tr("Expected: ")}<b>{fmt(preview?.cash.expected)}</b></div>
        <button className="danger lg" onClick={() => { if (confirm(tr("Close this register and run the Z report?"))) close(); }}>{tr("Close register & run Z")}</button>
      </div>}
      {preview && <SessionReportView data={preview} title={tr("Preview")} />}
    </div>
  );
}

export function ShiftHistory() {
  const tr = useTr();
  const [rows, setRows] = useState<any[]>([]);
  const [view, setView] = useState<any>(null);
  useEffect(() => { api.get('/reports/shifts').then(setRows); }, []);
  return (
    <div className="stack">
      <h1>{tr("X / Z Report History")}</h1>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>{tr("Type")}</th><th>{tr("No.")}</th><th>{tr("Session")}</th><th>{tr("Created")}</th><th>{tr("By")}</th><th className="num">{tr("Net sales")}</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className="click" onClick={async () => setView(await api.get(`/reports/shifts/${r.id}`))}>
            <td><span className={`pill ${r.report_type === 'Z' ? 'bad' : 'info'}`}>{r.report_type}</span></td><td>#{r.report_no}</td><td>{r.pos_session_id}</td>
            <td>{dt(r.created_at)}</td><td>{r.created_by_name}</td><td className="num">{fmt(r.net_sales)}</td></tr>
        ))}</tbody></table></div>
      {view && <Modal title={tr("{0} report #{1}", view.report_type, view.report_no)} onClose={() => setView(null)} wide>
        <button className="primary no-print" onClick={() => window.print()}>{tr("Print")}</button>
        <SessionReportView data={view.data} title={tr("{0} Report #{1}", view.report_type, view.report_no)} />
      </Modal>}
    </div>
  );
}

export function MonthlyReport() {
  const tr = useTr();
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
      <div className="row between no-print"><h1>{tr("Monthly Consolidated Sales")}</h1><button onClick={() => window.print()}>{tr("Print")}</button></div>
      <div className="row no-print">
        <label className="field">{tr("Month")}<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
        <label className="field">{tr("Scope")}<select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="tenant">{tr("Whole tenant (all my companies)")}</option>
          {ctx.companies.map((c) => <option key={c.id} value={`company:${c.id}`}>{tr("Company: ")}{c.name}</option>)}
          {ctx.branches.map((b) => <option key={b.id} value={`branch:${b.id}`}>{tr("Branch: ")}{b.company_name} — {b.name}</option>)}
        </select></label>
      </div>
      {data && (
        <div className="printable stack">
          <div className="small muted">{tr("Period ")}{data.period.from} → {data.period.to} {tr(" (branch local time). Amounts are in each company's base currency.")}</div>
          <div className="grid2">
            <div className="stat"><div className="l">{tr("Net sales")}</div><div className="v">{fmt(data.totals.net)}</div></div>
            <div className="stat"><div className="l">{tr("Tickets")}</div><div className="v">{data.totals.tickets}</div></div>
            <div className="stat"><div className="l">{tr("Guests")}</div><div className="v">{data.totals.guests}</div></div>
            <div className="stat"><div className="l">{tr("Discounts / refunds")}</div><div className="v">{fmt(data.totals.discounts)} / {fmt(data.totals.refunds)}</div></div>
          </div>
          <div className="report-section"><h2>{tr("All receipt channels")}</h2><T head={[tr("Company"), tr("Channel"), tr("Type"), tr("Tickets"), tr("Total")]} rows={data.by_channel.map((r: any) => [r.company, r.channel, r.channel_type, String(r.tickets), r.total])} /></div>
          <div className="report-section"><h2>{tr("By company")}</h2><T head={[tr("Company"), tr("Currency"), tr("Tickets"), tr("Total")]} rows={data.by_company.map((r: any) => [r.company, r.currency, String(r.tickets), r.total])} /></div>
          <div className="report-section"><h2>{tr("By branch")}</h2><T head={[tr("Company"), tr("Branch"), tr("Tickets"), tr("Discounts"), tr("Refunds"), tr("Total")]} rows={data.by_branch.map((r: any) => [r.company, r.branch, String(r.tickets), r.discounts, r.refunds, r.total])} /></div>
          <div className="report-section"><h2>{tr("By order type")}</h2><T head={[tr("Type"), tr("Tickets"), tr("Total")]} rows={data.by_order_type.map((r: any) => [tr(ORDER_TYPES[r.order_type]), String(r.tickets), r.total])} /></div>
          <div className="report-section"><h2>{tr("Payments")}</h2><T head={[tr("Method"), tr("Currency"), tr("Amount"), tr("Base amount")]} rows={data.payments.map((r: any) => [r.method, r.currency_code, r.amount, r.base_amount])} /></div>
          <div className="report-section"><h2>{tr("Delivery commission summary")}</h2><T head={[tr("Company"), tr("Partner"), tr("Deliveries"), tr("Sales"), tr("Commission")]} rows={data.delivery_commissions.map((r: any) => [r.company, r.delivery_company, String(r.deliveries), r.sales, r.commission])} /></div>
          <div className="report-section"><h2>{tr("Counter expenses")}</h2><T head={[tr("Branch"), tr("Category"), tr("Total")]} rows={data.expenses.map((r: any) => [r.branch, r.category, r.total])} /></div>
          <div className="report-section"><h2>{tr("Waste")}</h2><T head={[tr("Branch"), tr("Reason"), tr("Entries"), tr("Cost")]} rows={data.waste.map((r: any) => [r.branch, r.reason, String(r.entries), r.cost])} /></div>
          <div className="report-section"><h2>{tr("Cancellations")}</h2><T head={[tr("Branch"), tr("Kind"), tr("Count"), tr("Amount")]} rows={data.cancellations.map((r: any) => [r.branch, r.kind, String(r.count), r.amount])} /></div>
          <div className="report-section"><h2>{tr("Daily sales")}</h2><T head={[tr("Day"), tr("Tickets"), tr("Total")]} rows={data.by_day.map((r: any) => [String(r.day).slice(0, 10), String(r.tickets), r.total])} /></div>
        </div>
      )}
    </div>
  );
}
