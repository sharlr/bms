import { useT as useTr } from '../../i18n';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { BarChart, LineChart } from '../../components/Charts';
import { useT } from '../../i18n';
import { useSession } from '../../session';
import { fmt } from '../../util';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthRange = (offset: number) => {
  const n = new Date();
  const from = new Date(n.getFullYear(), n.getMonth() + offset, 1);
  const to = offset === 0 ? n : new Date(n.getFullYear(), n.getMonth() + offset + 1, 0);
  return { from: iso(from), to: iso(to) };
};

export function Dashboard() {
  const tr = useTr();
  const { tenant } = useParams();
  const { me, can } = useSession();
  const t = useT();
  const [range, setRange] = useState(monthRange(0));
  const [sel, setSel] = useState<number[] | null>(null); // null = all branches
  const [data, setData] = useState<any>(null);
  const [low, setLow] = useState<any[]>([]);
  const allowed = can('reports.monthly');

  useEffect(() => {
    if (!allowed) return;
    const b = sel?.length ? `&branch_ids=${sel.join(',')}` : '';
    api.get(`/reports/dashboard?from=${range.from}&to=${range.to}${b}`).then(setData).catch(() => setData(null));
  }, [range, sel, allowed]);
  useEffect(() => { api.get('/inventory/low-stock').then(setLow).catch(() => undefined); }, []);

  const h = new Date().getHours();
  const hello = t(h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening');
  const first = me?.user?.full_name.split(' ')[0];
  const days = Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / 86400000) + 1;
  const k = data?.kpis;
  const cur = data?.currencies?.length === 1 ? data.currencies[0] : '';
  const tiles: [string, number | undefined, string?][] = k ? [
    [t('Sales'), k.sales, `${k.tickets} ${t('tickets')} · ${k.days} ${t('days recorded')}`],
    [t('Net receipts'), k.net_receipts], [t('Net cash'), k.net_cash], [t('Counter Expenses'), k.counter_expenses],
    [t('Refunds'), k.refunds], [t('Discounts'), k.discounts], [t('Owed by clients'), k.owed_by_clients],
  ] : [];

  return (
    <div className="stack" style={{ gap: '1rem' }}>
      <div>
        <h1 style={{ fontSize: '1.6rem', marginBottom: '.2rem' }}>{hello} <span style={{ color: 'var(--brand)' }}>{first}</span>!</h1>
        <h2 style={{ marginBottom: '.1rem' }}>{t('Business overview')}</h2>
        <div className="muted small">{days} {tr(" days · ")}{sel?.length ? tr("{0} branch(es)", sel.length) : t('All branches')}</div>
      </div>

      {allowed && (
        <div className="card row" style={{ alignItems: 'flex-end' }}>
          <label className="field">{t('From')}<input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} /></label>
          <label className="field">{t('To')}<input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} /></label>
          <div className="field" style={{ minWidth: 240 }}>{t('Branch')}
            <label className="check small"><input type="checkbox" checked={!sel} onChange={(e) => setSel(e.target.checked ? null : [])} /> {t('All branches')}</label>
            {sel && (
              <select multiple size={Math.min(5, data?.branches?.length ?? 3)} value={sel.map(String)}
                onChange={(e) => setSel([...e.target.selectedOptions].map((o) => Number(o.value)))}>
                {(me?.context?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.company_name} — {b.name}</option>)}
              </select>
            )}
          </div>
          <button onClick={() => setRange(monthRange(0))}>{t('This Month')}</button>
          <button onClick={() => setRange(monthRange(-1))}>{t('Last Month')}</button>
        </div>
      )}

      {allowed && data && <>
        {data.currencies.length > 1 && <div className="card warn small">⚠ {t('Mixed currencies: totals add amounts in different currencies.')} ({data.currencies.join(', ')})</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '.8rem' }}>
          {tiles.map(([label, v, sub]) => (
            <div key={label} className="stat" style={{ borderTop: '3px solid var(--brand)' }}>
              <div className="l">{label}</div>
              <div className="v">{fmt(v)} <span className="small muted">{cur}</span></div>
              {sub && <div className="small muted">{sub}</div>}
            </div>
          ))}
        </div>
        <div className="dash-charts">
          <div className="card">
            <h3>{t('Daily sales trend')}</h3>
            {data.daily.length ? <LineChart label={t('Daily sales trend')} data={data.daily.map((d: any) => ({ x: d.day, y: d.total }))} />
              : <p className="muted">{t('No data in this period')}</p>}
          </div>
          <div className="card">
            <h3>{t('Sales by branch')}</h3>
            <BarChart label={t('Sales by branch')} data={data.by_branch.map((b: any) => ({ label: b.name, value: b.total }))} />
          </div>
        </div>
      </>}

      <div className="row">
        {can('pos.access') && <Link className="btn primary lg" to={`/${tenant}/pos`}>{t('Open POS terminal')}</Link>}
        {can('kds.view') && <Link className="btn lg" to={`/${tenant}/kds`}>{t('Kitchen Display')}</Link>}
        <a className="btn lg" href={`/${tenant}/order`} target="_blank" rel="noreferrer">{t('Online ordering page')} ↗</a>
      </div>
      {low.length > 0 && (
        <div className="card">
          <h3>{t('Low stock alerts')}</h3>
          <table className="data"><thead><tr><th>{tr("Ingredient")}</th><th className="num">{tr("On hand")}</th><th className="num">{tr("Minimum")}</th></tr></thead>
            <tbody>{low.map((l) => <tr key={l.ingredient_id}><td>{l.name}</td><td className="num bad">{l.qty} {l.unit}</td><td className="num">{l.min_qty}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}
