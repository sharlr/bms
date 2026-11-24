import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useAction } from '../../components/ui';
import { useSession } from '../../session';
import { dt, fmt, today } from '../../util';

export function ExchangeRates() {
  const { can, me, branchId } = useSession();
  const [data, setData] = useState<any>(null);
  const [currencies, setCurrencies] = useState<any[]>([]);
  const [f, setF] = useState({ currency_code: 'USD', rate: '', scope: 'company' });
  const run = useAction();
  const load = useCallback(() => api.get('/rates').then(setData), []);
  useEffect(() => { load(); api.get('/currencies').then(setCurrencies); }, [load]);
  if (!data) return null;
  const branch = me?.context?.branches.find((b) => b.id === branchId);
  return (
    <div className="stack">
      <h1>Exchange Rates</h1>
      <p className="muted">Manual rates for <b>{branch?.company_name}</b>. Base currency: <b>{data.base_currency}</b>. 1 unit of foreign currency = rate × {data.base_currency}.
        Branch-specific rates override company rates.</p>
      {can('rates.manage') && (
        <div className="card row">
          <label className="field">Currency<select value={f.currency_code} onChange={(e) => setF({ ...f, currency_code: e.target.value })}>
            {currencies.filter((c) => c.code !== data.base_currency).map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}</select></label>
          <label className="field">Rate (in {data.base_currency})<input type="number" step="any" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></label>
          <label className="field">Applies to<select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
            <option value="company">Whole company</option><option value="branch">This branch only ({branch?.name})</option></select></label>
          <button className="primary" disabled={!Number(f.rate)} onClick={async () => {
            if (await run(() => api.post('/rates', { currency_code: f.currency_code, rate: Number(f.rate), branch_id: f.scope === 'branch' ? branchId : null }), 'Rate saved')) { setF({ ...f, rate: '' }); load(); }
          }}>Set rate</button>
        </div>
      )}
      <h2>Current rates</h2>
      <div className="table-wrap"><table className="data"><thead><tr><th>Currency</th><th className="num">Rate</th><th>Scope</th><th>Since</th></tr></thead>
        <tbody>{data.current.map((r: any) => <tr key={r.id}><td>{r.currency_code}</td><td className="num">{r.rate}</td><td>{r.branch_name ?? 'Company'}</td><td>{dt(r.effective_from)}</td></tr>)}</tbody></table></div>
      <h2>History</h2>
      <div className="table-wrap"><table className="data"><thead><tr><th>Currency</th><th className="num">Rate</th><th>Scope</th><th>Effective</th><th>By</th></tr></thead>
        <tbody>{data.history.map((r: any) => <tr key={r.id}><td>{r.currency_code}</td><td className="num">{r.rate}</td><td>{r.branch_name ?? 'Company'}</td><td>{dt(r.effective_from)}</td><td>{r.created_by_name}</td></tr>)}</tbody></table></div>
    </div>
  );
}

export function Expenses() {
  const { can, currency } = useSession();
  const [rows, setRows] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [f, setF] = useState<any>({ category_id: null, description: '', amount: '', currency_code: '', paid_from_cash: true });
  const [rates, setRates] = useState<any>({ current: [] });
  const run = useAction();
  const load = useCallback(() => api.get(`/expenses?from=${from}&to=${to}`).then(setRows), [from, to]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/expense-categories').then((c) => { setCats(c.filter((x: any) => x.active)); setF((v: any) => ({ ...v, category_id: c[0]?.id })); }); api.get('/rates').then(setRates); }, []);
  const total = rows.filter((r) => !r.voided_at).reduce((s, r) => s + r.base_amount, 0);
  return (
    <div className="stack">
      <h1>Counter Expenses</h1>
      <div className="card stack">
        <b>Record petty cash paid from the register</b>
        <div className="row">
          <label className="field">Category<select value={f.category_id ?? ''} onChange={(e) => setF({ ...f, category_id: Number(e.target.value) })}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field grow">Description<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label className="field">Amount<input type="number" step="any" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
          <label className="field">Currency<select value={f.currency_code} onChange={(e) => setF({ ...f, currency_code: e.target.value })}>
            <option value="">{currency}</option>{rates.current.map((r: any) => <option key={r.id} value={r.currency_code}>{r.currency_code}</option>)}</select></label>
          <label className="check"><input type="checkbox" checked={f.paid_from_cash} onChange={(e) => setF({ ...f, paid_from_cash: e.target.checked })} /> Paid from cash drawer</label>
          <button className="primary" disabled={!f.description || !Number(f.amount)} onClick={async () => {
            if (await run(() => api.post('/expenses', { ...f, amount: Number(f.amount), currency_code: f.currency_code || undefined }), 'Expense recorded')) { setF({ ...f, description: '', amount: '' }); load(); }
          }}>Record</button>
        </div>
      </div>
      <div className="row"><label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label><b>Total: {fmt(total, currency)}</b></div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Time</th><th>Category</th><th>Description</th><th className="num">Amount</th><th className="num">Base</th><th>Staff</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className={r.voided_at ? 'muted' : ''}><td>{dt(r.created_at)}</td><td>{r.category_name}</td><td>{r.description}{r.voided_at && <span className="pill bad">void</span>}</td>
            <td className="num">{fmt(r.amount, r.currency_code)}</td><td className="num">{fmt(r.base_amount)}</td><td>{r.user_name}</td>
            <td>{!r.voided_at && can('expenses.void') && <button className="sm" onClick={async () => { if (confirm('Void this expense?') && await run(() => api.post(`/expenses/${r.id}/void`, {}))) load(); }}>Void</button>}</td></tr>
        ))}</tbody></table></div>
    </div>
  );
}

export function CommissionReport() {
  const { currency } = useSession();
  const [from, setFrom] = useState(today().slice(0, 8) + '01');
  const [to, setTo] = useState(today());
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get(`/delivery/commissions?from=${from}&to=${to}`).then(setRows); }, [from, to]);
  const byCo = rows.reduce<Record<string, number>>((m, r) => ((m[r.delivery_company_name] = (m[r.delivery_company_name] ?? 0) + r.amount), m), {});
  return (
    <div className="stack">
      <h1>Delivery Commissions</h1>
      <div className="row"><label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>
      <div className="grid2">{Object.entries(byCo).map(([k, v]) => <div key={k} className="stat"><div className="l">{k}</div><div className="v">{fmt(v, currency)}</div></div>)}</div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Date</th><th>Ticket</th><th>Partner</th><th>Basis</th><th>Rule</th><th className="num">Base</th><th className="num">Commission</th><th>Note</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td>{dt(r.created_at)}</td><td>{r.ticket_ref}</td><td>{r.delivery_company_name}</td><td>{r.basis}</td>
            <td>{r.commission_type === 'percent' ? `${r.rule_value}%` : fmt(r.rule_value)}</td><td className="num">{fmt(r.base_amount)}</td>
            <td className="num"><b>{fmt(r.amount)}</b></td><td className="small">{r.note}</td></tr>
        ))}</tbody></table></div>
    </div>
  );
}
