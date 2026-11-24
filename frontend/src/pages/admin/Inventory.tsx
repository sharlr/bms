import { useT as useTr } from '../../i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Modal, useAction } from '../../components/ui';
import { useSession } from '../../session';
import { dt, fmt, fmtQty, today } from '../../util';

export function Stock() {
  const tr = useTr();
  const { can, currency } = useSession();
  const [rows, setRows] = useState<any[]>([]);
  const [adj, setAdj] = useState<any>(null);
  const run = useAction();
  const load = useCallback(() => api.get('/inventory/stock').then(setRows), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="stack">
      <h1>{tr("Branch Stock")}</h1>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>{tr("Ingredient")}</th><th className="num">{tr("On hand")}</th><th className="num">{tr("Minimum")}</th><th className="num">{tr("Value")}</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.ingredient_id}><td>{r.name}{r.low && <span className="pill bad">{tr("LOW")}</span>}</td>
            <td className={`num ${r.low ? 'bad' : ''}`}>{fmtQty(r.qty)} {r.unit}</td><td className="num">{fmtQty(r.min_qty)}</td><td className="num">{fmt(r.value, currency)}</td>
            <td className="right">{can('inventory.manage') && <div className="row nowrap" style={{ justifyContent: 'flex-end' }}>
              <button className="sm" onClick={() => setAdj({ ...r, kind: 'purchase', qty: '', unit_cost: r.cost_per_unit, note: '' })}>{tr("Receive")}</button>
              <button className="sm" onClick={() => setAdj({ ...r, kind: 'adjustment', counted: String(r.qty), note: '' })}>{tr("Count")}</button>
              <button className="sm" onClick={async () => { const v = prompt(tr("Minimum for {0} ({1})", r.name, r.unit), String(r.min_qty)); if (v !== null && await run(() => api.put(`/inventory/stock/${r.ingredient_id}/min`, { min_qty: Number(v) }))) load(); }}>{tr("Min")}</button>
            </div>}</td></tr>
        ))}</tbody></table></div>
      {adj && (
        <Modal title={`${adj.kind === 'purchase' ? 'Receive stock' : 'Stock count'} — ${adj.name}`} onClose={() => setAdj(null)}>
          <div className="stack">
            {adj.kind === 'purchase' ? <>
              <label className="field">{tr("Quantity received (")}{adj.unit})<input type="number" step="any" value={adj.qty} onChange={(e) => setAdj({ ...adj, qty: e.target.value })} /></label>
              <label className="field">{tr("Unit cost")}<input type="number" step="any" value={adj.unit_cost} onChange={(e) => setAdj({ ...adj, unit_cost: e.target.value })} /></label>
            </> : <label className="field">{tr("Counted quantity (")}{adj.unit})<input type="number" step="any" value={adj.counted} onChange={(e) => setAdj({ ...adj, counted: e.target.value })} /></label>}
            <label className="field">{tr("Note")}<input value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} /></label>
            <button className="primary" onClick={async () => {
              const body = adj.kind === 'purchase'
                ? { ingredient_id: adj.ingredient_id, kind: 'purchase', qty_change: Number(adj.qty), unit_cost: Number(adj.unit_cost), note: adj.note || undefined }
                : { ingredient_id: adj.ingredient_id, kind: 'adjustment', counted_qty: Number(adj.counted), note: adj.note || undefined };
              if (await run(() => api.post('/inventory/stock/adjust', body), tr("Stock updated"))) { setAdj(null); load(); }
            }}>{tr("Save")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function Recipes() {
  const tr = useTr();
  const { can, currency } = useSession();
  const [items, setItems] = useState<any[]>([]);
  const [ings, setIngs] = useState<any[]>([]);
  const [recipes, setRecipes] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const run = useAction();
  const load = useCallback(() => api.get('/inventory/recipes').then(setRecipes), []);
  useEffect(() => { load(); api.get('/menu/items').then(setItems); api.get('/inventory/ingredients').then((r) => setIngs(r.filter((x: any) => x.active))); }, [load]);
  const item = items.find((i) => i.id === edit?.menu_item_id);
  return (
    <div className="stack">
      <div className="row between"><h1>{tr("Recipes")}</h1>
        {can('inventory.manage') && <button className="primary" onClick={() => setEdit({ menu_item_id: items[0]?.id, size_id: null, lines: [] })}>{tr("+ Recipe")}</button>}</div>
      <p className="muted">{tr("Recipes link a menu item (optionally a specific size) to exact ingredient quantities. Stock is deducted only for items with ")}<b>{tr("“Deduct stock”")}</b> {tr(" enabled.")}</p>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>{tr("Item")}</th><th>{tr("Size")}</th><th>{tr("Ingredients")}</th><th className="num">{tr("Cost")}</th><th>{tr("Stock impact")}</th></tr></thead>
        <tbody>{recipes.map((r) => {
          const it = items.find((i) => i.id === r.menu_item_id);
          return (
            <tr key={r.id} className="click" onClick={() => can('inventory.manage') && setEdit({ menu_item_id: r.menu_item_id, size_id: r.size_id, lines: r.lines.map((l: any) => ({ ingredient_id: l.ingredient_id, qty: l.qty })), id: r.id })}>
              <td>{r.item_name}</td><td>{r.size_name ?? tr("All sizes")}</td>
              <td className="small">{r.lines.map((l: any) => `${fmtQty(l.qty)}${l.unit} ${l.ingredient_name}`).join(', ')}</td>
              <td className="num">{fmt(r.cost, currency)}</td>
              <td>{it?.tracks_stock ? <span className="pill ok">{tr("Deducts")}</span> : <span className="pill warn">{tr("Off")}</span>}</td>
            </tr>
          );
        })}</tbody></table></div>
      {edit && (
        <Modal title={tr("Recipe")} onClose={() => setEdit(null)}>
          <div className="stack">
            <div className="grid2">
              <label className="field">{tr("Menu item")}<select value={edit.menu_item_id} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, menu_item_id: Number(e.target.value), size_id: null })}>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
              <label className="field">{tr("Size")}<select value={edit.size_id ?? ''} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, size_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{tr("All sizes")}</option>{item?.sizes.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            </div>
            {item && !item.tracks_stock && <div className="warn small">{tr("This item's “Deduct stock” toggle is off — the recipe is stored but stock won't move. Enable it under Menu → Items.")}</div>}
            {edit.lines.map((l: any, i: number) => (
              <div key={i} className="row nowrap">
                <select value={l.ingredient_id} onChange={(e) => setEdit({ ...edit, lines: edit.lines.map((x: any, j: number) => (j === i ? { ...x, ingredient_id: Number(e.target.value) } : x)) })}>
                  {ings.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.unit})</option>)}</select>
                <input type="number" step="any" style={{ width: 120 }} value={l.qty} onChange={(e) => setEdit({ ...edit, lines: edit.lines.map((x: any, j: number) => (j === i ? { ...x, qty: e.target.value } : x)) })} />
                <button className="sm" onClick={() => setEdit({ ...edit, lines: edit.lines.filter((_: any, j: number) => j !== i) })}>✕</button>
              </div>
            ))}
            <button onClick={() => setEdit({ ...edit, lines: [...edit.lines, { ingredient_id: ings[0]?.id, qty: '' }] })}>{tr("+ Ingredient")}</button>
            <div className="row between">
              {edit.id ? <button className="danger" onClick={async () => { if (confirm(tr("Delete recipe?")) && await run(() => api.del(`/inventory/recipes/${edit.id}`))) { setEdit(null); load(); } }}>{tr("Delete")}</button> : <span />}
              <button className="primary" onClick={async () => {
                const body = { menu_item_id: edit.menu_item_id, size_id: edit.size_id, lines: edit.lines.filter((l: any) => Number(l.qty) > 0).map((l: any) => ({ ingredient_id: l.ingredient_id, qty: Number(l.qty) })) };
                if (await run(() => api.put('/inventory/recipes', body), tr("Recipe saved"))) { setEdit(null); load(); }
              }}>{tr("Save")}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function Movements() {
  const tr = useTr();
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState({ ticket_ref: '', kind: '', from: today(), to: today() });
  useEffect(() => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    api.get(`/inventory/movements?${p}`).then(setRows);
  }, [q]);
  return (
    <div className="stack">
      <h1>{tr("Stock Ledger")}</h1>
      <div className="row">
        <label className="field">{tr("Ticket ref")}<input value={q.ticket_ref} onChange={(e) => setQ({ ...q, ticket_ref: e.target.value.toUpperCase() })} placeholder={tr("e.g. WL-000123")} /></label>
        <label className="field">{tr("Kind")}<select value={q.kind} onChange={(e) => setQ({ ...q, kind: e.target.value })}>
          <option value="">{tr("All")}</option>{['sale', 'sale_reversal', 'refund_return', 'purchase', 'adjustment', 'waste', 'opening'].map((k) => <option key={k}>{k}</option>)}</select></label>
        <label className="field">{tr("From")}<input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></label>
        <label className="field">{tr("To")}<input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></label>
      </div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>{tr("Time")}</th><th>{tr("Ingredient")}</th><th>{tr("Kind")}</th><th className="num">{tr("Change")}</th><th className="num">{tr("Balance")}</th><th>{tr("POS Ticket")}</th><th>{tr("Staff")}</th><th>{tr("Note")}</th></tr></thead>
        <tbody>{rows.map((m) => (
          <tr key={m.id}><td>{dt(m.created_at)}</td><td>{m.ingredient_name}</td><td><span className="pill">{m.kind}</span></td>
            <td className={`num ${m.qty_change < 0 ? 'bad' : 'ok'}`}>{m.qty_change > 0 ? '+' : ''}{fmtQty(m.qty_change)} {m.unit}</td>
            <td className="num">{fmtQty(m.balance_after)}</td><td><b>{m.ticket_ref}</b></td><td>{m.user_name}</td><td className="small">{m.note}</td></tr>
        ))}</tbody></table></div>
    </div>
  );
}

