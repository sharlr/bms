import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, tenantSlug } from '../../api';
import { Decor, KINDS, ScaledPlan, type PlanItem } from '../../components/FloorPlan';
import { Modal, useAction } from '../../components/ui';

type Sel = { t: 'table'; id: number } | { t: 'decor'; id: string } | null;
interface Geom { x: number; y: number; w: number; h: number }
const GRID = 10;
const snap = (v: number) => Math.round(v / GRID) * GRID;
const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * Restaurant plan designer: draw walls / rooms / bar / doors…, place numbered tables, drag to move,
 * drag the corner handle to resize, arrow keys to nudge, Delete to remove. "Save plan" persists everything.
 */
export function FloorEditor() {
  const [floors, setFloors] = useState<any[]>([]);
  const [floorId, setFloorId] = useState<number | null>(null);
  const [tables, setTables] = useState<any[]>([]);
  const [layout, setLayout] = useState<PlanItem[]>([]);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const [sel, setSel] = useState<Sel>(null);
  const [dirty, setDirty] = useState(false);
  const dirtyTables = useRef(new Set<number>());
  const scale = useRef(1);
  const drag = useRef<{ mode: 'move' | 'resize'; sel: NonNullable<Sel>; sx: number; sy: number; orig: Geom } | null>(null);
  const [qr, setQr] = useState<{ name: string; url: string; img: string }[] | null>(null);
  const run = useAction();
  const onScale = useCallback((s: number) => { scale.current = s; }, []);

  const floor = floors.find((f) => f.id === floorId);
  const shown = tables.filter((t) => t.floor_id === floorId);

  const load = useCallback(async () => {
    const f = (await api.get('/floors')).filter((x: any) => x.active);
    setFloors(f);
    setTables((await api.get('/tables')).filter((t: any) => t.active));
    setFloorId((cur) => (f.some((x: any) => x.id === cur) ? cur : f[0]?.id ?? null));
  }, []);
  useEffect(() => { load(); }, [load]);
  // Load the drawing of the selected floor.
  useEffect(() => {
    if (!floor) return;
    setLayout(floor.layout ?? []);
    setSize({ width: floor.width ?? 1200, height: floor.height ?? 800 });
    setSel(null);
    setDirty(false);
    dirtyTables.current.clear();
    // Only when switching floors: a refreshed floor list must not wipe unsaved drawing work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor?.id]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const geomOf = (s: NonNullable<Sel>): Geom | null => {
    if (s.t === 'table') { const t = tables.find((x) => x.id === s.id); return t ? { x: t.pos_x, y: t.pos_y, w: t.width, h: t.height } : null; }
    return layout.find((x) => x.id === s.id) ?? null;
  };
  const setGeom = (s: NonNullable<Sel>, g: Geom) => {
    if (s.t === 'table') {
      setTables((ts) => ts.map((t) => (t.id === s.id ? { ...t, pos_x: g.x, pos_y: g.y, width: g.w, height: g.h } : t)));
      dirtyTables.current.add(s.id);
    } else setLayout((l) => l.map((d) => (d.id === s.id ? { ...d, ...g } : d)));
    setDirty(true);
  };
  const patchTable = (id: number, p: object) => { setTables((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t))); dirtyTables.current.add(id); setDirty(true); };
  const patchDecor = (id: string, p: Partial<PlanItem>) => { setLayout((l) => l.map((d) => (d.id === id ? { ...d, ...p } : d))); setDirty(true); };

  // Drag / resize with pointer events on the window (mouse, pen and touch).
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (e.clientX - d.sx) / scale.current, dy = (e.clientY - d.sy) / scale.current;
      const o = d.orig;
      if (d.mode === 'move') {
        setGeom(d.sel, { ...o, x: Math.max(0, Math.min(size.width - o.w, snap(o.x + dx))), y: Math.max(0, Math.min(size.height - o.h, snap(o.y + dy))) });
      } else {
        const min = d.sel.t === 'table' ? 30 : 4;
        setGeom(d.sel, { ...o, w: Math.max(min, Math.min(size.width - o.x, snap(o.w + dx))), h: Math.max(min, Math.min(size.height - o.y, snap(o.h + dy))) });
      }
    };
    const up = () => { drag.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  });
  const startDrag = (e: React.PointerEvent, s: NonNullable<Sel>, mode: 'move' | 'resize') => {
    e.stopPropagation();
    e.preventDefault();
    setSel(s);
    const g = geomOf(s);
    if (g) drag.current = { mode, sel: s, sx: e.clientX, sy: e.clientY, orig: { ...g } };
  };

  const removeSelected = async () => {
    if (!sel) return;
    if (sel.t === 'decor') { setLayout((l) => l.filter((d) => d.id !== sel.id)); setDirty(true); setSel(null); return; }
    const t = tables.find((x) => x.id === sel.id);
    if (t && confirm(`Remove table ${t.name}?`) && await run(() => api.del(`/tables/${t.id}`), 'Table removed')) {
      setTables((ts) => ts.filter((x) => x.id !== t.id));
      dirtyTables.current.delete(t.id);
      setSel(null);
    }
  };
  // Keyboard: arrows nudge (Shift = 1px), Delete removes. Ignored while typing in a field.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!sel || (e.target as HTMLElement).closest('input, textarea, select')) return;
      if (e.key === 'Delete') { e.preventDefault(); removeSelected(); return; }
      const step = e.shiftKey ? 1 : GRID;
      const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
      const g = geomOf(sel);
      if (!d || !g) return;
      e.preventDefault();
      setGeom(sel, { ...g, x: Math.max(0, g.x + d[0]), y: Math.max(0, g.y + d[1]) });
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const addTable = async (shape: 'square' | 'round' | 'rect') => {
    if (!floorId) return;
    const nums = tables.map((t) => Number(/(\d+)$/.exec(t.name)?.[1] ?? 0));
    const name = `T${Math.max(0, ...nums) + 1}`;
    const body = { floor_id: floorId, name, seats: shape === 'rect' ? 6 : 4, shape, width: shape === 'rect' ? 160 : 90, height: 90, pos_x: 40, pos_y: 40 };
    const t = await run(() => api.post('/tables', body), `Table ${name} added — drag it into place`);
    if (t) { setTables((ts) => [...ts, t]); setSel({ t: 'table', id: t.id }); }
  };
  const addDecor = (kind: string) => {
    const k = KINDS[kind];
    const d: PlanItem = { id: newId(), kind, x: 40, y: 40, w: k.w, h: k.h, ...(kind === 'text' ? { label: 'Terrace' } : {}) };
    setLayout((l) => [...l, d]);
    setSel({ t: 'decor', id: d.id });
    setDirty(true);
  };

  const save = async () => {
    if (!floorId) return;
    const ok = await run(async () => {
      for (const id of dirtyTables.current) {
        const t = tables.find((x) => x.id === id);
        if (t) await api.patch(`/tables/${id}`, { name: t.name, seats: t.seats, shape: t.shape, pos_x: t.pos_x, pos_y: t.pos_y, width: t.width, height: t.height });
      }
      await api.patch(`/floors/${floorId}`, { layout, width: size.width, height: size.height });
      return true;
    }, 'Plan saved');
    if (ok) { dirtyTables.current.clear(); setDirty(false); setFloors((fs) => fs.map((f) => (f.id === floorId ? { ...f, layout, ...size } : f))); }
  };
  const switchFloor = (id: number) => { if (!dirty || confirm('Discard unsaved changes on this floor?')) setFloorId(id); };

  const qrFor = async (list: any[]) => {
    const out = [];
    for (const t of list) {
      const url = `${location.origin}/${tenantSlug()}/menu?table=${t.qr_token}`;
      out.push({ name: t.name, url, img: await QRCode.toDataURL(url, { width: 220, margin: 1 }) });
    }
    setQr(out);
  };

  const selTable = sel?.t === 'table' ? tables.find((t) => t.id === sel.id) : null;
  const selDecor = sel?.t === 'decor' ? layout.find((d) => d.id === sel.id) : null;

  return (
    <div className="stack">
      <div className="row between">
        <h1>Floor Plan Designer</h1>
        <div className="row">
          {dirty && <span className="pill warn">Unsaved changes</span>}
          <button className="primary" disabled={!dirty} onClick={save}>💾 Save plan</button>
          <button disabled={!shown.length} onClick={() => qrFor(shown)}>Print QR codes</button>
        </div>
      </div>

      <div className="row">
        {floors.map((f) => <button key={f.id} className={f.id === floorId ? 'primary' : ''} onClick={() => switchFloor(f.id)}>{f.name}</button>)}
        <button onClick={async () => { const name = prompt('New floor name (e.g. Terrace, 1st floor)'); if (name && await run(() => api.post('/floors', { name }))) load(); }}>+ Floor</button>
        <div className="grow" />
        {floorId && <>
          <button className="sm" onClick={async () => {
            const name = prompt('Rename floor', floor?.name);
            if (name && await run(() => api.patch(`/floors/${floorId}`, { name }))) load();
          }}>Rename floor</button>
          <button className="sm danger" onClick={async () => {
            if (shown.length) return alert('Move or remove the tables on this floor first.');
            if (confirm('Delete this floor?') && await run(() => api.del(`/floors/${floorId}`))) { setFloorId(null); load(); }
          }}>Delete floor</button>
        </>}
      </div>

      {!floorId ? <div className="card">Create a floor to start drawing.</div> : (
        <div className="designer">
          <div className="stack">
            <div className="card stack" style={{ padding: '.6rem' }}>
              <div className="palette-tools">
                <b style={{ alignSelf: 'center' }}>Tables:</b>
                <button onClick={() => addTable('square')}>⬛ Square</button>
                <button onClick={() => addTable('round')}>⚫ Round</button>
                <button onClick={() => addTable('rect')}>▭ Long</button>
              </div>
              <div className="palette-tools">
                <b style={{ alignSelf: 'center' }}>Draw:</b>
                {Object.entries(KINDS).map(([kind, k]) => <button key={kind} onClick={() => addDecor(kind)}>{k.icon} {k.name}</button>)}
              </div>
            </div>
            <ScaledPlan width={size.width} height={size.height} onScale={onScale}>
              <div style={{ position: 'absolute', inset: 0 }} onPointerDown={() => setSel(null)} />
              {layout.map((d) => (
                <div key={d.id}>
                  <Decor d={d} selected={sel?.t === 'decor' && sel.id === d.id} onPointerDown={(e) => startDrag(e, { t: 'decor', id: d.id }, 'move')} />
                  {sel?.t === 'decor' && sel.id === d.id && (
                    <div style={{ position: 'absolute', left: d.x + d.w, top: d.y + d.h }}><div className="handle" onPointerDown={(e) => startDrag(e, { t: 'decor', id: d.id }, 'resize')} /></div>
                  )}
                </div>
              ))}
              {shown.map((t) => {
                const on = sel?.t === 'table' && sel.id === t.id;
                return (
                  <div key={t.id} className={`tbl ${t.shape === 'round' ? 'round' : ''}`} onPointerDown={(e) => startDrag(e, { t: 'table', id: t.id }, 'move')}
                    style={{ left: t.pos_x, top: t.pos_y, width: t.width, height: t.height, cursor: 'move', outline: on ? '3px solid var(--brand)' : undefined, outlineOffset: 3 }}>
                    <span style={{ fontSize: Math.max(12, Math.min(22, t.height / 4)) }}>{t.name}</span>
                    <span className="meta">{t.seats} seats</span>
                    {on && <div className="handle" onPointerDown={(e) => startDrag(e, { t: 'table', id: t.id }, 'resize')} />}
                  </div>
                );
              })}
            </ScaledPlan>
            <div className="small muted">Drag to move · drag the orange corner to resize · arrow keys nudge (Shift = 1 px) · Delete removes · everything snaps to a {GRID} px grid.</div>
          </div>

          <div className="card stack">
            {selTable ? <>
              <h3>Table {selTable.name}</h3>
              <label className="field">Table number / name<input value={selTable.name} maxLength={20} onChange={(e) => patchTable(selTable.id, { name: e.target.value })} /></label>
              <label className="field">Seats<input type="number" min={1} max={100} value={selTable.seats} onChange={(e) => patchTable(selTable.id, { seats: Math.max(1, Number(e.target.value) || 1) })} /></label>
              <div className="field">Shape
                <div className="row">{(['square', 'round', 'rect'] as const).map((s) => (
                  <button key={s} className={`sm ${selTable.shape === s ? 'dark' : ''}`} onClick={() => patchTable(selTable.id, { shape: s })}>{s}</button>
                ))}</div>
              </div>
              <div className="grid2">
                <label className="field">Width<input type="number" step={10} value={selTable.width} onChange={(e) => patchTable(selTable.id, { width: Math.max(30, Number(e.target.value) || 30) })} /></label>
                <label className="field">Height<input type="number" step={10} value={selTable.height} onChange={(e) => patchTable(selTable.id, { height: Math.max(30, Number(e.target.value) || 30) })} /></label>
              </div>
              <label className="field">Move to floor<select value={selTable.floor_id} onChange={async (e) => {
                if (await run(() => api.patch(`/tables/${selTable.id}`, { floor_id: Number(e.target.value) }), 'Table moved')) { setSel(null); load(); }
              }}>{floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
              <div className="small muted">Guests above the seat count are still accepted at the POS.</div>
              <div className="row">
                <button className="sm" onClick={() => qrFor([selTable])}>QR code</button>
                <button className="sm danger" onClick={removeSelected}>Remove table</button>
              </div>
            </> : selDecor ? <>
              <h3>{KINDS[selDecor.kind]?.icon} {KINDS[selDecor.kind]?.name}</h3>
              <label className="field">Label<input value={selDecor.label ?? ''} maxLength={40} placeholder={KINDS[selDecor.kind]?.name} onChange={(e) => patchDecor(selDecor.id, { label: e.target.value || undefined })} /></label>
              <div className="grid2">
                <label className="field">Width<input type="number" step={10} value={selDecor.w} onChange={(e) => patchDecor(selDecor.id, { w: Math.max(4, Number(e.target.value) || 4) })} /></label>
                <label className="field">Height<input type="number" step={10} value={selDecor.h} onChange={(e) => patchDecor(selDecor.id, { h: Math.max(4, Number(e.target.value) || 4) })} /></label>
              </div>
              <label className="field">Color<input type="color" value={selDecor.color ?? '#cbd5e1'} onChange={(e) => patchDecor(selDecor.id, { color: e.target.value })} /></label>
              <div className="row">
                <button className="sm" onClick={() => patchDecor(selDecor.id, { w: selDecor.h, h: selDecor.w })}>↻ Rotate 90°</button>
                <button className="sm" onClick={() => { const d = { ...selDecor, id: newId(), x: selDecor.x + 20, y: selDecor.y + 20 }; setLayout((l) => [...l, d]); setSel({ t: 'decor', id: d.id }); setDirty(true); }}>⧉ Duplicate</button>
                {selDecor.color && <button className="sm" onClick={() => patchDecor(selDecor.id, { color: undefined })}>Default color</button>}
                <button className="sm danger" onClick={removeSelected}>Delete</button>
              </div>
            </> : <>
              <h3>Plan — {floor?.name}</h3>
              <p className="small muted">Select an element to edit it, or add tables and drawing elements from the toolbar.</p>
              <div className="grid2">
                <label className="field">Plan width<input type="number" step={50} min={400} max={5000} value={size.width} onChange={(e) => { setSize({ ...size, width: Math.min(5000, Math.max(400, Number(e.target.value) || 400)) }); setDirty(true); }} /></label>
                <label className="field">Plan height<input type="number" step={50} min={300} max={5000} value={size.height} onChange={(e) => { setSize({ ...size, height: Math.min(5000, Math.max(300, Number(e.target.value) || 300)) }); setDirty(true); }} /></label>
              </div>
              <div className="small muted">{shown.length} table(s), {shown.reduce((s, t) => s + t.seats, 0)} seats on this floor.</div>
            </>}
          </div>
        </div>
      )}

      {qr && (
        <Modal title="Table QR codes" onClose={() => setQr(null)} wide>
          <button className="primary no-print" onClick={() => window.print()}>Print</button>
          <div className="printable" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
            {qr.map((q) => (
              <div key={q.url} className="center" style={{ border: '1px dashed #999', padding: '.8rem', breakInside: 'avoid' }}>
                <b style={{ fontSize: '1.3rem' }}>Table {q.name}</b><br /><img src={q.img} alt={`QR table ${q.name}`} /><br />
                <span className="small">Scan to view the menu &amp; order</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
