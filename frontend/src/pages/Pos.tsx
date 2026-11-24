import { useT as useTr } from '../i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { AppBar } from '../components/AppBar';
import { CookingNotes } from '../components/CookingNotes';
import { Decor, ScaledPlan } from '../components/FloorPlan';
import { MapPicker, mapLink } from '../components/Map';
import { ReservationsPanel } from '../components/Reservations';
import { Receipt } from '../components/Receipt';
import { Loading, Modal, Numpad, useAction, useOverride, useToast } from '../components/ui';
import { useSession } from '../session';
import { useBranchEvents } from '../socket';
import { fmt, fmtQty, ORDER_TYPES, time, today, todayLocal } from '../util';

type View = { kind: 'floor' } | { kind: 'order'; id: number } | { kind: 'orders' };

export function Pos() {
  const tr = useTr();
  const { me, loading, branchId, can, currency, reload } = useSession();
  const { tenant } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const mode = me?.user?.device_bound ? me.device?.mode : 'pos';
  const [view, setView] = useState<View>({ kind: mode === 'takeaway' ? 'orders' : 'floor' });
  const [newOrder, setNewOrder] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [printData, setPrintData] = useState<any>(null);
  const [day, setDay] = useState<any>(undefined); // undefined = loading, null = no open register session
  const [askDay, setAskDay] = useState(true);
  const loadDay = useCallback(() => api.get('/pos/session').then((r) => setDay(r.session)).catch(() => setDay(undefined)), []);
  useEffect(() => { if (me?.user) loadDay(); }, [me, loadDay]);

  const refreshPending = useCallback(() => {
    api.get<any[]>('/pos/tickets?status=pending').then((r) => setPendingCount(r.length)).catch(() => undefined);
  }, []);
  useEffect(() => { if (me?.user) refreshPending(); }, [me, refreshPending]);
  // Orders the kitchen finished: stay listed under 🔔 until staff open or dismiss them.
  const [ready, setReady] = useState<any[]>([]);
  const [showReady, setShowReady] = useState(false);
  // Today's table bookings (count on the 📅 button, refreshed live).
  const [bookings, setBookings] = useState(0);
  const [showBookings, setShowBookings] = useState(false);
  const refreshBookings = useCallback(() => {
    api.get<any[]>(`/reservations?from=${todayLocal()}&to=${todayLocal()}`).then((r) => setBookings(r.filter((x) => x.status === 'pending' || x.status === 'confirmed').length)).catch(() => undefined);
  }, []);
  useEffect(() => { if (me?.user) refreshBookings(); }, [me, refreshBookings]);
  useBranchEvents(branchId, ['reservation:new', 'reservation:changed', 'tables:changed'], (e, d) => {
    if (e === 'reservation:new') toast(tr("📅 New reservation: {0}, {1} guest(s) on {2} at {3}", d.customer_name, d.pax, d.date, d.time));
    refreshBookings();
  });
  useBranchEvents(branchId, ['order:new', 'stock:low', 'order:ready', 'order:paid'], (e, d) => {
    if (e === 'order:new') { toast(tr("New {0} order {1}{2}", d.source.toUpperCase(), d.ticket_ref, d.table ? ' · table ' + d.table : '')); refreshPending(); }
    if (e === 'stock:low') toast(tr("Low stock: {0} ({1} {2})", d.name, fmtQty(d.qty), d.unit), true);
    if (e === 'order:paid') { toast(tr("💳 Order {0} paid online ({1})", d.ticket_ref, fmt(d.amount))); refreshPending(); }
    if (e === 'order:ready') {
      toast(tr("🔔 Order ready: {0}{1}", d.ticket_ref, d.table_name ? ' · Table ' + d.table_name : d.customer_name ? ' · ' + d.customer_name : ''));
      setReady((r) => [d, ...r.filter((x) => x.ticket_id !== d.ticket_id)]);
    }
  });

  const print = async (ticketId: number) => {
    const r = await api.post('/pos/tickets/' + ticketId + '/print-receipt', {}).catch(() => ({ browser: true }));
    if (!r.browser) return toast(tr("Receipt sent to printer"));
    setPrintData(await api.get(`/pos/tickets/${ticketId}/receipt`));
    setTimeout(() => { window.print(); setPrintData(null); }, 150);
  };

  if (loading) return <Loading />;
  if (!me?.user) return <Navigate to={`/${tenant}`} replace />;
  if (!can('pos.access')) return <div className="card">{tr("You do not have POS access.")}</div>;

  // Registered terminals go back to the PIN screen; a normal browser goes back to the login page.
  const logout = async () => { const m = await api.post('/auth/logout', {}).then(reload); nav(`/${tenant}/${m?.device ? 'terminal' : 'login'}`); };

  return (
    <div className="app">
      <AppBar onLock={logout} right={<>
        {ready.length > 0 && <button className="primary ready-bell" onClick={() => setShowReady(true)}>🔔 {ready.length} {tr(" ready")}</button>}
        <button onClick={() => setShowBookings(true)}>{tr("📅 Bookings")}{bookings > 0 ? ` (${bookings})` : ''}</button>
        {day ? <span className="day-pill">{tr("● Day open · fund ")}{fmt(day.opening_float)}</span>
          : day === null && can('pos.register') && <button className="primary" onClick={() => setAskDay(true)}>{tr("Open day")}</button>}
        {can('kds.view') && <Link className="btn" to={`/${tenant}/kds`}>{tr("👨‍🍳 KDS")}</Link>}
      </>}>
        <button className={view.kind === 'floor' ? 'active' : ''} onClick={() => setView({ kind: 'floor' })}>{tr("🪑 Floor plan")}</button>
        <button onClick={() => setNewOrder(true)}>{tr("🛍️ Takeaway / Delivery")}</button>
        <button className={view.kind === 'orders' ? 'active' : ''} onClick={() => setView({ kind: 'orders' })}>
          {tr("🧾 Orders ")}{pendingCount > 0 && <span className="pill bad">{pendingCount} {tr(" new")}</span>}
        </button>
      </AppBar>
      <div className="app-body no-print">
        {view.kind === 'floor' && <FloorView onOpen={(id) => setView({ kind: 'order', id })} />}
        {view.kind === 'order' && <OrderView key={view.id} ticketId={view.id} currency={currency} onBack={() => setView({ kind: mode === 'takeaway' ? 'orders' : 'floor' })}
          onOpen={(id) => setView({ kind: 'order', id })} onPrint={print} />}
        {view.kind === 'orders' && <OrdersView onOpen={(id) => setView({ kind: 'order', id })} onChanged={refreshPending} />}
      </div>
      {newOrder && <NewOrderModal onClose={() => setNewOrder(false)} onCreated={(id) => { setNewOrder(false); setView({ kind: 'order', id }); }} />}
      {printData && <div className="printable"><Receipt data={printData} /></div>}
      {showBookings && (
        <Modal title={tr("📅 Today's reservations")} onClose={() => setShowBookings(false)} wide>
          <ReservationsPanel from={todayLocal()} to={todayLocal()} onSeated={(id) => { setShowBookings(false); setView({ kind: 'order', id }); }} />
        </Modal>
      )}
      {showReady && (
        <Modal title={tr("🔔 Orders ready to serve")} onClose={() => setShowReady(false)}>
          <div className="stack">
            {ready.map((r) => (
              <div key={r.ticket_id} className="row between card" style={{ padding: '.6rem' }}>
                <div><b>{r.ticket_ref}</b> · {r.table_name ? tr("Table {0}", r.table_name) : tr(ORDER_TYPES[r.order_type])}{r.customer_name ? ` · ${r.customer_name}` : ''}</div>
                <div className="row">
                  <button className="primary" onClick={() => { setShowReady(false); setReady((x) => x.filter((y) => y.ticket_id !== r.ticket_id)); setView({ kind: 'order', id: r.ticket_id }); }}>{tr("Open")}</button>
                  <button onClick={() => setReady((x) => x.filter((y) => y.ticket_id !== r.ticket_id))}>{tr("Done")}</button>
                </div>
              </div>
            ))}
            {ready.length === 0 && <p className="muted">{tr("Nothing waiting.")}</p>}
          </div>
        </Modal>
      )}
      {day === null && askDay && can('pos.register') && <OpenDayModal currency={currency} onOpened={loadDay} onClose={() => setAskDay(false)} />}
    </div>
  );
}