export function LowStock() {
  const tr = useTr();
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get('/inventory/low-stock').then(setRows); }, []);
  return (
    <div className="stack">
      <h1>{tr("Low Stock Alerts")}</h1>
      <p className="muted">{tr("Ingredients below their branch minimum — reorder soon. Terminals also get live alerts when an order pushes an ingredient below its minimum.")}</p>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>{tr("Ingredient")}</th><th className="num">{tr("On hand")}</th><th className="num">{tr("Minimum")}</th><th className="num">{tr("Shortfall")}</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.ingredient_id}><td>{r.name}</td><td className="num bad">{fmtQty(r.qty)} {r.unit}</td><td className="num">{fmtQty(r.min_qty)}</td><td className="num">{fmtQty(r.min_qty - r.qty)}</td></tr>)}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">{tr("Nothing below minimum 👍")}</td></tr>}</tbody></table></div>
    </div>
  );
}

export function Waste() {
  const tr = useTr();
  const { can, currency } = useSession();
  const [rows, setRows] = useState<any[]>([]);
  const [ings, setIngs] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [f, setF] = useState<any>({ what: 'ingredient', ingredient_id: null, menu_item_id: null, size_id: null, qty: '', reason: 'spoiled', notes: '', deducts_stock: true });
  const [from, setFrom] = useState(today().slice(0, 8) + '01');
  const run = useAction();
  const load = useCallback(() => api.get(`/waste?from=${from}`).then(setRows), [from]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/inventory/ingredients').then((r) => setIngs(r.filter((x: any) => x.active))); api.get('/menu/items').then(setItems); }, []);
  const item = items.find((i) => i.id === f.menu_item_id);
  return (
    <div className="stack">
      <h1>{tr("Waste Management")}</h1>
      {can('waste.record') && (
        <div className="card stack">
          <b>{tr("Record spilled, damaged or spoiled food")}</b>
          <div className="row">
            <select style={{ width: 160 }} value={f.what} onChange={(e) => setF({ ...f, what: e.target.value })}><option value="ingredient">{tr("Ingredient")}</option><option value="item">{tr("Menu item")}</option></select>
            {f.what === 'ingredient' ? (
              <select style={{ width: 220 }} value={f.ingredient_id ?? ''} onChange={(e) => setF({ ...f, ingredient_id: Number(e.target.value) })}><option value="">{tr("— ingredient —")}</option>{ings.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.unit})</option>)}</select>
            ) : <>
              <select style={{ width: 220 }} value={f.menu_item_id ?? ''} onChange={(e) => setF({ ...f, menu_item_id: Number(e.target.value), size_id: null })}><option value="">{tr("— item —")}</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
              {item?.sizes.length > 0 && <select style={{ width: 140 }} value={f.size_id ?? ''} onChange={(e) => setF({ ...f, size_id: Number(e.target.value) || null })}><option value="">{tr("size")}</option>{item.sizes.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
            </>}
            <input style={{ width: 110 }} type="number" step="any" placeholder={tr("Qty")} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
            <select style={{ width: 150 }} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{['spilled', 'damaged', 'spoiled', 'expired', 'overcooked', 'other'].map((r) => <option key={r}>{r}</option>)}</select>
            <input style={{ width: 220 }} placeholder={tr("Notes")} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            <label className="check"><input type="checkbox" checked={f.deducts_stock} onChange={(e) => setF({ ...f, deducts_stock: e.target.checked })} /> {tr(" Deduct from stock")}</label>
            <button className="primary" disabled={!Number(f.qty) || (f.what === 'ingredient' ? !f.ingredient_id : !f.menu_item_id)} onClick={async () => {
              const body = { ...(f.what === 'ingredient' ? { ingredient_id: f.ingredient_id } : { menu_item_id: f.menu_item_id, size_id: f.size_id }), qty: Number(f.qty), reason: f.reason, notes: f.notes || null, deducts_stock: f.deducts_stock };
              if (await run(() => api.post('/waste', body), tr("Waste recorded"))) { setF({ ...f, qty: '', notes: '' }); load(); }
            }}>{tr("Record")}</button>
          </div>
        </div>
      )}
      <div className="row"><label className="field">{tr("Since")}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <b>{tr("Total loss: ")}{fmt(rows.reduce((s, r) => s + r.cost_amount, 0), currency)}</b></div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>{tr("Time")}</th><th>{tr("What")}</th><th className="num">{tr("Qty")}</th><th>{tr("Reason")}</th><th className="num">{tr("Cost")}</th><th>{tr("Staff")}</th><th>{tr("Notes")}</th></tr></thead>
        <tbody>{rows.map((w) => (
          <tr key={w.id}><td>{dt(w.created_at)}</td><td>{w.ingredient_name ?? `${w.item_name}${w.size_name ? ` (${w.size_name})` : ''}`}</td>
            <td className="num">{fmtQty(w.qty)} {w.unit ?? ''}</td><td><span className="pill warn">{w.reason}</span></td><td className="num">{fmt(w.cost_amount)}</td><td>{w.user_name}</td><td className="small">{w.notes}</td></tr>
        ))}</tbody></table></div>
    </div>
  );
}
