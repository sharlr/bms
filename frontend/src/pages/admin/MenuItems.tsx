import { useCallback, useEffect, useState } from 'react';
import { api, getBranchId, getCompanyId, tenantSlug } from '../../api';
import { Modal, useAction } from '../../components/ui';
import { useSession } from '../../session';
import { fmt, ORDER_TYPES } from '../../util';

/** Resize a photo in the browser (max 1024 px, WebP/JPEG) so uploads stay small and fast. */
async function shrinkImage(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Choose a JPEG, PNG or WebP photo');
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('This photo could not be read'); });
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const toBlob = (type: string) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.85));
  const blob = (await toBlob('image/webp').then((b) => (b?.type === 'image/webp' ? b : null))) ?? await toBlob('image/jpeg');
  if (!blob) throw new Error('This photo could not be processed');
  if (blob.size > 1024 * 1024) throw new Error('Photo is still larger than 1 MB after resizing');
  return blob;
}

async function uploadPhoto(itemId: number, photo: Blob) {
  const r = await fetch(`/api/t/${tenantSlug()}/menu/items/${itemId}/image`, {
    method: 'PUT', body: photo, credentials: 'same-origin',
    headers: { 'Content-Type': photo.type, 'X-Requested-With': 'bms', 'X-Company-Id': String(getCompanyId() ?? ''), 'X-Branch-Id': String(getBranchId() ?? '') },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? 'Photo upload failed');
}

/** Menu items with size variants, company default + per-branch price matrix, stock-impact toggle and modifiers. */
export function MenuItems() {
  const { can } = useSession();
  const [items, setItems] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [stations, setStations] = useState<any[]>([]);
  const [cat, setCat] = useState<number | ''>('');
  const [edit, setEdit] = useState<any>(null);
  const run = useAction();
  const load = useCallback(() => api.get('/menu/items').then(setItems), []);
  useEffect(() => {
    load();
    api.get('/menu/categories').then(setCats);
    api.get('/menu/modifier-groups').then(setGroups);
    api.get('/prep-stations').then(setStations);
    api.get('/branches').then(setBranches);
  }, [load]);
  const write = can('menu.manage');
  const companyBranches = (companyId: number) => branches.filter((b) => b.company_id === companyId);

  const openNew = () => setEdit({
    category_id: cats[0]?.id, name: '', description: '', route: '', tracks_stock: false, allergens: '', available_online: true, sort: 0, active: true,
    sizes: [] as string[], prices: [{ size_name: null, branch_id: null, price: '' }], modifier_group_ids: [],
  });
  const openEdit = (i: any) => setEdit({
    ...i, allergens: (i.allergens ?? []).join(', '), route: i.no_kot ? 'none' : i.station_id ?? '',
    prices: i.prices.map((p: any) => ({ ...p })), modifier_group_ids: [...i.modifier_group_ids],
  });

  const save = async () => {
    const base = {
      category_id: edit.category_id, name: edit.name, description: edit.description || null, sku: edit.sku || null,
      // route: '' = same kitchen/bar as the category, 'none' = no kitchen ticket, number = a specific kitchen/bar
      station_id: typeof edit.route === 'number' ? edit.route : null, no_kot: edit.route === 'none', tracks_stock: edit.tracks_stock, available_online: edit.available_online, sort: Number(edit.sort) || 0, active: edit.active,
      allergens: String(edit.allergens || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
    if (!edit.id) {
      const r = await run(() => api.post('/menu/items', {
        ...base, sizes: edit.sizes, modifier_group_ids: edit.modifier_group_ids,
        prices: edit.prices.filter((p: any) => p.price !== '').map((p: any) => ({ size_name: p.size_name || undefined, branch_id: p.branch_id, order_type: p.order_type ?? null, price: Number(p.price) })),
      }), 'Item created');
      if (r && edit.photo) await run(() => uploadPhoto(r.id, edit.photo));
      if (r) { setEdit(null); load(); }
      return;
    }
    const ok = await run(async () => {
      await api.patch(`/menu/items/${edit.id}`, base);
      if (edit.photo) await uploadPhoto(edit.id, edit.photo);
      else if (edit.removePhoto) await api.del(`/menu/items/${edit.id}/image`);
      await api.put(`/menu/items/${edit.id}/prices`, edit.prices.filter((p: any) => p.price !== '' && p.price !== null).map((p: any) => ({ size_id: p.size_id ?? null, branch_id: p.branch_id ?? null, order_type: p.order_type ?? null, price: Number(p.price) })));
      await api.put(`/menu/items/${edit.id}/modifier-groups`, edit.modifier_group_ids);
      return true;
    }, 'Item saved');
    if (ok) { setEdit(null); load(); }
  };

  const shown = items.filter((i) => !cat || i.category_id === cat);
  const sizeOptions = edit ? (edit.id ? edit.sizes.map((s: any) => ({ key: s.id, label: s.name })) : edit.sizes.map((s: string) => ({ key: s, label: s }))) : [];
  const priceKey = edit?.id ? 'size_id' : 'size_name';

  return (
    <div className="stack">
      <div className="row between"><h1>Items, Sizes & Prices</h1>{write && <button className="primary" onClick={openNew}>+ New item</button>}</div>
      <div className="row"><select style={{ maxWidth: 260 }} value={cat} onChange={(e) => setCat(e.target.value ? Number(e.target.value) : '')}>
        <option value="">All categories</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Item</th><th>Category</th><th>Sizes</th><th>Prices</th><th>Kitchen / bar</th><th>Stock impact</th><th>Online</th><th>Active</th></tr></thead>
        <tbody>{shown.map((i) => (
          <tr key={i.id} className="click" onClick={() => write && openEdit(i)}>
            <td><div className="row nowrap">{i.image_url ? <img className="thumb" style={{ width: 44, height: 44 }} src={i.image_url} alt="" /> : <span style={{ width: 44 }} />}<b>{i.name}</b></div></td>
            <td>{cats.find((c) => c.id === i.category_id)?.name}</td>
            <td>{i.sizes.map((s: any) => s.name).join(', ') || '—'}</td>
            <td className="small">{i.prices.map((p: any) => `${i.sizes.find((s: any) => s.id === p.size_id)?.name ?? ''} ${branches.find((b) => b.id === p.branch_id)?.code ?? 'default'}${p.order_type ? ' ' + ORDER_TYPES[p.order_type] : ''}: ${fmt(p.price)}`).join(' · ')}</td>
            <td>{i.no_kot ? 'No ticket' : stations.find((s) => s.id === i.station_id)?.name ?? <span className="muted">category</span>}</td>
            <td>{i.tracks_stock ? <span className="pill ok">Deducts stock</span> : <span className="pill">No</span>}</td>
            <td>{i.available_online ? '✓' : ''}</td><td>{i.active ? '✓' : <span className="pill">inactive</span>}</td>
          </tr>
        ))}</tbody></table></div>

      {edit && (
        <Modal title={edit.id ? edit.name : 'New menu item'} onClose={() => setEdit(null)} wide>
          <div className="stack">
            <div className="grid2">
              <label className="field">Name *<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label className="field">Category<select value={edit.category_id} onChange={(e) => setEdit({ ...edit, category_id: Number(e.target.value) })}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label className="field">Prepared in (kitchen / bar)<select value={edit.route} onChange={(e) => setEdit({ ...edit, route: e.target.value === '' || e.target.value === 'none' ? e.target.value : Number(e.target.value) })}>
                <option value="">Same as its category</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="none">No kitchen ticket</option></select></label>
              <label className="field">Allergens (comma separated)<input value={edit.allergens} onChange={(e) => setEdit({ ...edit, allergens: e.target.value })} /></label>
              <div className="field">Photo
                <div className="row nowrap">
                  {(edit.photoPreview ?? (!edit.removePhoto && edit.image_url))
                    ? <img src={edit.photoPreview ?? edit.image_url} alt={`Photo of ${edit.name || 'item'}`} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} />
                    : <div style={{ width: 72, height: 72, borderRadius: 8, background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden>📷</div>}
                  <label className="btn sm" style={{ cursor: 'pointer' }}>
                    {edit.photoPreview || edit.image_url ? 'Change photo' : 'Upload photo'}
                    <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const photo = await run(() => shrinkImage(f));
                      if (photo) setEdit({ ...edit, photo, photoPreview: URL.createObjectURL(photo), removePhoto: false });
                    }} />
                  </label>
                  {(edit.photoPreview || (edit.image_url && !edit.removePhoto)) && (
                    <button type="button" className="sm" onClick={() => setEdit({ ...edit, photo: null, photoPreview: null, removePhoto: true })}>Remove</button>
                  )}
                </div>
              </div>
              <label className="field">Sort<input type="number" value={edit.sort} onChange={(e) => setEdit({ ...edit, sort: e.target.value })} /></label>
            </div>
            <label className="field">Description<textarea value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
            <div className="row">
              <label className="check card" style={{ padding: '.6rem' }}><input type="checkbox" checked={edit.tracks_stock} onChange={(e) => setEdit({ ...edit, tracks_stock: e.target.checked })} />
                <span><b>Deduct stock when ordered</b><br /><span className="small muted">Ingredients from the recipe are subtracted from branch stock on order confirmation</span></span></label>
              <label className="check"><input type="checkbox" checked={edit.available_online} onChange={(e) => setEdit({ ...edit, available_online: e.target.checked })} /> Show on QR / online menu</label>
              <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
            </div>

            <h3>Sizes</h3>
            {!edit.id ? (
              <div className="row">
                {edit.sizes.map((s: string) => <span key={s} className="pill">{s} <a href="#" onClick={(e) => { e.preventDefault(); setEdit({ ...edit, sizes: edit.sizes.filter((x: string) => x !== s), prices: edit.prices.filter((p: any) => p.size_name !== s) }); }}>✕</a></span>)}
                <button className="sm" onClick={() => { const s = prompt('Size name (e.g. Small, Medium, Large)'); if (s && !edit.sizes.includes(s)) setEdit({ ...edit, sizes: [...edit.sizes, s], prices: [...edit.prices.filter((p: any) => p.size_name), { size_name: s, branch_id: null, price: '' }] }); }}>+ Size</button>
                {[['Small', 'Medium', 'Large']].map((preset) => <button key="p" className="sm" onClick={() => setEdit({ ...edit, sizes: preset, prices: preset.map((s) => ({ size_name: s, branch_id: null, price: '' })) })}>S / M / L</button>)}
              </div>
            ) : (
              <div className="row">
                {edit.sizes.map((s: any) => <span key={s.id} className="pill">{s.name}</span>)}
                <button className="sm" onClick={async () => {
                  const name = prompt('New size name'); if (!name) return;
                  const s = await run(() => api.post('/menu/sizes', { item_id: edit.id, name, sort: edit.sizes.length }));
                  if (s) setEdit({ ...edit, sizes: [...edit.sizes, s] });
                }}>+ Size</button>
              </div>
            )}

            <h3>Prices (company default + branch overrides, per order type)</h3>
            <p className="small muted">Most specific price wins: branch + order type › branch › company + order type › company “All”.</p>
            <table className="data">
              <thead><tr><th>Size</th><th>Branch</th><th>Order type</th><th className="num">Price</th><th /></tr></thead>
              <tbody>{edit.prices.map((p: any, i: number) => (
                <tr key={i}>
                  <td>{sizeOptions.length ? <select value={p[priceKey] ?? ''} onChange={(e) => setEdit({ ...edit, prices: edit.prices.map((x: any, j: number) => (j === i ? { ...x, [priceKey]: edit.id ? Number(e.target.value) : e.target.value } : x)) })}>
                    {sizeOptions.map((s: any) => <option key={s.key} value={s.key}>{s.label}</option>)}</select> : <span className="muted">—</span>}</td>
                  <td><select value={p.branch_id ?? ''} onChange={(e) => setEdit({ ...edit, prices: edit.prices.map((x: any, j: number) => (j === i ? { ...x, branch_id: e.target.value ? Number(e.target.value) : null } : x)) })}>
                    <option value="">Company default (all branches)</option>
                    {companyBranches(branches.find((b) => b.id === p.branch_id)?.company_id ?? branches[0]?.company_id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></td>
                  <td><select value={p.order_type ?? ''} onChange={(e) => setEdit({ ...edit, prices: edit.prices.map((x: any, j: number) => (j === i ? { ...x, order_type: e.target.value || null } : x)) })}>
                    <option value="">All order types</option><option value="dine_in">Dine-in</option><option value="takeaway">Takeaway</option><option value="delivery">Delivery</option></select></td>
                  <td><input type="number" step="any" value={p.price} onChange={(e) => setEdit({ ...edit, prices: edit.prices.map((x: any, j: number) => (j === i ? { ...x, price: e.target.value } : x)) })} /></td>
                  <td><button className="sm" onClick={() => setEdit({ ...edit, prices: edit.prices.filter((_: any, j: number) => j !== i) })}>✕</button></td>
                </tr>
              ))}</tbody>
            </table>
            <button className="sm" onClick={() => setEdit({ ...edit, prices: [...edit.prices, { [priceKey]: sizeOptions[0]?.key ?? null, branch_id: null, price: '' }] })}>+ Price row</button>

            <h3>Modifier groups</h3>
            <div className="row">{groups.map((g) => (
              <label key={g.id} className="check"><input type="checkbox" checked={edit.modifier_group_ids.includes(g.id)}
                onChange={(e) => setEdit({ ...edit, modifier_group_ids: e.target.checked ? [...edit.modifier_group_ids, g.id] : edit.modifier_group_ids.filter((x: number) => x !== g.id) })} /> {g.name}</label>
            ))}</div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setEdit(null)}>Cancel</button>
              <button className="primary" disabled={!edit.name} onClick={save}>Save</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
