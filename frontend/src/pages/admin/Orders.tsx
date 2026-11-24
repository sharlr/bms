import { useT as useTr } from '../../i18n';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Receipt } from '../../components/Receipt';
import { Modal } from '../../components/ui';
import { dt, fmt, ORDER_TYPES, today } from '../../util';

export function Orders() {
  const tr = useTr();
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState({ date: today(), status: '', order_type: '', q: '' });
  const [view, setView] = useState<any>(null);
  useEffect(() => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    api.get(`/pos/tickets?${p}`).then(setRows);
  }, [q]);
  return (
    <div className="stack">
      <h1>{tr("Orders / Tickets")}</h1>
      <div className="row">
        <label className="field">{tr("Date")}<input type="date" value={q.date} onChange={(e) => setQ({ ...q, date: e.target.value })} /></label>
        <label className="field">{tr("Status")}<select value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value })}>
          <option value="">{tr("All")}</option>{['pending', 'open', 'paid', 'cancelled'].map((s) => <option key={s}>{s}</option>)}</select></label>
        <label className="field">{tr("Type")}<select value={q.order_type} onChange={(e) => setQ({ ...q, order_type: e.target.value })}>
          <option value="">{tr("All")}</option>{Object.entries(ORDER_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field">{tr("Search")}<input value={q.q} onChange={(e) => setQ({ ...q, q: e.target.value })} placeholder={tr("Ref, name, phone")} /></label>
      </div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>{tr("Ticket")}</th><th>{tr("Opened")}</th><th>{tr("Type")}</th><th>{tr("Channel")}</th><th>{tr("Table / Customer")}</th><th>{tr("Status")}</th><th className="num">{tr("Total")}</th><th className="num">{tr("Paid")}</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className="click" onClick={async () => setView(await api.get(`/pos/tickets/${r.id}/receipt`))}>
            <td><b>{r.ticket_ref}</b></td><td>{dt(r.opened_at)}</td><td>{tr(ORDER_TYPES[r.order_type])}</td><td>{r.channel_name}</td>
            <td>{r.table_name ?? r.customer_name}{r.delivery_company_name ? ` · ${r.delivery_company_name}` : ''}</td>
            <td><span className={`pill ${r.status === 'paid' ? 'ok' : r.status === 'cancelled' ? 'bad' : 'warn'}`}>{r.status}</span>{r.refund_status !== 'none' && <span className="pill info">{tr("refund ")}{r.refund_status}</span>}</td>
            <td className="num">{fmt(r.total)}</td><td className="num">{fmt(r.paid_amount)}</td>
          </tr>
        ))}</tbody></table></div>
      {view && (
        <Modal title={view.ticket.ticket_ref} onClose={() => setView(null)}>
          <div className="printable"><Receipt data={view} /></div>
          <div className="row no-print" style={{ justifyContent: 'center', marginTop: '1rem' }}><button className="primary" onClick={() => window.print()}>{tr("Print")}</button></div>
        </Modal>
      )}
    </div>
  );
}
