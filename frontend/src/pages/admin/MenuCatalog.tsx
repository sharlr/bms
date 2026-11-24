import { useT as useTr } from '../../i18n';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Loading } from '../../components/ui';
import { useSession } from '../../session';
import { fmt, ORDER_TYPES } from '../../util';

const TYPES = ['dine_in', 'takeaway', 'delivery'] as const;

/** Read-only menu overview for the active branch: the price each order type actually charges (same resolution as the POS). */
export function MenuCatalog() {
  const tr = useTr();
  const { currency } = useSession();
  const [menus, setMenus] = useState<Record<string, any> | null>(null);
  const [cat, setCat] = useState<number | ''>('');
  useEffect(() => {
    Promise.all(TYPES.map((t) => api.get(`/menu/palette?order_type=${t}`))).then((r) => setMenus(Object.fromEntries(TYPES.map((t, i) => [t, r[i]]))));
  }, []);
  if (!menus) return <Loading />;
  const base = menus.dine_in;
  // An item may be priced for some order types only, so list the union of items.
  const items = new Map<number, any>();
  for (const t of TYPES) for (const i of menus[t].items) if (!items.has(i.id)) items.set(i.id, i);
  const priceOf = (t: string, itemId: number, sizeId: number | null) => {
    const i = menus[t].items.find((x: any) => x.id === itemId);
    if (!i) return null;
    return sizeId ? i.sizes.find((s: any) => s.id === sizeId)?.price ?? null : i.price;
  };
  const categories = base.categories.filter((c: any) => [...items.values()].some((i) => i.category_id === c.id) && (!cat || c.id === cat));

  return (
    <div className="stack">
      <div className="row between">
        <h1>{tr("Menu Overview")}</h1>
        <select style={{ maxWidth: 260 }} value={cat} onChange={(e) => setCat(e.target.value ? Number(e.target.value) : '')}>
          <option value="">{tr("All categories")}</option>
          {base.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <p className="muted small">{tr("Prices for the branch selected in the top bar (")}{currency}{tr("). Edit them under Menu → Items, Sizes & Prices.")}</p>
      {categories.map((c: any) => (
        <div key={c.id} className="card stack">
          <h2 style={{ borderLeft: `6px solid ${c.color}`, paddingLeft: '.5rem' }}>{c.name}</h2>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th /><th>{tr("Item")}</th><th>{tr("Size")}</th>{TYPES.map((t) => <th key={t} className="num">{tr(ORDER_TYPES[t])}</th>)}</tr></thead>
              <tbody>
                {[...items.values()].filter((i) => i.category_id === c.id).flatMap((i) => {
                  const sizes: (any | null)[] = i.sizes.length ? i.sizes : [null];
                  return sizes.map((s, n) => (
                    <tr key={`${i.id}-${s?.id ?? 0}`}>
                      {n === 0 && <td rowSpan={sizes.length} style={{ width: 84 }}>{i.image_url ? <img className="thumb" src={i.image_url} alt={i.name} /> : <div className="thumb" style={{ background: '#e2e8f0' }} />}</td>}
                      {n === 0 && <td rowSpan={sizes.length}><b>{i.name}</b>
                        {i.description && <div className="small muted">{i.description}</div>}
                        {i.allergens?.length > 0 && <div className="small warn">{tr("Allergens: ")}{i.allergens.join(', ')}</div>}</td>}
                      <td>{s?.name ?? '—'}</td>
                      {TYPES.map((t) => { const p = priceOf(t, i.id, s?.id ?? null); return <td key={t} className="num">{p == null ? <span className="muted">{tr("n/a")}</span> : fmt(p)}</td>; })}
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {categories.length === 0 && <div className="card muted">{tr("No priced items yet.")}</div>}
    </div>
  );
}
