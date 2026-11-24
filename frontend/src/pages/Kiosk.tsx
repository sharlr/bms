import { useEffect, useState } from 'react';
import { api } from '../api';
import { CartList, MenuBrowser, toOrderLines, useCart } from '../components/MenuOrdering';
import { Loading, useAction } from '../components/ui';
import { useSession } from '../session';
import { fmt } from '../util';

/** Self-service kiosk: registered device, no staff login. Orders go to the POS for acceptance/payment. */
export function Kiosk() {
  const { me, loading } = useSession();
  const [menu, setMenu] = useState<any>(null);
  const [step, setStep] = useState<'start' | 'menu' | 'done'>('start');
  const [type, setType] = useState<'dine_in' | 'takeaway'>('dine_in');
  const [name, setName] = useState('');
  const [done, setDone] = useState<any>(null);
  const { cart, total, count, add, setQty, clear } = useCart();
  const run = useAction();
  useEffect(() => { if (me?.device?.mode === 'kiosk') api.get(`/kiosk/menu?order_type=${type}`).then(setMenu); }, [me, type]);
  useEffect(() => {
    if (step !== 'done') return;
    const t = setTimeout(() => { setStep('start'); setDone(null); }, 20000);
    return () => clearTimeout(t);
  }, [step]);

  if (loading) return <Loading />;
  if (me?.device?.mode !== 'kiosk') return <div className="login-wrap"><div className="card">This screen is not registered as a kiosk.</div></div>;
  if (!menu) return <Loading />;

  if (step === 'start') return (
    <div className="login-wrap">
      <div className="card stack center" style={{ maxWidth: 560, width: '100%' }}>
        <h1 style={{ fontSize: '2rem' }}>Welcome to {menu.branch}</h1>
        <p className="muted">Touch to start your order</p>
        <div className="row">
          <button className="primary lg grow" style={{ minHeight: 140, fontSize: '1.4rem' }} onClick={() => { setType('dine_in'); setStep('menu'); }}>🍽️ Eat in</button>
          <button className="dark lg grow" style={{ minHeight: 140, fontSize: '1.4rem' }} onClick={() => { setType('takeaway'); setStep('menu'); }}>🛍️ Take away</button>
        </div>
      </div>
    </div>
  );

  if (step === 'done') return (
    <div className="login-wrap">
      <div className="card stack center" style={{ maxWidth: 520 }}>
        <h1>Thank you!</h1>
        <p>Your order number</p>
        <div style={{ fontSize: '4rem', fontWeight: 900 }}>{done?.ticket_no}</div>
        <p className="muted">Please pay at the counter · {fmt(done?.total, done?.currency)}</p>
        <button className="primary lg" onClick={() => { setStep('start'); setDone(null); }}>New order</button>
      </div>
    </div>
  );

  return (
    <div className="app">
      <div className="appbar"><b style={{ fontSize: '1.2rem' }}>{menu.branch} · {type === 'dine_in' ? 'Eat in' : 'Take away'}</b><div className="grow" />
        <button onClick={() => { clear(); setStep('start'); }}>Start over</button></div>
      <div className="app-body">
        <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}><MenuBrowser menu={menu} currency={menu.currency} onAdd={add} big /></div>
        <div style={{ width: 360, background: '#fff', padding: '1rem', overflow: 'auto' }} className="stack">
          <h2>Your order</h2>
          <CartList cart={cart} setQty={setQty} currency={menu.currency} />
          {count === 0 && <p className="muted">Tap items to add them.</p>}
          <input placeholder="Your name (optional)" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <div className="row between"><b>Total</b><b style={{ fontSize: '1.4rem' }}>{fmt(total, menu.currency)}</b></div>
          <button className="primary lg" disabled={!count} onClick={async () => {
            const r = await run(() => api.post('/kiosk/orders', { order_type: type, customer_name: name || undefined, lines: toOrderLines(cart) }));
            if (r) { setDone(r); clear(); setName(''); setStep('done'); }
          }}>Place order</button>
        </div>
      </div>
    </div>
  );
}