// ---------------- Floor plan ----------------
function FloorView({ onOpen }: { onOpen: (id: number) => void }) {
  const tr = useTr();
  const { branchId, can } = useSession();
  const [data, setData] = useState<{ floors: any[]; tables: any[] } | null>(null);
  const [floorId, setFloorId] = useState<number | null>(null);
  const [pax, setPax] = useState<any | null>(null);
  const [paxVal, setPaxVal] = useState('');
  const [menu, setMenu] = useState<any | null>(null);
  const run = useAction();
  const withOverride = useOverride(useCallback(() => api.get('/auth/staff'), []));

  const load = useCallback(() => api.get('/pos/floor').then((d) => { setData(d); setFloorId((f) => f ?? d.floors[0]?.id ?? null); }), []);
  useEffect(() => { load(); const i = setInterval(load, 30000); return () => clearInterval(i); }, [load]);
  useBranchEvents(branchId, ['tables:changed', 'order:new', 'kds:update'], () => load());

  if (!data) return <Loading />;
  const tables = data.tables.filter((t) => t.floor_id === floorId);
  const floor = data.floors.find((f) => f.id === floorId);

  const open = async () => {
    const n = Number(paxVal);
    if (!n) return;
    const t = await run(() => api.post(`/pos/tables/${pax.id}/open`, { pax: n }));
    setPax(null);
    if (t) onOpen(t.id);
  };

  return (
    <div className="stack" style={{ flex: 1, gap: 0 }}>
      <div className="floor-tabs">
        {data.floors.map((f) => <button key={f.id} className={f.id === floorId ? 'primary' : ''} onClick={() => setFloorId(f.id)}>{f.name}</button>)}
        <div className="grow" />
        <div className="legend">
          <span><i style={{ borderColor: '#16a34a', background: '#f0fdf4' }} />{tr("Free")}</span>
          <span><i style={{ borderColor: '#ea580c', background: '#fff7ed' }} />{tr("Occupied")}</span>
          <span><i style={{ borderColor: '#2563eb', background: '#eff6ff' }} />{tr("Served")}</span>
          <span><i style={{ borderColor: '#7c3aed', background: '#f5f3ff' }} />{tr("Bill requested")}</span>
          <span><i style={{ borderColor: '#dc2626', background: '#fee2e2' }} />{tr("Customer order")}</span>
        </div>
      </div>
      <div className="floor" style={{ padding: 8 }}>
        <ScaledPlan width={floor?.width ?? 1200} height={floor?.height ?? 800}>
        {(floor?.layout ?? []).map((d: any) => <Decor key={d.id} d={d} />)}
        {tables.map((t) => {
          const cls = t.ticket_id ? (t.ticket_status === 'pending' || t.customer_pending ? 'occupied alert' : t.guest_status === 'served' ? 'served' : t.guest_status === 'bill_requested' ? 'bill_requested' : 'occupied') : '';
          return (
            <div key={t.id} className={`tbl ${t.shape === 'round' ? 'round' : ''} ${cls}`}
              style={{ left: t.pos_x, top: t.pos_y, width: t.width, height: t.height }}
              onClick={() => (t.ticket_id ? setMenu(t) : (setPax(t), setPaxVal('')))}>
              <div>{t.name}</div>
              {t.ticket_id ? <>
                <div className="meta">{t.pax} {tr(" pax · ")}{fmt(t.total)}</div>
                <div className="meta">{time(t.opened_at)}{t.ticket_count > 1 ? tr(" · {0} checks", t.ticket_count) : ''}</div>
              </> : <>
                <div className="meta">{t.seats} {tr(" seats")}</div>
                {t.reserved_at && <div className="meta" style={{ color: '#7c3aed', fontWeight: 700 }}>📅 {t.reserved_at}</div>}
              </>}
            </div>
          );
        })}
        </ScaledPlan>
      </div>
      {pax && (
        <Modal title={tr("Table {0} — number of guests", pax.name)} onClose={() => setPax(null)}>
          <div style={{ maxWidth: 320, margin: 'auto' }} className="stack">
            <div className="center" style={{ fontSize: '2.4rem', fontWeight: 800 }}>{paxVal || '0'} <span className="muted small">{tr("PAX")}</span></div>
            <div className="row">{[1, 2, 3, 4, 5, 6].map((n) => <button key={n} className="grow" onClick={() => setPaxVal(String(n))}>{n}</button>)}</div>
            <Numpad value={paxVal} onChange={setPaxVal} decimals={false} max={3} />
            <button className="primary lg" disabled={!Number(paxVal)} onClick={open}>{tr("Open table")}</button>
          </div>
        </Modal>
      )}
      {menu && (
        <Modal title={tr("Table {0}", menu.name)} onClose={() => setMenu(null)}>
          <div className="stack">
            <div className="muted">{menu.ticket_ref} · {menu.pax} {tr(" pax · ")}{fmt(menu.total)} · {menu.waiter_name}</div>
            <button className="primary lg" onClick={() => onOpen(menu.ticket_id)}>{tr("Open order")}</button>
            {menu.ticket_count > 1 && <button className="lg" onClick={async () => {
              const list = await api.get<any[]>('/pos/tickets?status=active');
              const ids = list.filter((x) => x.table_name === menu.name);
              const pick = prompt('Open which check?\n' + ids.map((x, i) => `${i + 1}. ${x.ticket_ref} ${fmt(x.total)}`).join('\n'), '1');
              const sel = ids[Number(pick) - 1];
              if (sel) onOpen(sel.id);
            }}>{tr("Choose split check (")}{menu.ticket_count})</button>}
            {can('pos.access') && <button className="danger lg" onClick={async () => {
              const reason = prompt(tr("Reason for cancelling the order and clearing this table?"));
              if (!reason) return;
              const r = await run(() => withOverride((override) => api.post(`/pos/tables/${menu.id}/clear`, { reason, override })), tr("Table cleared"));
              if (r) { setMenu(null); load(); }
            }}>{tr("Cancel order & clear table")}</button>}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------- Order screen ----------------
function OrderView({ ticketId, currency, onBack, onOpen, onPrint }: {
  ticketId: number; currency: string; onBack: () => void; onOpen: (id: number) => void; onPrint: (id: number) => void;
}) {
  const tr = useTr();
  const { can, branchId } = useSession();
  const [t, setT] = useState<any>(null);
  const [menu, setMenu] = useState<any>(null);
  const [cat, setCat] = useState<number | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [itemModal, setItemModal] = useState<any>(null);
  const [modal, setModal] = useState<null | 'pay' | 'discount' | 'split' | 'customer' | 'void' | 'line'>(null);
  const run = useAction();
  const toast = useToast();
  const withOverride = useOverride(useCallback(() => api.get('/auth/staff'), []));

  const load = useCallback(() => api.get(`/pos/tickets/${ticketId}`).then(setT), [ticketId]);
  useEffect(() => { load(); }, [load]);
  // Prices differ per order type, so the palette follows the ticket's order type.
  const orderType = t?.order_type;
  useEffect(() => { if (orderType) api.get(`/menu/palette?order_type=${orderType}`).then((m) => { setMenu(m); setCat((c) => c ?? m.categories[0]?.id ?? null); }); }, [orderType]);
  useBranchEvents(branchId, ['tables:changed', 'kds:update'], (_e, d) => { if (!d?.ticket_id || d.ticket_id === ticketId) load(); });

  const items = useMemo(() => (menu?.items ?? []).filter((i: any) => i.category_id === cat), [menu, cat]);
  if (!t || !menu) return <Loading />;
  const editable = t.status === 'open' || t.status === 'pending';
  const line = t.lines.find((l: any) => l.id === sel);
  const unsent = t.lines.filter((l: any) => l.status === 'active' && l.kitchen_status === 'new').length;

  const addItem = (item: any) => {
    if (!editable) return;
    if (item.sizes.length || item.modifier_group_ids.length) return setItemModal(item);
    run(() => api.post(`/pos/tickets/${ticketId}/lines`, { menu_item_id: item.id, qty: 1 })).then((r) => r && setT(r));
  };
  const send = async () => {
    const r = await run(() => api.post(`/pos/tickets/${ticketId}/send`, {}));
    if (r) { setT(r.ticket); toast(r.sent ? `${r.sent} line(s) sent to kitchen / bar` : 'Order accepted'); }
  };

  return (
    <div className="order">
      <div className="ticket">
        <div className="ticket-head row between">
          <div>
            <b>{t.ticket_ref}</b> <span className="pill">{tr(ORDER_TYPES[t.order_type])}</span>
            {t.status !== 'open' && <span className={`pill ${t.status === 'pending' ? 'bad' : t.status === 'paid' ? 'ok' : ''}`}>{t.status}</span>}
            <div className="small muted">
              {t.table_name && <>{tr("Table ")}{t.table_name} · {t.pax} {tr(" pax · ")}</>}{t.channel_name}
              {t.client_name && <> · 👤 {t.client_name}</>}{t.customer_name && !t.client_name && <> · {t.customer_name}</>}
              {t.delivery_company_name && <> · 🛵 {t.delivery_company_name}</>}
              {t.delivery_lat != null && <> · <a href={mapLink(t.delivery_lat, t.delivery_lng)} target="_blank" rel="noreferrer">{tr("📍 map")}</a></>}
              {t.scheduled_for && <div className="warn"><b>{tr("📅 Booked for ")}{new Date(t.scheduled_for).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>{t.pax > 1 ? tr(" · {0} people", t.pax) : ''}</div>}
            </div>
          </div>
          <button onClick={onBack}>{tr("← Back")}</button>
        </div>
        <div className="lines">
          {t.lines.map((l: any) => (
            <div key={l.id} className={`line ${l.id === sel ? 'sel' : ''} ${l.status === 'void' ? 'void' : ''}`}
              onClick={() => { if (l.status === 'active' && editable) { setSel(l.id); setModal('line'); } }}>
              <div className="row between nowrap">
                <span><b>{fmtQty(l.qty)}×</b> {l.item_name}{l.size_name && ` (${l.size_name})`}{l.seat_no ? <span className="pill">{tr("S")}{l.seat_no}</span> : null}</span>
                <span>{fmt(l.line_total)}</span>
              </div>
              {(l.modifiers as any[]).length > 0 && <div className="mods">+ {(l.modifiers as any[]).map((m) => m.name).join(', ')}</div>}
              {l.notes && <div className="mods">📝 {l.notes}</div>}
              {l.allergy_note && <div className="allergy">⚠ {l.allergy_note}</div>}
              <div className="small muted">
                {l.status === 'void' ? tr("VOID — {0}", l.void_reason) : l.kitchen_status === 'new' ? <span className="warn">{tr("● not sent")}{l.from_customer ? tr(" (customer)") : ''}</span> : `✓ ${l.kitchen_status}`}
                {l.refunded_qty > 0 && tr(" · refunded {0}", fmtQty(l.refunded_qty))}
              </div>
            </div>
          ))}
          {t.lines.length === 0 && <div className="muted center" style={{ padding: '2rem' }}>{tr("Tap menu items to add them")}</div>}
        </div>
        <div className="totals">
          <div className="row between small"><span>{tr("Subtotal")}</span><span>{fmt(t.subtotal)}</span></div>
          {t.discount_amount > 0 && <div className="row between small"><span>{tr("Discount")}</span><span>-{fmt(t.discount_amount)}</span></div>}
          <div className="row between small"><span>{tr("Tax")}</span><span>{fmt(t.tax_amount)}</span></div>
          {t.paid_amount > 0 && <div className="row between small"><span>{tr("Paid")}</span><span>{fmt(t.paid_amount)}</span></div>}
          <div className="row between"><span>{t.paid_amount > 0 ? tr("Balance due") : tr("Total")}</span><span className="grand">{fmt(t.paid_amount > 0 ? t.balance_due : t.total, currency)}</span></div>
        </div>
        {editable ? (
          <div className="actions">
            {t.status === 'pending' && t.scheduled_for && new Date(t.scheduled_for).getTime() > Date.now() + 3600_000 ? (
              // Advance booking: accept now, send to the kitchen nearer the time.
              <button className="dark lg" style={{ gridColumn: 'span 2' }} onClick={() => run(() => api.post(`/pos/tickets/${ticketId}/accept`, {}), tr("Order accepted — send it to the kitchen nearer the time")).then((r) => r && setT(r))}>
                {tr("Accept (cook later)")}</button>
            ) : (
              <button className="dark lg" style={{ gridColumn: 'span 2' }} disabled={!unsent && t.status !== 'pending'} onClick={send}>
                {t.status === 'pending' ? tr("Accept order") : tr("Send{0}", unsent ? ` (${unsent})` : '')}
              </button>
            )}
            {can('pos.payment') && <button className="primary lg" style={{ gridColumn: 'span 2' }} disabled={!t.lines.some((l: any) => l.status === 'active')} onClick={() => setModal('pay')}>{tr("Pay")}</button>}
            <button onClick={() => setModal('customer')}>{tr("Customer")}</button>
            <button onClick={() => setModal('discount')}>{tr("Discount")}</button>
            {can('pos.split') && <button onClick={() => setModal('split')}>{tr("Split")}</button>}
            <button onClick={async () => { await api.patch(`/pos/tickets/${ticketId}`, { guest_status: 'bill_requested' }).catch(() => undefined); onPrint(ticketId); }}>{tr("Bill")}</button>
            {t.table_id && <button onClick={async () => {
              const pax = prompt(tr("Number of guests"), String(t.pax));
              if (pax && Number(pax) > 0) run(() => api.patch(`/pos/tickets/${ticketId}`, { pax: Number(pax) })).then((r) => r && setT(r));
            }}>{tr("Guests")}</button>}
            <button className="danger" onClick={async () => {
              const reason = prompt(tr("Cancel the whole ticket — reason?"));
              if (!reason) return;
              const r = await run(() => withOverride((override) => api.post(`/pos/tickets/${ticketId}/cancel`, { reason, override })), tr("Ticket cancelled"));
              if (r) onBack();
            }}>{tr("Cancel")}</button>
          </div>
        ) : (
          <div className="actions">
            <button className="lg" style={{ gridColumn: 'span 2' }} onClick={() => onPrint(ticketId)}>{tr("Print receipt")}</button>
            <button className="primary lg" style={{ gridColumn: 'span 2' }} onClick={onBack}>{tr("Done")}</button>
          </div>
        )}
      </div>

      <div className="palette">
        <div className="cats">
          {menu.categories.map((c: any) => (
            <button key={c.id} style={c.id === cat ? { background: c.color, color: '#fff', borderColor: c.color } : { borderBottom: `4px solid ${c.color}` }}
              onClick={() => setCat(c.id)}>{c.name}</button>
          ))}
        </div>
        <div className="items">
          {items.map((i: any) => {
            const c = menu.categories.find((x: any) => x.id === i.category_id);
            return (
              <button key={i.id} className="item" style={{ borderLeftColor: c?.color }} disabled={!editable} onClick={() => addItem(i)}>
                {i.image_url && <img className="item-img" src={i.image_url} alt="" />}
                {i.name}
                <span className="price">{i.sizes.length ? i.sizes.map((s: any) => `${s.name[0]} ${fmt(s.price)}`).join(' · ') : fmt(i.price)}</span>
                {i.allergens?.length > 0 && <span className="small bad">⚠ {i.allergens.join(', ')}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {itemModal && <ItemModal item={itemModal} menu={menu} pax={t.pax} onClose={() => setItemModal(null)} onAdd={async (body) => {
        const r = await run(() => api.post(`/pos/tickets/${ticketId}/lines`, body));
        if (r) { setT(r); setItemModal(null); }
      }} />}
      {modal === 'line' && line && <LineModal line={line} onClose={() => setModal(null)} onSaved={(r) => { setT(r); setModal(null); }} withOverride={withOverride} ticketId={ticketId} />}
      {modal === 'pay' && <PaymentModal ticket={t} onClose={() => setModal(null)} onPaid={(r) => { setT(r.ticket); if (r.ticket.status === 'paid') { setModal(null); toast(r.change > 0 ? `Paid — change ${fmt(r.change, currency)}` : 'Paid'); onPrint(ticketId); } }} />}
      {modal === 'discount' && <DiscountModal ticket={t} withOverride={withOverride} onClose={() => setModal(null)} onSaved={(r) => { setT(r); setModal(null); }} />}
      {modal === 'split' && <SplitModal ticket={t} onClose={() => setModal(null)} onSplit={(r) => { setModal(null); toast(tr("New check {0}", r.split.ticket_ref)); onOpen(r.split.id); }} />}
      {modal === 'customer' && <CustomerModal ticket={t} onClose={() => setModal(null)} onSaved={(r) => { setT(r); setModal(null); }} />}
    </div>
  );
}

function ItemModal({ item, menu, pax, onClose, onAdd }: { item: any; menu: any; pax: number; onClose: () => void; onAdd: (b: any) => void }) {
  const tr = useTr();
  const [size, setSize] = useState<number | null>(item.sizes[0]?.id ?? null);
  const [mods, setMods] = useState<number[]>([]);
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [allergy, setAllergy] = useState('');
  const [seat, setSeat] = useState<number | null>(null);
  const groups = menu.modifier_groups.filter((g: any) => item.modifier_group_ids.includes(g.id));
  return (
    <Modal title={item.name} onClose={onClose}>
      <div className="stack">
        {item.sizes.length > 0 && <>
          <h3>{tr("Size")}</h3>
          <div className="row">{item.sizes.map((s: any) => (
            <button key={s.id} className={`lg ${size === s.id ? 'dark' : ''}`} onClick={() => setSize(s.id)}>{s.name} · {fmt(s.price)}</button>
          ))}</div>
        </>}
        {groups.map((g: any) => (
          <div key={g.id}>
            <h3>{g.name} <span className="small muted">{g.min_select > 0 ? tr("choose {0}-{1}", g.min_select, g.max_select) : tr("up to {0}", g.max_select)}</span></h3>
            <div className="row">{g.modifiers.map((m: any) => (
              <button key={m.id} className={mods.includes(m.id) ? 'dark' : ''} onClick={() => setMods((x) => (x.includes(m.id) ? x.filter((y) => y !== m.id) : [...x, m.id]))}>
                {m.name}{m.price_delta ? ` +${fmt(m.price_delta)}` : ''}
              </button>
            ))}</div>
          </div>
        ))}
        <CookingNotes value={notes} onChange={setNotes} />
        <label className="field">{tr("Allergy warning")}<input value={allergy} onChange={(e) => setAllergy(e.target.value)} placeholder={tr("e.g. peanut allergy")} /></label>
        <div className="row">
          <span>{tr("Seat")}</span>
          {Array.from({ length: Math.min(Math.max(pax, 1), 12) }, (_, i) => i + 1).map((n) => (
            <button key={n} className={`sm ${seat === n ? 'dark' : ''}`} onClick={() => setSeat(seat === n ? null : n)}>{n}</button>
          ))}
        </div>
        <div className="row between">
          <div className="row"><button className="lg" onClick={() => setQty(Math.max(1, qty - 1))}>−</button><b style={{ fontSize: '1.4rem' }}>{qty}</b><button className="lg" onClick={() => setQty(qty + 1)}>+</button></div>
          <button className="primary lg" onClick={() => onAdd({ menu_item_id: item.id, size_id: size, qty, modifier_ids: mods, notes: notes || null, allergy_note: allergy || null, seat_no: seat })}>{tr("Add to order")}</button>
        </div>
      </div>
    </Modal>
  );
}

function LineModal({ line, ticketId, onClose, onSaved, withOverride }: { line: any; ticketId: number; onClose: () => void; onSaved: (t: any) => void; withOverride: any }) {
  const tr = useTr();
  const run = useAction();
  const sent = line.kitchen_status !== 'new';
  const [qty, setQty] = useState(line.qty);
  const [notes, setNotes] = useState(line.notes ?? '');
  const [allergy, setAllergy] = useState(line.allergy_note ?? '');
  const [voidQty, setVoidQty] = useState(line.qty);
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const base = `/pos/tickets/${ticketId}/lines/${line.id}`;
  return (
    <Modal title={`${line.item_name}${line.size_name ? ` (${line.size_name})` : ''}`} onClose={onClose}>
      {!sent ? (
        <div className="stack">
          <div className="row"><button className="lg" onClick={() => setQty(Math.max(1, qty - 1))}>−</button><b style={{ fontSize: '1.4rem' }}>{qty}</b><button className="lg" onClick={() => setQty(qty + 1)}>+</button></div>
          <CookingNotes value={notes} onChange={setNotes} />
          <label className="field">{tr("Allergy warning")}<input value={allergy} onChange={(e) => setAllergy(e.target.value)} /></label>
          <div className="row between">
            <button className="danger" onClick={async () => { const r = await run(() => api.del(base)); if (r) onSaved(r); }}>{tr("Remove")}</button>
            <button className="primary lg" onClick={async () => { const r = await run(() => api.patch(base, { qty, notes: notes || null, allergy_note: allergy || null })); if (r) onSaved(r); }}>{tr("Save")}</button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="muted">{tr("This line was already sent to the kitchen. Voiding is logged and shown on X/Z reports.")}</p>
          <div className="row">{tr("Void quantity")}<button onClick={() => setVoidQty(Math.max(1, voidQty - 1))}>−</button><b>{fmtQty(voidQty)}</b>
            <button onClick={() => setVoidQty(Math.min(line.qty, voidQty + 1))}>+</button> {tr(" of ")}{fmtQty(line.qty)}
          </div>
          <div className="row">{['Customer changed mind', 'Wrong item', 'Quality issue', 'Took too long'].map((r) => <button key={r} className="sm" onClick={() => setReason(r)}>{r}</button>)}</div>
          <label className="field">{tr("Reason")}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> {tr(" Return ingredients to stock (not prepared)")}</label>
          <button className="danger lg" disabled={!reason} onClick={async () => {
            const r = await run(() => withOverride((override: any) => api.post(`${base}/void`, { reason, qty: voidQty, return_to_stock: restock, override })), tr("Line voided"));
            if (r) onSaved(r);
          }}>{tr("Void line")}</button>
        </div>
      )}
    </Modal>
  );
}

function PaymentModal({ ticket, onClose, onPaid }: { ticket: any; onClose: () => void; onPaid: (r: any) => void }) {
  const tr = useTr();
  const [methods, setMethods] = useState<any[]>([]);
  const [rates, setRates] = useState<any>({ current: [] });
  const [cur, setCur] = useState(ticket.currency);
  const [amount, setAmount] = useState('');
  const [lines, setLines] = useState<{ method: any; currency: string; amount: number; rate: number }[]>([]);
  const run = useAction();
  useEffect(() => {
    api.get('/payment-methods').then((m) => setMethods(m.filter((x: any) => x.active)));
    api.get('/rates').then(setRates);
  }, []);
  const rateOf = (c: string) => (c === ticket.currency ? 1 : rates.current.find((r: any) => r.currency_code === c)?.rate ?? 0);
  const due = Math.max(0, ticket.total - ticket.paid_amount);
  const entered = lines.reduce((s, l) => s + l.amount * l.rate, 0);
  const remaining = Math.max(0, due - entered);
  const change = Math.max(0, entered - due);
  const currencies = [ticket.currency, ...new Set(rates.current.map((r: any) => r.currency_code as string))];

  const add = (m: any) => {
    const r = rateOf(cur);
    const a = Number(amount) || Math.ceil((remaining / r) * 100) / 100;
    if (!a) return;
    setLines((x) => [...x, { method: m, currency: cur, amount: a, rate: r }]);
    setAmount('');
  };
  const submit = async () => {
    const r = await run(() => api.post(`/pos/tickets/${ticket.id}/payments`, {
      payments: lines.map((l) => ({ payment_method_id: l.method.id, currency_code: l.currency, amount: l.amount })),
    }));
    if (r) { setLines([]); onPaid(r); }
  };
  return (
    <Modal title={tr("Payment — {0}", ticket.ticket_ref)} onClose={onClose} wide>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow stack" style={{ minWidth: 280 }}>
          <div className="grid2">
            <div className="stat"><div className="l">{tr("Due")}</div><div className="v">{fmt(due, ticket.currency)}</div></div>
            <div className="stat"><div className="l">{change > 0 ? tr("Change") : tr("Remaining")}</div><div className={`v ${change > 0 ? 'ok' : ''}`}>{fmt(change > 0 ? change : remaining, ticket.currency)}</div></div>
          </div>
          <div className="row">
            {currencies.map((c) => <button key={c} className={c === cur ? 'dark' : ''} onClick={() => setCur(c)}>{c}{c !== ticket.currency ? ` @${rateOf(c)}` : ''}</button>)}
          </div>
          {cur !== ticket.currency && <div className="small muted">{tr("Remaining in ")}{cur}: {fmt(remaining / (rateOf(cur) || 1))}</div>}
          <div className="row">{methods.map((m) => (
            <button key={m.id} className="lg grow" disabled={m.method_type === 'credit' && !ticket.client_id} title={m.method_type === 'credit' && !ticket.client_id ? tr("Select a credit client first") : ''} onClick={() => add(m)}>{m.name}</button>
          ))}</div>
          <table className="data">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}><td>{l.method.name}</td><td className="num">{fmt(l.amount, l.currency)}</td>
                  <td className="num muted">{l.currency !== ticket.currency ? fmt(l.amount * l.rate, ticket.currency) : ''}</td>
                  <td><button className="sm" onClick={() => setLines((x) => x.filter((_, j) => j !== i))}>✕</button></td></tr>
              ))}
              {ticket.payments.filter((p: any) => p.kind === 'payment').map((p: any) => (
                <tr key={'p' + p.id} className="muted"><td>{p.method_name} {tr(" (taken)")}</td><td className="num">{fmt(p.amount, p.currency_code)}</td><td /><td /></tr>
              ))}
            </tbody>
          </table>
          <button className="primary lg" disabled={!lines.length && due > 0.004} onClick={submit}>
            {due <= 0.004 ? tr("Close ticket (already paid online)") : entered >= due - 0.004 ? tr("Validate & close") : tr("Take partial payment")}
          </button>
        </div>
        <div style={{ width: 280 }}>
          <div className="center" style={{ fontSize: '2rem', fontWeight: 800, minHeight: 50 }}>{amount || '—'} <span className="small muted">{cur}</span></div>
          <Numpad value={amount} onChange={setAmount} />
          <div className="small muted center" style={{ marginTop: 6 }}>{tr("Type an amount, then tap a payment method. Empty amount = pay remaining.")}</div>
        </div>
      </div>
    </Modal>
  );
}

function DiscountModal({ ticket, onClose, onSaved, withOverride }: { ticket: any; onClose: () => void; onSaved: (t: any) => void; withOverride: any }) {
  const tr = useTr();
  const [type, setType] = useState<'percent' | 'fixed'>(ticket.discount_type ?? 'percent');
  const [value, setValue] = useState(String(ticket.discount_value || ''));
  const [coupon, setCoupon] = useState('');
  const run = useAction();
  const apply = (body: any) => run(() => withOverride((override: any) => api.post(`/pos/tickets/${ticket.id}/discount`, { ...body, override }))).then((r) => r && onSaved(r));
  return (
    <Modal title={tr("Discount")} onClose={onClose}>
      <div className="stack">
        <div className="row"><button className={type === 'percent' ? 'dark' : ''} onClick={() => setType('percent')}>{tr("% Percent")}</button><button className={type === 'fixed' ? 'dark' : ''} onClick={() => setType('fixed')}>{tr("Fixed amount")}</button></div>
        <div className="row">{(type === 'percent' ? [5, 10, 15, 20, 50] : [50, 100, 200, 500]).map((v) => <button key={v} onClick={() => setValue(String(v))}>{v}{type === 'percent' ? '%' : ''}</button>)}</div>
        <input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="row">
          <button className="primary" onClick={() => apply({ discount_type: type, value: Number(value) })}>{tr("Apply discount")}</button>
          {ticket.discount_type && <button onClick={() => apply({ discount_type: null })}>{tr("Remove discount")}</button>}
        </div>
        <hr />
        <label className="field">{tr("Coupon code")}<input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} /></label>
        <button disabled={!coupon} onClick={() => apply({ coupon_code: coupon })}>{tr("Apply coupon")}</button>
      </div>
    </Modal>
  );
}

function SplitModal({ ticket, onClose, onSplit }: { ticket: any; onClose: () => void; onSplit: (r: any) => void }) {
  const tr = useTr();
  const [qty, setQty] = useState<Record<number, number>>({});
  const run = useAction();
  const active = ticket.lines.filter((l: any) => l.status === 'active');
  const seats = [...new Set(active.map((l: any) => l.seat_no).filter(Boolean))] as number[];
  const splitTotal = active.reduce((s: number, l: any) => s + (qty[l.id] ?? 0) * (l.line_total / l.qty), 0);
  return (
    <Modal title={tr("Split check")} onClose={onClose}>
      <div className="stack">
        {seats.length > 0 && <div className="row"><b>{tr("By seat:")}</b>{seats.map((s) => (
          <button key={s} onClick={() => run(() => api.post(`/pos/tickets/${ticket.id}/split`, { mode: 'seat', seat_no: s })).then((r) => r && onSplit(r))}>{tr("Seat ")}{s}</button>
        ))}</div>}
        <b>{tr("By items — tap to move to a new check:")}</b>
        {active.map((l: any) => (
          <div key={l.id} className="row between">
            <span>{fmtQty(l.qty)}× {l.item_name}{l.size_name ? ` (${l.size_name})` : ''}</span>
            <div className="row">
              <button className="sm" onClick={() => setQty((q) => ({ ...q, [l.id]: Math.max(0, (q[l.id] ?? 0) - 1) }))}>−</button>
              <b>{qty[l.id] ?? 0}</b>
              <button className="sm" onClick={() => setQty((q) => ({ ...q, [l.id]: Math.min(l.qty, (q[l.id] ?? 0) + 1) }))}>+</button>
            </div>
          </div>
        ))}
        <button className="primary lg" disabled={!splitTotal} onClick={() => run(() => api.post(`/pos/tickets/${ticket.id}/split`, {
          mode: 'items', lines: Object.entries(qty).filter(([, q]) => q > 0).map(([id, q]) => ({ line_id: Number(id), qty: q })),
        })).then((r) => r && onSplit(r))}>{tr("Move to new check (")}{fmt(splitTotal)})</button>
        <p className="small muted">{tr("To split by custom amounts, take several partial payments on this check (Pay → enter amount → method).")}</p>
      </div>
    </Modal>
  );
}

function CustomerModal({ ticket, onClose, onSaved }: { ticket: any; onClose: () => void; onSaved: (t: any) => void }) {
  const tr = useTr();
  const [clients, setClients] = useState<any[]>([]);
  const [dcos, setDcos] = useState<any[]>([]);
  const [zones, setZones] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [f, setF] = useState({
    order_type: ticket.order_type, client_id: ticket.client_id, customer_name: ticket.customer_name ?? '', customer_phone: ticket.customer_phone ?? '',
    delivery_company_id: ticket.delivery_company_id, delivery_zone_id: ticket.delivery_zone_id, delivery_address: ticket.delivery_address ?? '', notes: ticket.notes ?? '',
  });
  const run = useAction();
  useEffect(() => {
    api.get('/clients?active=true').then(setClients);
    api.get('/delivery/companies?').then((r) => setDcos(r.filter((x: any) => x.active)));
    api.get('/delivery/zones').then((r) => setZones(r.filter((x: any) => x.active)));
  }, []);
  const shown = clients.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || (c.phone ?? '').includes(q)).slice(0, 8);
  const save = () => run(() => api.patch(`/pos/tickets/${ticket.id}`, {
    ...f, customer_name: f.customer_name || null, customer_phone: f.customer_phone || null, delivery_address: f.delivery_address || null, notes: f.notes || null,
    ...(ticket.table_id ? { order_type: undefined } : {}),
  })).then((r) => r && onSaved(r));
  return (
    <Modal title={tr("Customer, client & delivery")} onClose={onClose}>
      <div className="stack">
        {!ticket.table_id && <div className="row">{['takeaway', 'delivery'].map((o) => (
          <button key={o} className={f.order_type === o ? 'dark' : ''} onClick={() => setF({ ...f, order_type: o })}>{tr(ORDER_TYPES[o])}</button>
        ))}</div>}
        <label className="field">{tr("Credit client (from client list)")}<input placeholder={tr("Search name / phone")} value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <div className="row">
          {shown.map((c) => <button key={c.id} className={`sm ${f.client_id === c.id ? 'dark' : ''}`} onClick={() => setF({ ...f, client_id: f.client_id === c.id ? null : c.id })}>
            {c.name}{c.credit_allowed ? ' 💳' : ''}</button>)}
        </div>
        <div className="grid2">
          <label className="field">{tr("Customer name")}<input value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} /></label>
          <label className="field">{tr("Phone")}<input value={f.customer_phone} onChange={(e) => setF({ ...f, customer_phone: e.target.value })} /></label>
          <label className="field">{tr("Delivery partner")}<select value={f.delivery_company_id ?? ''} onChange={(e) => setF({ ...f, delivery_company_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{tr("— none / self pickup —")}</option>{dcos.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></label>
          <label className="field">{tr("Delivery zone")}<select value={f.delivery_zone_id ?? ''} onChange={(e) => setF({ ...f, delivery_zone_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">—</option>{zones.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></label>
        </div>
        <label className="field">{tr("Delivery address")}<input value={f.delivery_address} onChange={(e) => setF({ ...f, delivery_address: e.target.value })} /></label>
        <label className="field">{tr("Order notes")}<input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        <button className="primary lg" onClick={save}>{tr("Save")}</button>
      </div>
    </Modal>
  );
}

function NewOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const tr = useTr();
  const run = useAction();
  const [dcos, setDcos] = useState<any[]>([]);
  const { branchId } = useSession();
  const [f, setF] = useState<any>({ order_type: 'takeaway', delivery_company_id: null, customer_name: '', customer_phone: '', delivery_address: '', pax: '1', later: false, when: '', pin: null });
  const [center, setCenter] = useState<any>(null);
  useEffect(() => {
    api.get('/delivery/companies').then((r) => setDcos(r.filter((x: any) => x.active)));
    api.get('/branches').then((b) => { const x = b.find((y: any) => y.id === branchId); if (x?.lat != null) setCenter({ lat: Number(x.lat), lng: Number(x.lng) }); }).catch(() => undefined);
  }, [branchId]);
  const create = () => run(() => api.post('/pos/tickets', {
    order_type: f.order_type, delivery_company_id: f.delivery_company_id, customer_name: f.customer_name || null,
    customer_phone: f.customer_phone || null, delivery_address: f.delivery_address || null, pax: Number(f.pax) || 1,
    scheduled_for: f.later && f.when ? new Date(f.when).toISOString() : null,
    delivery_lat: f.order_type === 'delivery' ? f.pin?.lat ?? null : null, delivery_lng: f.order_type === 'delivery' ? f.pin?.lng ?? null : null,
  })).then((r) => r && onCreated(r.id));
  return (
    <Modal title={tr("New takeaway / delivery order")} onClose={onClose}>
      <div className="stack">
        <div className="row">{['takeaway', 'delivery'].map((o) => <button key={o} className={`lg grow ${f.order_type === o ? 'dark' : ''}`} onClick={() => setF({ ...f, order_type: o })}>{tr(ORDER_TYPES[o])}</button>)}</div>
        <b>{tr("Delivery partner")}</b>
        <div className="row">
          <button className={!f.delivery_company_id ? 'dark' : ''} onClick={() => setF({ ...f, delivery_company_id: null })}>{tr("None / self pickup")}</button>
          {dcos.map((d) => <button key={d.id} className={f.delivery_company_id === d.id ? 'dark' : ''} onClick={() => setF({ ...f, delivery_company_id: d.id })}>{d.name}</button>)}
        </div>
        <div className="grid2">
          <label className="field">{tr("Customer name")}<input value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} /></label>
          <label className="field">{tr("Phone")}<input value={f.customer_phone} onChange={(e) => setF({ ...f, customer_phone: e.target.value })} /></label>
        </div>
        <div className="grid2">
          <label className="field">{tr("Number of people")}<input type="number" min={1} max={100} value={f.pax} onChange={(e) => setF({ ...f, pax: e.target.value })} /></label>
          <div className="field">{f.order_type === 'delivery' ? tr("Delivery time") : tr("Pickup time")}
            <div className="row nowrap">
              <button type="button" className={`sm ${!f.later ? 'dark' : ''}`} onClick={() => setF({ ...f, later: false })}>{tr("ASAP")}</button>
              <button type="button" className={`sm ${f.later ? 'dark' : ''}`} onClick={() => setF({ ...f, later: true })}>{tr("📅 Later")}</button>
              {f.later && <input type="datetime-local" aria-label={tr("Booked for")} value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} />}
            </div>
          </div>
        </div>
        {f.order_type === 'delivery' && <>
          <label className="field">{tr("Delivery address")}<input value={f.delivery_address} onChange={(e) => setF({ ...f, delivery_address: e.target.value })} /></label>
          <div className="field">{tr("Delivery location (optional)")}<MapPicker value={f.pin} onChange={(pin) => setF((x: any) => ({ ...x, pin }))} center={center} height={220} /></div>
        </>}
        <button className="primary lg" disabled={f.later && !f.when} onClick={create}>{tr("Start order")}</button>
      </div>
    </Modal>
  );
}

function OrdersView({ onOpen, onChanged }: { onOpen: (id: number) => void; onChanged: () => void }) {
  const tr = useTr();
  const { branchId, can } = useSession();
  const [status, setStatus] = useState('active');
  const [rows, setRows] = useState<any[]>([]);
  const [refund, setRefund] = useState<any>(null);
  const load = useCallback(() => {
    const q = status === 'today' ? `?date=${today()}` : `?status=${status}`;
    api.get(`/pos/tickets${q}`).then(setRows);
    onChanged();
  }, [status, onChanged]);
  useEffect(() => { load(); }, [load]);
  useBranchEvents(branchId, ['order:new', 'tables:changed', 'ticket:paid'], () => load());
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '.8rem' }} className="stack">
      <div className="row">
        {[['pending', 'New customer orders'], ['scheduled', '📅 Booked for later'], ['active', 'Open'], ['today', 'Today'], ['paid', 'Paid'], ['cancelled', 'Cancelled']].map(([k, l]) => (
          <button key={k} className={status === k ? 'dark' : ''} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{tr("Ticket")}</th><th>{tr("Type")}</th><th>{tr("Channel")}</th><th>{tr("Table / customer")}</th><th>{tr("Status")}</th><th>{tr("Opened")}</th><th className="num">{tr("Total")}</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="click" onClick={() => onOpen(r.id)}>
                <td><b>{r.ticket_ref}</b></td><td>{tr(ORDER_TYPES[r.order_type])}</td><td>{r.channel_name}</td>
                <td>{r.table_name ?? r.customer_name ?? ''}{r.delivery_company_name ? ` · 🛵 ${r.delivery_company_name}` : ''}</td>
                <td><span className={`pill ${r.status === 'pending' ? 'bad' : r.status === 'paid' ? 'ok' : r.status === 'cancelled' ? '' : 'warn'}`}>{r.status}</span>
                  {r.refund_status !== 'none' && <span className="pill info">{tr("refund ")}{r.refund_status}</span>}</td>
                <td>{r.scheduled_for ? <b className="warn">📅 {new Date(r.scheduled_for).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b> : time(r.opened_at)}</td><td className="num">{fmt(r.total)}</td>
                <td onClick={(e) => e.stopPropagation()}>{r.status === 'paid' && r.refund_status !== 'full' && can('pos.access') && <button className="sm" onClick={() => setRefund(r)}>{tr("Refund")}</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted">{tr("No orders.")}</td></tr>}
          </tbody>
        </table>
      </div>
      {refund && <RefundModal ticketId={refund.id} onClose={() => { setRefund(null); load(); }} />}
    </div>
  );
}

function RefundModal({ ticketId, onClose }: { ticketId: number; onClose: () => void }) {
  const tr = useTr();
  const [t, setT] = useState<any>(null);
  const [methods, setMethods] = useState<any[]>([]);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<number | null>(null);
  const [restock, setRestock] = useState(false);
  const run = useAction();
  const withOverride = useOverride(useCallback(() => api.get('/auth/staff'), []));
  useEffect(() => { api.get(`/pos/tickets/${ticketId}`).then(setT); api.get('/payment-methods').then((m) => { setMethods(m); setMethod(m[0]?.id); }); }, [ticketId]);
  if (!t) return null;
  const sel = Object.entries(qty).filter(([, q]) => q > 0).map(([id, q]) => ({ line_id: Number(id), qty: q }));
  return (
    <Modal title={tr("Refund {0}", t.ticket_ref)} onClose={onClose}>
      <div className="stack">
        <div className="muted">{tr("Paid ")}{fmt(t.total)} {tr(" · already refunded ")}{fmt(t.refunded_amount)}</div>
        {t.lines.filter((l: any) => l.status === 'active').map((l: any) => (
          <div key={l.id} className="row between">
            <span>{fmtQty(l.qty - l.refunded_qty)}× {l.item_name}</span>
            <div className="row">
              <button className="sm" onClick={() => setQty((q) => ({ ...q, [l.id]: Math.max(0, (q[l.id] ?? 0) - 1) }))}>−</button><b>{qty[l.id] ?? 0}</b>
              <button className="sm" onClick={() => setQty((q) => ({ ...q, [l.id]: Math.min(l.qty - l.refunded_qty, (q[l.id] ?? 0) + 1) }))}>+</button>
            </div>
          </div>
        ))}
        <label className="field">{tr("…or custom amount")}<input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={sel.length > 0} /></label>
        <label className="field">{tr("Refund via")}<select value={method ?? ''} onChange={(e) => setMethod(Number(e.target.value))}>{methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label className="field">{tr("Reason")}<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> {tr(" Return refunded items' ingredients to stock")}</label>
        <button className="danger lg" disabled={!reason || (!sel.length && !Number(amount))} onClick={async () => {
          const r = await run(() => withOverride((override: any) => api.post(`/pos/tickets/${ticketId}/refund`, {
            lines: sel.length ? sel : undefined, amount: sel.length ? undefined : Number(amount), reason, payment_method_id: method, restock, override,
          })), tr("Refund recorded"));
          if (r) onClose();
        }}>{t.total === t.refunded_amount ? tr("Fully refunded") : tr("Refund")}</button>
      </div>
    </Modal>
  );
}

/** Opening the day: cashier counts the change fund (opening float) put in the drawer. */
function OpenDayModal({ currency, onOpened, onClose }: { currency: string; onOpened: () => void; onClose: () => void }) {
  const tr = useTr();
  const [fund, setFund] = useState('');
  const run = useAction();
  return (
    <Modal title={tr("Open the day — change fund")} onClose={onClose}>
      <div style={{ maxWidth: 320, margin: 'auto' }} className="stack">
        <p className="muted">{tr("Count the cash placed in the drawer as change fund. It is shown on the X / Z reports and used for the cash reconciliation.")}</p>
        <div className="center" style={{ fontSize: '2.2rem', fontWeight: 800 }}>{fund || '0'} <span className="muted small">{currency}</span></div>
        <Numpad value={fund} onChange={setFund} />
        <button className="primary lg" onClick={async () => {
          if (await run(() => api.post('/pos/session/open', { opening_float: Number(fund) || 0 }), tr("Day opened"))) onOpened();
        }}>{tr("Open day")}</button>
      </div>
    </Modal>
  );
}
