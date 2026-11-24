import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { AppBar } from '../components/AppBar';
import { Loading, Modal, useAction, useToast } from '../components/ui';
import { useSession } from '../session';
import { useBranchEvents } from '../socket';
import { fmtQty, minutesSince, ORDER_TYPES, time } from '../util';

const NEXT: Record<string, { status: string; label: string; cls: string }> = {
  new: { status: 'accepted', label: 'Accept', cls: 'dark' },
  accepted: { status: 'preparing', label: '👨‍🍳 Take all remaining', cls: 'primary' },
  preparing: { status: 'ready', label: '✓ All ready', cls: 'ok' },
  ready: { status: 'served', label: 'Served / picked up', cls: '' },
};
const PENDING = ['new', 'sent', 'accepted'];

/** Kitchen Display: live KOTs per preparation station (any number of kitchens / bars), replaces paper tickets. */
export function Kds() {
  const { me, loading, branchId, can } = useSession();
  const { tenant } = useParams();
  // Each screen remembers its station (e.g. the grill screen always shows the grill).
  const [station, setStation] = useState<number | ''>(Number(localStorage.getItem('bms:kds-station')) || '');
  const [stations, setStations] = useState<any[]>([]);
  useEffect(() => { if (me?.user) api.get('/prep-stations?active=true').then(setStations).catch(() => undefined); }, [me]);
  const pickStation = (v: number | '') => { setStation(v); if (v) localStorage.setItem('bms:kds-station', String(v)); else localStorage.removeItem('bms:kds-station'); };
  const [orders, setOrders] = useState<any[] | null>(null);
  const [, tick] = useState(0);
  const run = useAction();
  const toast = useToast();
  // Shared kitchen screen: "Take" asks which cook takes the item(s).
  const [pick, setPick] = useState<null | { url: string; what: string }>(null);
  const [staff, setStaff] = useState<any[] | null>(null);
  const take = async (url: string, what: string) => {
    const list = staff ?? await api.get('/kds/staff').catch(() => []);
    setStaff(list);
    if (!list.length) {
      toast('No kitchen staff set up — taken under your name. Give cooks the Kitchen role (Settings → Users).', true);
      return run(() => api.post(url, { status: 'preparing' })).then(load);
    }
    setPick({ url, what });
  };

  const load = useCallback(() => api.get(`/kds/orders${station ? `?station_id=${station}` : ''}`).then(setOrders).catch(() => setOrders([])), [station]);
  useEffect(() => { if (me?.user) load(); const i = setInterval(load, 20000); const t = setInterval(() => tick((x) => x + 1), 30000); return () => { clearInterval(i); clearInterval(t); }; }, [load, me]);
  useBranchEvents(branchId, ['kds:new', 'kds:update', 'kds:void', 'kds:cancel'], (e, d) => {
    if (e === 'kds:new' && (!station || d.station_id === station)) { toast(`New ${d.station_name} ticket — ${d.table_name ? 'Table ' + d.table_name : d.ticket_ref}`); try { new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=').play(); } catch { /* */ } }
    if (e === 'kds:void') toast(`VOID ${fmtQty(d.qty)}× ${d.name} (${d.ticket_ref})`, true);
    if (e === 'kds:cancel') toast(`CANCELLED ${d.ticket_ref}`, true);
    load();
  });

  if (loading) return <Loading />;
  if (!me?.user) return <Navigate to={`/${tenant}`} replace />;
  if (!can('kds.view')) return <div className="card">No KDS permission.</div>;

  return (
    <div className="app">
      <AppBar onLock={async () => { await api.post('/auth/logout', {}); location.href = '/' + tenant; }}
        right={<>
          <span className="day-pill">{orders?.length ?? 0} open</span>
          {can('pos.access') && <Link className="btn" to={'/' + tenant + '/pos'}>🧾 POS</Link>}
        </>}>
        <select aria-label="Kitchen / bar" value={station} onChange={(e) => pickStation(e.target.value ? Number(e.target.value) : '')}
          style={{ height: 44, minWidth: 180, fontWeight: 600 }}>
          <option value="">All kitchens &amp; bars</option>
          {stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </AppBar>
      <div className="kds">
        {orders?.map((k) => {
          const age = minutesSince(k.created_at);
          // Whole-ticket shortcut follows the lines: take all → all ready → served.
          const live = (k.lines as any[]).filter((l) => !l.void);
          const next = live.some((l) => PENDING.includes(l.kitchen_status)) ? NEXT.accepted
            : live.some((l) => l.kitchen_status === 'preparing') ? NEXT.preparing
              : live.some((l) => l.kitchen_status === 'ready') && live.every((l) => ['ready', 'served'].includes(l.kitchen_status)) ? NEXT.ready : null;
          return (
            <div key={k.id} className="kot">
              <div className={`kot-head ${age >= 20 ? 'very-late' : age >= 10 ? 'late' : ''}`} style={age < 10 ? { background: k.station_color } : undefined}>
                <span>{!station && <>{k.station_name} · </>}{k.table_name ? `Table ${k.table_name}` : ORDER_TYPES[k.order_type]} · #{k.kot_no}</span>
                <span>{age}m</span>
              </div>
              <div className="small muted" style={{ padding: '.3rem .7rem' }}>{k.ticket_ref} · {time(k.created_at)}{k.pax ? ` · ${k.pax} pax` : ''}{k.customer_name ? ` · ${k.customer_name}` : ''} · <b>{k.status}</b>
                {k.scheduled_for && <div className="warn"><b>⏰ Ready for {new Date(k.scheduled_for).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b></div>}</div>
              <ul>
                {(k.lines as any[]).map((l, i) => {
                  const st = l.void ? 'void' : PENDING.includes(l.kitchen_status) ? 'pending' : l.kitchen_status;
                  const setLine = (status: string) => run(() => api.post(`/kds/lines/${l.line_id}/status`, { status })).then(load);
                  return (
                    <li key={i} className={`kline ${st}`}>
                      <div className="row between nowrap" style={{ alignItems: 'flex-start' }}>
                        <div>
                          <b>{fmtQty(l.qty)}×</b> {l.name}{l.size ? ` (${l.size})` : ''}{l.seat ? <span className="pill">S{l.seat}</span> : null}
                          {(l.modifiers as any[])?.length > 0 && <div className="small">+ {(l.modifiers as any[]).map((m) => m.name).join(', ')}</div>}
                          {l.notes && <div className="small">📝 {l.notes}</div>}
                          {l.allergy && <div className="small bad"><b>⚠ ALLERGY: {l.allergy}</b></div>}
                          {st === 'pending' && <div className="small"><b>PENDING — not taken</b></div>}
                          {st === 'preparing' && <div className="small">👨‍🍳 {l.chef ?? 'Cooking'}{l.kitchen_at ? ` · ${minutesSince(l.kitchen_at)}m` : ''}</div>}
                        </div>
                        <div className="row nowrap" style={{ gap: '.3rem' }}>
                          {st === 'pending' && <button className="sm dark" onClick={() => take(`/kds/lines/${l.line_id}/status`, `${fmtQty(l.qty)}× ${l.name}`)}>Take</button>}
                          {st === 'preparing' && <>
                            <button className="sm ok" onClick={() => setLine('ready')}>Ready</button>
                            <button className="sm" title="Release back to the queue" aria-label="Release back to the queue" onClick={() => setLine('sent')}>↩</button>
                          </>}
                          {st === 'ready' && <button className="sm ok" onClick={() => setLine('served')}>🍽 Serve</button>}
                          {st === 'served' && <span className="pill">Served</span>}
                          {st === 'void' && <span className="pill">VOID</span>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {k.ticket_notes && <div className="small" style={{ padding: '0 .7rem .5rem' }}>Note: {k.ticket_notes}</div>}
              {next && <button className={`${next.cls} lg`} style={{ borderRadius: 0 }} onClick={() => (next.status === 'preparing'
                ? take(`/kds/orders/${k.id}/status`, `all remaining items of ${k.ticket_ref}`)
                : run(() => api.post(`/kds/orders/${k.id}/status`, { status: next.status })).then(load))}>{next.label}</button>}
            </div>
          );
        })}
        {orders?.length === 0 && <div style={{ color: '#94a3b8', padding: '2rem' }}>No open tickets 🎉</div>}
        {pick && staff && (
          <Modal title={`Who takes ${pick.what}?`} onClose={() => setPick(null)}>
            <div className="staff-grid">
              {staff.map((s) => (
                <button key={s.id} style={{ background: s.color }} onClick={async () => {
                  setPick(null);
                  await run(() => api.post(pick.url, { status: 'preparing', cook_id: s.id }));
                  load();
                }}>
                  <span className="avatar">{s.full_name.split(' ').map((x: string) => x[0]).join('').slice(0, 2).toUpperCase()}</span>
                  {s.full_name}
                </button>
              ))}
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}
