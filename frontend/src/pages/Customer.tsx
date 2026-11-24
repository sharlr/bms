import { useT as useTr } from '../i18n';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { CartList, MenuBrowser, toOrderLines, useCart } from '../components/MenuOrdering';
import { Loading, Modal, useAction } from '../components/ui';
import { fmt, fmtQty, ORDER_TYPES, todayLocal } from '../util';
import { MapPicker } from '../components/Map';

/**
 * Customer ordering. /{tenant}/menu?table=<qr token> → dine-in at that table (company/branch/table auto-detected).
 * /{tenant}/order → choose restaurant, takeaway or delivery, and preferred delivery partner (or self pickup).
 */
export function CustomerOrder() {
  const tr = useTr();
  const { tenant } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const run = useAction();
  const tableToken = sp.get('table');
  const [info, setInfo] = useState<any>(null);
  const [table, setTable] = useState<any>(null);
  const [branchId, setBranchId] = useState<number | null>(null);
  const [menu, setMenu] = useState<any>(null);
  const [partners, setPartners] = useState<any[]>([]);
  const [orderType, setOrderType] = useState<'takeaway' | 'delivery'>('takeaway');
  const [partner, setPartner] = useState<number | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [cust, setCust] = useState<any>({ name: '', phone: '', address: '', notes: '', pax: '1', later: false, date: todayLocal(), time: '', pin: null });
  const { cart, total, count, add, setQty, clear } = useCart();
  const [err, setErr] = useState('');

  useEffect(() => {
    if (tableToken) {
      api.get(`/public/table/${encodeURIComponent(tableToken)}`).then((t) => { setTable(t); setBranchId(t.branch_id); }).catch((e) => setErr(e.message));
    } else {
      api.get('/public/info').then((i) => { setInfo(i); if (i.branches.length === 1) setBranchId(i.branches[0].id); }).catch((e) => setErr(e.message));
    }
  }, [tableToken]);

  useEffect(() => {
    if (!branchId) return;
    api.get(`/public/branches/${branchId}/menu?${tableToken ? `table=${encodeURIComponent(tableToken)}` : `order_type=${orderType}`}`).then(setMenu).catch((e) => setErr(e.message));
    if (!tableToken) api.get(`/public/branches/${branchId}/delivery-companies`).then(setPartners).catch(() => setPartners([]));
  }, [branchId, tableToken, orderType]);

  if (err) return <div className="cust"><div className="card bad">{tr(err)}</div></div>;
  // QR scans skip the restaurant list: wait for the table lookup instead of rendering the branch chooser.
  if (tableToken ? !branchId : !info) return <Loading />;

  // Choose restaurant (online) — or enter a table number manually if the QR can't be scanned.
  if (!branchId) return (
    <div className="cust stack">
      <h1>{info.name}</h1>
      <Link className="btn lg" to={`/${tenant}/reserve`}>{tr("📅 Reserve a table")}</Link>
      <h2>{tr("Choose a restaurant")}</h2>
      {info.branches.map((b: any) => (
        <button key={b.id} className="lg" style={{ justifyContent: 'space-between' }} onClick={() => setBranchId(b.id)}>
          <span><b>{b.name}</b> <span className="muted small">{b.company_name}</span></span><span className="small muted">{b.address}</span>
        </button>
      ))}
      {info.branches.length === 0 && <p className="muted">{tr("Online ordering is not available right now.")}</p>}
      <ManualTable onToken={(tok) => nav(`/${tenant}/menu?table=${encodeURIComponent(tok)}`)} />
    </div>
  );
  if (!menu) return <Loading />;

  const br = info?.branches?.find((x: any) => x.id === branchId);
  const branchPos = br?.lat != null && br?.lng != null ? { lat: Number(br.lat), lng: Number(br.lng) } : null;
  const submit = async () => {
    const body: any = { lines: toOrderLines(cart) };
    if (tableToken) Object.assign(body, { table_token: tableToken, order_type: 'dine_in', notes: cust.notes || undefined });
    else Object.assign(body, {
      branch_id: branchId, order_type: orderType, delivery_company_id: orderType === 'delivery' ? partner : null,
      customer_name: cust.name, customer_phone: cust.phone, delivery_address: orderType === 'delivery' ? cust.address : undefined, notes: cust.notes || undefined,
      pax: Number(cust.pax) || 1, ...(cust.later ? { date: cust.date, time: cust.time } : {}),
      ...(orderType === 'delivery' && cust.pin ? { delivery_lat: cust.pin.lat, delivery_lng: cust.pin.lng } : {}),
    });
    const r = await run(() => api.post('/public/orders', body));
    if (r) { clear(); nav(`/${tenant}/track/${r.order_token}`); }
  };

  return (
    <div className="cust">
      <h1>{menu.company}</h1>
      <div className="muted">{menu.branch}{table ? tr(" · Table {0}", table.table_name) : ''}</div>
      {!tableToken && (
        <div className="card stack" style={{ marginTop: '.8rem' }}>
          <div className="row">{(['takeaway', 'delivery'] as const).map((o) => <button key={o} className={`grow ${orderType === o ? 'dark' : ''}`} onClick={() => { if (o !== orderType) { setOrderType(o); clear(); } }}>{tr(ORDER_TYPES[o])}</button>)}</div>
          {orderType === 'delivery' && <>
            <b>{tr("Delivery partner")}</b>
            <div className="row">
              {partners.map((p) => <button key={p.id} className={partner === p.id ? 'dark' : ''} onClick={() => setPartner(p.id)}>{p.name}</button>)}
              {partners.length === 0 && <span className="muted small">{tr("No delivery partners available — choose takeaway.")}</span>}
            </div>
          </>}
          {orderType === 'takeaway' && <span className="small muted">{tr("Self pickup at ")}{menu.branch}</span>}
          <Link className="btn" to={`/${tenant}/reserve?branch=${branchId}`}>{tr("📅 Reserve a table instead")}</Link>
        </div>
      )}
      <MenuBrowser menu={menu} currency={menu.currency} onAdd={add} />
      {count > 0 && (
        <div className="cartbar">
          <span>{count} {tr(" item(s) · ")}<b>{fmt(total, menu.currency)}</b></span>
          <button className="primary lg" onClick={() => setCheckout(true)}>{tr("View order")}</button>
        </div>
      )}
      {checkout && (
        <Modal title={tr("Your order")} onClose={() => setCheckout(false)}>
          <div className="stack">
            <CartList cart={cart} setQty={setQty} currency={menu.currency} />
            <div className="row between"><b>{tr("Total")}</b><b>{fmt(total, menu.currency)}</b></div>
            {!tableToken && <>
              <label className="field">{tr("Name *")}<input value={cust.name} maxLength={80} onChange={(e) => setCust({ ...cust, name: e.target.value })} /></label>
              <label className="field">{tr("Phone *")}<input type="tel" value={cust.phone} maxLength={20} onChange={(e) => setCust({ ...cust, phone: e.target.value })} /></label>
              <label className="field">{tr("Number of people")}<input type="number" min={1} max={100} value={cust.pax} onChange={(e) => setCust({ ...cust, pax: e.target.value })} /></label>
              <div className="field">{orderType === 'delivery' ? tr("Delivery time") : tr("Pickup time")}
                <div className="row">
                  <button type="button" className={!cust.later ? 'dark' : ''} onClick={() => setCust({ ...cust, later: false })}>{tr("As soon as possible")}</button>
                  <button type="button" className={cust.later ? 'dark' : ''} onClick={() => setCust({ ...cust, later: true })}>{tr("📅 Book for later")}</button>
                </div>
                {cust.later && <div className="row nowrap">
                  <input type="date" aria-label={tr("Date")} value={cust.date} min={todayLocal()} onChange={(e) => setCust({ ...cust, date: e.target.value })} />
                  <input type="time" aria-label={tr("Time")} value={cust.time} onChange={(e) => setCust({ ...cust, time: e.target.value })} />
                </div>}
              </div>
              {orderType === 'delivery' && <>
                <div className="field">{tr("Delivery location *")}<MapPicker value={cust.pin} onChange={(pin) => setCust((c: any) => ({ ...c, pin }))} center={branchPos} height={260} />
                </div>
                <label className="field">{tr("Address / directions *")}<textarea value={cust.address} maxLength={300} placeholder={tr("Building, street, landmark…")} onChange={(e) => setCust({ ...cust, address: e.target.value })} /></label>
              </>}
            </>}
            <label className="field">{tr("Special request")}<input value={cust.notes} maxLength={300} placeholder={tr("Allergies, extra napkins, call on arrival…")} onChange={(e) => setCust({ ...cust, notes: e.target.value })} /></label>
            <button className="primary lg" disabled={!count || (!tableToken && (!cust.name || !cust.phone || (cust.later && (!cust.date || !cust.time)) || (orderType === 'delivery' && (!cust.address || !partner || !cust.pin))))} onClick={submit}>
              {tr("Place order")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** At the restaurant but can't scan: pick the restaurant and type the table number. */
function ManualTable({ onToken }: { onToken: (token: string) => void }) {
  const tr = useTr();
  const [branches, setBranches] = useState<any[]>([]);
  const [branch, setBranch] = useState<number | null>(null);
  const [name, setName] = useState('');
  const run = useAction();
  useEffect(() => { api.get('/public/branches').then((b) => { setBranches(b); setBranch(b[0]?.id ?? null); }).catch(() => undefined); }, []);
  if (!branches.length) return null;
  return (
    <div className="card stack">
      <b>{tr("Already seated at the restaurant?")}</b>
      <p className="small muted">{tr("Scan the QR code on your table, or enter your table number.")}</p>
      <select value={branch ?? ''} onChange={(e) => setBranch(Number(e.target.value))}>
        {branches.map((b) => <option key={b.id} value={b.id}>{b.company_name} — {b.name}</option>)}
      </select>
      <div className="row nowrap">
        <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder={tr("Table number, e.g. T5")} />
        <button className="primary" disabled={!name || !branch} onClick={async () => {
          const r = await run(() => api.post('/public/table-lookup', { branch_id: branch, table_name: name }));
          if (r) onToken(r.token);
        }}>{tr("Go")}</button>
      </div>
    </div>
  );
}

export function Track() {
  const tr = useTr();
  const { token, tenant } = useParams();
  const [o, setO] = useState<any>(null);
  useEffect(() => {
    const load = () => api.get(`/public/orders/${token}`).then(setO).catch(() => undefined);
    load();
    const i = setInterval(load, 10000);
    return () => clearInterval(i);
  }, [token]);
  if (!o) return <Loading />;
  const label: Record<string, string> = { pending: 'Waiting for the restaurant to accept', open: 'Accepted — being prepared', paid: 'Completed', cancelled: 'Cancelled' };
  return (
    <div className="cust stack">
      <h1>{tr("Order ")}{o.ticket_ref}</h1>
      <div className={`card ${o.status === 'cancelled' ? 'bad' : ''}`}><b>{label[o.status] ?? o.status}</b>
        <div className="small muted">{tr(ORDER_TYPES[o.order_type])}{o.table_name ? tr(" · Table {0}", o.table_name) : ''}{o.delivery_company ? tr(" · Delivery by {0}", o.delivery_company) : ''}{o.pax > 1 ? tr(" · {0} people", o.pax) : ''}</div>
        {o.scheduled_for && <div>{tr("📅 Booked for ")}<b>{new Date(o.scheduled_for).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b></div>}</div>
      <div className="card stack">
        {o.lines.map((l: any, i: number) => (
          <div key={i} className="row between"><span>{fmtQty(l.qty)}× {l.item_name}{l.size_name ? ` (${l.size_name})` : ''}</span>
            <span className="pill">{l.kitchen_status === 'new' ? tr("received") : l.kitchen_status}</span></div>
        ))}
        <div className="row between"><b>{tr("Total")}</b><b>{fmt(o.total, o.currency)}</b></div>
        {o.paid_amount > 0 && <div className="row between ok"><span>{tr("Paid online")}</span><span>{fmt(o.paid_amount, o.currency)}</span></div>}
        {o.balance_due > 0 && o.paid_amount > 0 && <div className="row between"><b>{tr("Balance due")}</b><b>{fmt(o.balance_due, o.currency)}</b></div>}
      </div>
      {o.can_pay && <PayNow token={token!} amount={o.balance_due} currency={o.currency} />}
      {o.balance_due === 0 && o.status !== 'cancelled' && <div className="card ok">{tr("✓ Paid — thank you!")}</div>}
      <a className="btn" href={`/${tenant}/order`}>{tr("Order more")}</a>
    </div>
  );
}

function PayNow({ token, amount, currency }: { token: string; amount: number; currency: string }) {
  const tr = useTr();
  const run = useAction();
  const [busy, setBusy] = useState(false);
  return (
    <button className="primary lg" disabled={busy} onClick={async () => {
      setBusy(true);
      const r = await run(() => api.post(`/public/orders/${token}/pay`, {}));
      if (r?.redirect_url) window.location.href = r.redirect_url; else setBusy(false);
    }}>{tr("💳 Pay now · ")}{fmt(amount, currency)}</button>
  );
}

/** Test checkout (PAYMENT_PROVIDER=sandbox): stands in for the payment provider's hosted page. */
export function SandboxPay() {
  const tr = useTr();
  const { id, tenant } = useParams();
  const [sp] = useSearchParams();
  const ref = sp.get('ref') ?? '';
  const nav = useNavigate();
  const run = useAction();
  const [p, setP] = useState<any>(null);
  useEffect(() => { api.get(`/public/pay/sandbox/${id}?ref=${encodeURIComponent(ref)}`).then(setP).catch(() => setP(false)); }, [id, ref]);
  if (p === null) return <Loading />;
  if (!p) return <div className="cust"><div className="card bad">{tr("Payment not found.")}</div></div>;
  const finish = async (approve: boolean) => {
    const r = await run(() => api.post(`/public/pay/sandbox/${id}`, { ref, approve }));
    if (r) nav(`/${tenant}/track/${r.order_token}`);
  };
  return (
    <div className="login-wrap">
      <div className="card login-card stack center">
        <span className="pill warn">{tr("TEST PAYMENT — no real money")}</span>
        <h2>{tr("Pay order ")}{p.ticket_ref}</h2>
        <div style={{ fontSize: '2rem', fontWeight: 800 }}>{fmt(p.amount, p.currency)}</div>
        {p.status !== 'pending' ? <p>{tr("This payment is already ")}{p.status}.</p> : <>
          <button className="ok lg" onClick={() => finish(true)}>{tr("✓ Approve payment")}</button>
          <button className="danger lg" onClick={() => finish(false)}>{tr("✕ Decline")}</button>
        </>}
      </div>
    </div>
  );
}

/** Online table reservation: name, phone, guests, date, expected arrival time, special request. */
export function Reserve() {
  const tr = useTr();
  const { tenant } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const run = useAction();
  const [info, setInfo] = useState<any>(null);
  const [f, setF] = useState<any>({ branch_id: Number(sp.get('branch')) || null, customer_name: '', customer_phone: '', pax: '2', date: todayLocal(), time: '', special_request: '' });
  useEffect(() => {
    api.get('/public/info').then((i) => { setInfo(i); setF((x: any) => ({ ...x, branch_id: i.branches.some((b: any) => b.id === x.branch_id) ? x.branch_id : i.branches[0]?.id ?? null })); });
  }, []);
  if (!info) return <Loading />;
  if (!info.branches.length) return <div className="cust"><div className="card">{tr("Online booking is not available right now.")}</div></div>;
  const ok = f.branch_id && f.customer_name && f.customer_phone && Number(f.pax) > 0 && f.date && f.time;
  return (
    <div className="cust stack">
      <h1>{tr("📅 Reserve a table")}</h1>
      <div className="muted">{info.name}</div>
      <form className="card stack" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => api.post('/public/reservations', { ...f, pax: Number(f.pax), special_request: f.special_request || null }));
        if (r) nav(`/${tenant}/reservation/${r.token}`);
      }}>
        {info.branches.length > 1 && <label className="field">{tr("Restaurant")}<select value={f.branch_id ?? ''} onChange={(e) => setF({ ...f, branch_id: Number(e.target.value) })}>
          {info.branches.map((b: any) => <option key={b.id} value={b.id}>{b.company_name} — {b.name}</option>)}</select></label>}
        <div className="grid2">
          <label className="field">{tr("Name *")}<input value={f.customer_name} maxLength={80} autoComplete="name" onChange={(e) => setF({ ...f, customer_name: e.target.value })} /></label>
          <label className="field">{tr("Phone *")}<input type="tel" value={f.customer_phone} maxLength={20} autoComplete="tel" onChange={(e) => setF({ ...f, customer_phone: e.target.value })} /></label>
          <label className="field">{tr("Number of guests *")}<input type="number" min={1} max={100} value={f.pax} onChange={(e) => setF({ ...f, pax: e.target.value })} /></label>
          <label className="field">{tr("Date *")}<input type="date" min={todayLocal()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label className="field">{tr("Arrival time (ETA) *")}<input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></label>
        </div>
        <label className="field">{tr("Special request")}<textarea maxLength={500} value={f.special_request} placeholder={tr("Birthday, high chair, window table, allergies…")} onChange={(e) => setF({ ...f, special_request: e.target.value })} /></label>
        <button className="primary lg" disabled={!ok}>{tr("Request reservation")}</button>
      </form>
      <Link className="btn" to={`/${tenant}/order`}>{tr("🍕 Order food instead")}</Link>
    </div>
  );
}

export function ReservationStatus() {
  const tr = useTr();
  const { token, tenant } = useParams();
  const run = useAction();
  const [r, setR] = useState<any>(null);
  const load = () => api.get(`/public/reservations/${token}`).then(setR).catch(() => setR(false));
  useEffect(() => { load(); const i = setInterval(load, 20000); return () => clearInterval(i); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  if (r === null) return <Loading />;
  if (!r) return <div className="cust"><div className="card bad">{tr("Reservation not found.")}</div></div>;
  const label: Record<string, string> = { pending: '⏳ Waiting for the restaurant to confirm', confirmed: '✅ Confirmed — see you soon!', seated: '🍽 Seated', cancelled: '✕ Cancelled', no_show: 'Missed' };
  return (
    <div className="cust stack">
      <h1>{tr("Your reservation")}</h1>
      <div className={`card ${r.status === 'cancelled' ? 'bad' : r.status === 'confirmed' ? 'ok' : ''}`}><b>{label[r.status] ?? r.status}</b></div>
      <div className="card stack">
        <div><b>{r.company}</b> — {r.branch}</div>
        <div>{r.customer_name} · {r.pax} {tr(" guest(s)")}</div>
        <div>📅 {new Date(r.date + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} {tr(" at ")}<b>{r.time}</b></div>
        {r.special_request && <div className="small muted">{tr("Request: ")}{r.special_request}</div>}
      </div>
      {(r.status === 'pending' || r.status === 'confirmed') && (
        <button className="danger" onClick={async () => { if (confirm(tr("Cancel this reservation?")) && await run(() => api.post(`/public/reservations/${token}/cancel`, {}), tr("Reservation cancelled"))) load(); }}>{tr("Cancel reservation")}</button>
      )}
      <Link className="btn" to={`/${tenant}/order`}>{tr("🍕 Order food")}</Link>
    </div>
  );
}
