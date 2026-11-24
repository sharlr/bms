import { useT as useTr } from '../i18n';
import { useMemo, useState } from 'react';
import { fmt } from '../util';
import { Modal } from './ui';

export interface CartLine { key: string; menu_item_id: number; size_id: number | null; qty: number; modifier_ids: number[]; name: string; unit: number; notes?: string; allergy_note?: string }

/** Shared customer-facing menu browser (QR menu, online ordering, kiosk). */
export function useCart() {
  const [cart, setCart] = useState<CartLine[]>([]);
  const total = cart.reduce((s, l) => s + l.unit * l.qty, 0);
  const count = cart.reduce((s, l) => s + l.qty, 0);
  const add = (l: Omit<CartLine, 'key'>) => setCart((c) => [...c, { ...l, key: Math.random().toString(36) }]);
  const setQty = (key: string, qty: number) => setCart((c) => (qty <= 0 ? c.filter((x) => x.key !== key) : c.map((x) => (x.key === key ? { ...x, qty } : x))));
  return { cart, total, count, add, setQty, clear: () => setCart([]) };
}

export function MenuBrowser({ menu, currency, onAdd, big }: { menu: any; currency: string; onAdd: (l: Omit<CartLine, 'key'>) => void; big?: boolean }) {
  const tr = useTr();
  const [cat, setCat] = useState<number | null>(menu.categories[0]?.id ?? null);
  const [pick, setPick] = useState<any>(null);
  const items = useMemo(() => menu.items.filter((i: any) => i.category_id === cat), [menu, cat]);
  const quickAdd = (i: any) => (i.sizes.length || i.modifier_group_ids.length ? setPick(i) : onAdd({ menu_item_id: i.id, size_id: null, qty: 1, modifier_ids: [], name: i.name, unit: i.price }));
  return (
    <>
      <div className="cats" style={{ padding: '.5rem 0' }}>
        {menu.categories.filter((c: any) => menu.items.some((i: any) => i.category_id === c.id)).map((c: any) => (
          <button key={c.id} className={`${big ? 'lg' : ''} ${c.id === cat ? 'dark' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>
        ))}
      </div>
      {big ? (
        <div className="kiosk-items">
          {items.map((i: any) => (
            <button key={i.id} onClick={() => quickAdd(i)}>
              {i.image_url && <img className="thumb" src={i.image_url} alt="" />}
              <b>{i.name}</b>
              <span className="muted">{i.sizes.length ? tr("from {0}", fmt(Math.min(...i.sizes.map((s: any) => s.price)), currency)) : fmt(i.price, currency)}</span>
            </button>
          ))}
        </div>
      ) : items.map((i: any) => (
        <div key={i.id} className="menu-item">
          <div className="row nowrap" style={{ alignItems: 'flex-start' }}>
            {i.image_url && <img className="thumb" src={i.image_url} alt="" />}
            <div>
              <b>{i.name}</b>
              {i.description && <div className="small muted">{i.description}</div>}
              {i.allergens?.length > 0 && <div className="small warn">{tr("Contains: ")}{i.allergens.join(', ')}</div>}
              <div>{i.sizes.length ? i.sizes.map((s: any) => `${s.name} ${fmt(s.price)}`).join(' · ') : fmt(i.price, currency)}</div>
            </div>
          </div>
          <button className="primary" onClick={() => quickAdd(i)}>{tr("Add")}</button>
        </div>
      ))}
      {pick && <PickModal item={pick} menu={menu} currency={currency} onClose={() => setPick(null)} onAdd={(l) => { onAdd(l); setPick(null); }} />}
    </>
  );
}

function PickModal({ item, menu, currency, onClose, onAdd }: { item: any; menu: any; currency: string; onClose: () => void; onAdd: (l: Omit<CartLine, 'key'>) => void }) {
  const tr = useTr();
  const [size, setSize] = useState<any>(item.sizes[0] ?? null);
  const [mods, setMods] = useState<number[]>([]);
  const [notes, setNotes] = useState('');
  const [allergy, setAllergy] = useState('');
  const groups = menu.modifier_groups.filter((g: any) => item.modifier_group_ids.includes(g.id));
  const all = groups.flatMap((g: any) => g.modifiers);
  const unit = (size?.price ?? item.price) + mods.reduce((s, id) => s + (all.find((m: any) => m.id === id)?.price_delta ?? 0), 0);
  return (
    <Modal title={item.name} onClose={onClose}>
      <div className="stack">
        {item.sizes.length > 0 && <div className="row">{item.sizes.map((s: any) => (
          <button key={s.id} className={`lg ${size?.id === s.id ? 'dark' : ''}`} onClick={() => setSize(s)}>{s.name} · {fmt(s.price)}</button>
        ))}</div>}
        {groups.map((g: any) => (
          <div key={g.id}><b>{g.name}</b>
            <div className="row">{g.modifiers.map((m: any) => (
              <button key={m.id} className={mods.includes(m.id) ? 'dark' : ''} onClick={() => setMods((x) => (x.includes(m.id) ? x.filter((y) => y !== m.id) : [...x, m.id]))}>
                {m.name}{m.price_delta ? ` +${fmt(m.price_delta)}` : ''}</button>
            ))}</div>
          </div>
        ))}
        <label className="field">{tr("Special instructions")}<input value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} /></label>
        <label className="field">{tr("Food allergies")}<input value={allergy} maxLength={200} onChange={(e) => setAllergy(e.target.value)} /></label>
        <button className="primary lg" onClick={() => onAdd({
          menu_item_id: item.id, size_id: size?.id ?? null, qty: 1, modifier_ids: mods, unit,
          name: item.name + (size ? ` (${size.name})` : ''), notes: notes || undefined, allergy_note: allergy || undefined,
        })}>{tr("Add · ")}{fmt(unit, currency)}</button>
      </div>
    </Modal>
  );
}

export function CartList({ cart, setQty, currency }: { cart: CartLine[]; setQty: (k: string, q: number) => void; currency: string }) {
  return (
    <div className="stack">
      {cart.map((l) => (
        <div key={l.key} className="row between nowrap">
          <div><b>{l.name}</b>{l.notes && <div className="small muted">{l.notes}</div>}{l.allergy_note && <div className="small bad">⚠ {l.allergy_note}</div>}</div>
          <div className="row nowrap">
            <button className="sm" onClick={() => setQty(l.key, l.qty - 1)}>−</button><b>{l.qty}</b><button className="sm" onClick={() => setQty(l.key, l.qty + 1)}>+</button>
            <span style={{ minWidth: 90, textAlign: 'right' }}>{fmt(l.unit * l.qty, currency)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export const toOrderLines = (cart: CartLine[]) => cart.map((l) => ({
  menu_item_id: l.menu_item_id, size_id: l.size_id, qty: l.qty, modifier_ids: l.modifier_ids, notes: l.notes, allergy_note: l.allergy_note,
}));
