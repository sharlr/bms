import { useT as useTr } from '../i18n';
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api, setContext } from '../api';
import { Loading, Numpad, PinDots, useAction } from '../components/ui';
import { landingRoute, useSession } from '../session';

export function Landing() {
  const tr = useTr();
  return (
    <div className="login-wrap">
      <div className="card login-card center">
        <h1>{tr("BMS Restaurant Cloud")}</h1>
        <p className="muted">{tr("Open your restaurant at ")}<code>/{tr("{restaurant}")}</code>{tr(", e.g. ")}<code>{tr("/pizzahut")}</code>.</p>
      </div>
    </div>
  );
}

const modeRoute: Record<string, string> = { pos: 'pos', waiter: 'pos', takeaway: 'pos', kds: 'kds', kiosk: 'kiosk' };

export function TenantHome() {
  const tr = useTr();
  const { me, loading, error } = useSession();
  const { tenant } = useParams();
  if (loading) return <Loading />;
  if (error || !me) return <div className="login-wrap"><div className="card login-card center"><h2>{tr("Restaurant not found")}</h2></div></div>;
  if (me.user) {
    const r = me.user.device_bound && me.device ? modeRoute[me.device.mode] : landingRoute(me.user);
    return <Navigate to={`/${tenant}/${r ?? 'app'}`} replace />;
  }
  if (me.device?.mode === 'kiosk') return <Navigate to={`/${tenant}/kiosk`} replace />;
  if (me.device && me.device.mode !== 'print_agent') return <Navigate to={`/${tenant}/terminal`} replace />;
  return (
    <div className="login-wrap">
      <div className="card login-card stack center">
        <h1>{me.tenant.name}</h1>
        <Link className="btn primary lg" to={`/${tenant}/order`}>{tr("🍕 Order online")}</Link>
        <Link className="btn lg" to={`/${tenant}/reserve`}>{tr("📅 Reserve a table")}</Link>
        <Link className="btn lg" to={`/${tenant}/login`}>{tr("Staff login")}</Link>
      </div>
    </div>
  );
}

export function Login() {
  const tr = useTr();
  const { me, reload } = useSession();
  const nav = useNavigate();
  const { tenant } = useParams();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const lastKey = `bms:${tenant}:login-branch`;
  const [branches, setBranches] = useState<any[]>([]);
  const [branch, setBranch] = useState<number | null>(Number(localStorage.getItem(lastKey)) || null);
  useEffect(() => {
    api.get('/public/branches').then((b: any[]) => {
      setBranches(b);
      setBranch((cur) => (b.some((x) => x.id === cur) ? cur : b[0]?.id ?? null));
    }).catch(() => undefined);
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const r = await api.post('/auth/login', { username: u, password: p, branch_id: branch ?? undefined });
      if (r.branch_id) { setContext(r.company_id, r.branch_id); localStorage.setItem(lastKey, String(r.branch_id)); }
      const m = await reload();
      nav(`/${tenant}/${m?.user ? landingRoute(m.user) : 'app'}`);
    } catch (x) { setErr((x as Error).message); }
  };
  return (
    <div className="login-wrap">
      <form className="card login-card stack" onSubmit={submit}>
        <h1>{me?.tenant.name ?? tr("Sign in")}</h1>
        <p className="muted small">{tr("Sign in with your username, password and branch. Staff on a registered terminal can use their PIN instead.")}</p>
        <label className="field">{tr("Username")}<input autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} autoFocus /></label>
        <label className="field">{tr("Password")}<input type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} /></label>
        {branches.length > 0 && (
          <label className="field">{tr("Branch")}<select value={branch ?? ''} onChange={(e) => setBranch(Number(e.target.value))} required>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.company_name} — {b.name}</option>)}
          </select></label>
        )}
        {err && <div className="bad small">{tr(err)}</div>}
        <button className="primary lg" type="submit">{tr("Sign in")}</button>
        {me?.device && <Link to={`/${tenant}/terminal`} className="small center">{tr("Back to terminal login")}</Link>}
      </form>
    </div>
  );
}

/** Touch login: tap your name, enter your 4-digit PIN. Only on registered devices. */
export function Terminal() {
  const tr = useTr();
  const { me, reload, loading } = useSession();
  const nav = useNavigate();
  const { tenant } = useParams();
  const [staff, setStaff] = useState<any[] | null>(null);
  const [sel, setSel] = useState<any | null>(null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const run = useAction();

  useEffect(() => { api.get('/auth/staff').then(setStaff).catch((e) => setErr(e.message)); }, []);

  const tryPin = async (v: string) => {
    setPin(v);
    if (v.length < 4) return;
    try {
      await api.post('/auth/pin', { user_id: sel.id, pin: v });
      const m = await reload();
      nav(`/${tenant}/${(m?.device && modeRoute[m.device.mode]) || 'pos'}`);
    } catch (e) {
      setErr((e as Error).message);
      setPin('');
    }
  };

  if (loading) return <Loading />;
  if (!me?.device) return (
    <div className="login-wrap"><div className="card login-card stack center">
      <h2>{tr("Terminal not registered")}</h2>
      <p className="muted">{tr("A manager must sign in and register this screen under Settings → Devices.")}</p>
      <Link className="btn primary" to={`/${tenant}/login`}>{tr("Manager sign in")}</Link>
    </div></div>
  );
  return (
    <div className="login-wrap" style={{ alignItems: 'stretch' }}>
      <div style={{ width: '100%', maxWidth: 960 }} className="stack">
        <div className="row between" style={{ color: '#fff' }}>
          <h1 style={{ color: '#fff' }}>{me.tenant.name} · {me.device.name}</h1>
          <span className="pill info">{me.device.mode.toUpperCase()} {tr(" MODE")}</span>
        </div>
        {!sel ? (
          <div className="staff-grid">
            {staff?.map((s) => (
              <button key={s.id} style={{ background: s.color }} onClick={() => { setSel(s); setErr(''); setPin(''); }}>
                <span className="avatar">{s.full_name.split(' ').map((x: string) => x[0]).join('').slice(0, 2)}</span>
                {s.full_name}
                <span className="small" style={{ opacity: .8 }}>{s.role_name}</span>
              </button>
            ))}
            {staff?.length === 0 && <div className="card">{tr("No staff with a PIN are assigned to this branch.")}</div>}
          </div>
        ) : (
          <div className="card" style={{ maxWidth: 360, margin: '0 auto', width: '100%' }}>
            <div className="row between"><h2>{sel.full_name}</h2><button className="ghost" onClick={() => setSel(null)}>{tr("← Back")}</button></div>
            <PinDots n={pin.length} />
            {err && <div className="bad center small">{tr(err)}</div>}
            <Numpad value={pin} onChange={tryPin} decimals={false} max={4} />
          </div>
        )}
        <div className="row" style={{ justifyContent: 'center' }}>
          <Link className="btn ghost" style={{ color: '#94a3b8' }} to={`/${tenant}/login`}>{tr("Back-office login")}</Link>
          {err && !sel && <span className="bad">{tr(err)}</span>}
          <button className="ghost" style={{ color: '#94a3b8' }} onClick={() => run(async () => { await reload(); })}>↻</button>
        </div>
      </div>
    </div>
  );
}
