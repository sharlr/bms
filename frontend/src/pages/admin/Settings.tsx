import { useT as useTr } from '../../i18n';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { CrudPage } from '../../components/CrudPage';
import { Modal, useAction } from '../../components/ui';
import { LANDING_PAGES, useSession } from '../../session';
import { dt } from '../../util';

export function Companies() {
  const tr = useTr();
  const { reload } = useSession();
  return <CrudPage title={tr("Companies")} path="/companies" deleteLabel={null}
    columns={[{ key: 'name', label: tr("Name") }, { key: 'legal_name', label: tr("Legal name") }, { key: 'base_currency', label: tr("Currency") }, { key: 'tax_id', label: tr("Tax ID") }, { key: 'active', label: tr("Active") }]}
    fields={[{ key: 'name', label: tr("Name / brand"), required: true }, { key: 'legal_name', label: tr("Legal name") }, { key: 'tax_id', label: tr("Tax ID") },
      { key: 'base_currency', label: tr("Base currency"), type: 'select', required: true, optionsFrom: { path: '/currencies', label: tr("code"), value: 'code' } },
      { key: 'phone', label: tr("Phone") }, { key: 'email', label: tr("Email") }, { key: 'address', label: tr("Address"), type: 'textarea' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
    defaults={{ base_currency: 'USD', active: true }}
    toolbar={<button onClick={() => reload()}>{tr("Refresh switcher")}</button>} />;
}

export function Branches() {
  const tr = useTr();
  const { reload } = useSession();
  return <CrudPage title={tr("Branches / Restaurants")} path="/branches" deleteLabel={null}
    columns={[{ key: 'company_name', label: tr("Company") }, { key: 'name', label: tr("Branch") }, { key: 'code', label: tr("Code") }, { key: 'timezone', label: tr("Timezone") },
      { key: 'tax_rate', label: tr("Tax %"), num: true }, { key: 'online_ordering', label: tr("Online ordering") }, { key: 'active', label: tr("Active") }]}
    fields={[
      { key: 'company_id', label: tr("Company"), type: 'select', required: true, optionsFrom: { path: '/companies', label: tr("name") }, createOnly: true },
      { key: 'name', label: tr("Name"), required: true }, { key: 'code', label: tr("Code (ticket prefix, e.g. WL)"), required: true },
      { key: 'timezone', label: tr("Timezone (e.g. Africa/Nairobi)") }, { key: 'phone', label: tr("Phone") }, { key: 'address', label: tr("Address"), type: 'textarea' },
      { key: 'tax_rate', label: tr("Tax rate %"), type: 'number' }, { key: 'tax_inclusive', label: tr("Prices include tax"), type: 'bool' },
      { key: 'receipt_header', label: tr("Receipt header"), type: 'textarea' }, { key: 'receipt_footer', label: tr("Receipt footer"), type: 'textarea' },
      { key: 'lat', label: tr("Location latitude (centre of the delivery map)"), type: 'number', help: tr("e.g. 11.5886 — right-click the spot in Google Maps / OpenStreetMap to copy it") },
      { key: 'lng', label: tr("Location longitude"), type: 'number', help: tr("e.g. 43.1452") },
      { key: 'online_ordering', label: tr("Accept online orders & table reservations"), type: 'bool' }, { key: 'auto_accept_self_orders', label: tr("Auto-accept QR / online / kiosk orders"), type: 'bool' },
      { key: 'active', label: tr("Active"), type: 'bool' },
    ]}
    defaults={{ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, tax_rate: 0, tax_inclusive: true, online_ordering: false, auto_accept_self_orders: false, active: true }}
    toolbar={<button onClick={() => reload()}>{tr("Refresh switcher")}</button>} />;
}

export function Users() {
  const tr = useTr();
  const [rows, setRows] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const { me } = useSession();
  const run = useAction();
  const load = useCallback(() => api.get('/users').then(setRows), []);
  useEffect(() => { load(); api.get('/roles').then(setRoles); api.get('/branches').then(setBranches); api.get('/companies').then(setCompanies); }, [load]);

  const save = async () => {
    const body: any = { username: edit.username, full_name: edit.full_name, position: edit.position || null, landing_page: edit.landing_page ?? 'auto', role_id: edit.role_id, color: edit.color, active: edit.active, access: edit.access };
    if (me?.user?.is_tenant_admin) body.is_tenant_admin = !!edit.is_tenant_admin;
    if (edit.password) body.password = edit.password;
    if (edit.pin) body.pin = edit.pin;
    const r = await run(() => (edit.id ? api.patch(`/users/${edit.id}`, body) : api.post('/users', body)), tr("User saved"));
    if (r) { setEdit(null); load(); }
  };
  const hasAccess = (cid: number, bid: number | null) => edit.access.some((a: any) => a.company_id === cid && a.branch_id === bid);
  const toggle = (cid: number, bid: number | null) => setEdit({
    ...edit, access: hasAccess(cid, bid) ? edit.access.filter((a: any) => !(a.company_id === cid && a.branch_id === bid)) : [...edit.access, { company_id: cid, branch_id: bid }],
  });

  return (
    <div className="stack">
      <div className="row between"><h1>{tr("Users")}</h1>
        <button className="primary" onClick={() => setEdit({ username: '', full_name: '', role_id: roles.find((r) => r.name === 'Waiter')?.id ?? roles[0]?.id, color: '#2563eb', active: true, access: [], password: '', pin: '' })}>{tr("+ New user")}</button></div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>{tr("Name")}</th><th>{tr("Username")}</th><th>{tr("Role")}</th><th>{tr("Login")}</th><th>{tr("Access")}</th><th>{tr("Status")}</th><th /></tr></thead>
        <tbody>{rows.map((u) => (
          <tr key={u.id} className="click" onClick={() => setEdit({ ...u, password: '', pin: '' })}>
            <td><span className="pill" style={{ background: u.color, color: '#fff' }}>{u.full_name}</span></td><td>{u.username}</td>
            <td>{u.role_name}{u.is_tenant_admin && <span className="pill bad">{tr("tenant admin")}</span>}</td>
            <td>{u.has_password && <span className="pill">{tr("password")}</span>}{u.has_pin && <span className="pill">{tr("PIN")}</span>}</td>
            <td className="small">{u.is_tenant_admin ? tr("All companies") : u.access.map((a: any) => a.branch_id ? branches.find((b) => b.id === a.branch_id)?.name : `${companies.find((c) => c.id === a.company_id)?.name} (all)`).join(', ')}</td>
            <td>{u.active ? (u.locked_until && new Date(u.locked_until) > new Date() ? <span className="pill bad">{tr("locked")}</span> : <span className="pill ok">{tr("active")}</span>) : <span className="pill">{tr("disabled")}</span>}</td>
            <td onClick={(e) => e.stopPropagation()}>{u.locked_until && <button className="sm" onClick={() => run(() => api.post(`/users/${u.id}/unlock`, {}), tr("Unlocked")).then(load)}>{tr("Unlock")}</button>}</td>
          </tr>
        ))}</tbody></table></div>
      {edit && (
        <Modal title={edit.id ? edit.full_name : tr("New user")} onClose={() => setEdit(null)} wide>
          <div className="stack">
            <div className="grid2">
              <label className="field">{tr("Full name")}<input value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} /></label>
              <label className="field">{tr("Position")}<input value={edit.position ?? ''} maxLength={80} onChange={(e) => setEdit({ ...edit, position: e.target.value })} /></label>
              <label className="field">{tr("Landing page after sign-in")}<select value={edit.landing_page ?? 'auto'} onChange={(e) => setEdit({ ...edit, landing_page: e.target.value })}>
                {LANDING_PAGES.map((l) => <option key={l.code} value={l.code}>{tr(l.label)}</option>)}</select></label>
              <label className="field">{tr("Username")}<input value={edit.username} onChange={(e) => setEdit({ ...edit, username: e.target.value.toLowerCase() })} /></label>
              <label className="field">{tr("Role")}<select value={edit.role_id} onChange={(e) => setEdit({ ...edit, role_id: Number(e.target.value) })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
              <label className="field">{tr("Color")}<input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} /></label>
              <label className="field">{edit.id ? tr("New password (leave empty to keep)") : tr("Password (back-office login, optional)")}<input type="password" autoComplete="new-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></label>
              <label className="field">{edit.id ? tr("New 4-digit PIN (leave empty to keep)") : tr("4-digit PIN (terminal login)")}<input inputMode="numeric" maxLength={4} value={edit.pin} onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, '') })} /></label>
            </div>
            <div className="row">
              <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> {tr(" Active")}</label>
              {me?.user?.is_tenant_admin && <label className="check"><input type="checkbox" checked={!!edit.is_tenant_admin} onChange={(e) => setEdit({ ...edit, is_tenant_admin: e.target.checked })} /> {tr(" Tenant administrator (all companies)")}</label>}
            </div>
            <h3>{tr("Company & branch access")}</h3>
            {companies.map((c) => (
              <div key={c.id} className="card stack" style={{ padding: '.6rem' }}>
                <label className="check"><input type="checkbox" checked={hasAccess(c.id, null)} onChange={() => toggle(c.id, null)} /> <b>{c.name}</b> {tr(" — all branches")}</label>
                {!hasAccess(c.id, null) && <div className="row">{branches.filter((b) => b.company_id === c.id).map((b) => (
                  <label key={b.id} className="check small"><input type="checkbox" checked={hasAccess(c.id, b.id)} onChange={() => toggle(c.id, b.id)} /> {b.name}</label>
                ))}</div>}
              </div>
            ))}
            <div className="row" style={{ justifyContent: 'flex-end' }}><button onClick={() => setEdit(null)}>{tr("Cancel")}</button><button className="primary" onClick={save}>{tr("Save")}</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const MODES: Record<string, string> = {
  pos: 'POS counter (full)', waiter: 'Waiter tablet / handheld', takeaway: 'Takeaway / delivery counter', kiosk: 'Self-service kiosk', kds: 'Kitchen display', print_agent: 'In-store print agent',
};

export function Devices() {
  const tr = useTr();
  const { me, branchId, reload } = useSession();
  const { tenant } = useParams();
  const nav = useNavigate();
  const [rows, setRows] = useState<any[]>([]);
  const [registers, setRegisters] = useState<any[]>([]);
  const [f, setF] = useState<any>(null);
  const [token, setToken] = useState<string | null>(null);
  const run = useAction();
  const load = useCallback(() => api.get('/devices').then(setRows), []);
  useEffect(() => { load(); api.get('/registers').then(setRegisters); }, [load]);
  const branch = me?.context?.branches.find((b) => b.id === branchId);
  return (
    <div className="stack">
      <div className="row between"><h1>{tr("Devices / Terminals")}</h1>
        <button className="primary" onClick={() => setF({ name: '', mode: 'pos', register_id: registers[0]?.id ?? null })}>{tr("Register a device")}</button></div>
      <p className="muted">{tr("Register ")}<b>{tr("this browser")}</b> {tr(" as a terminal for ")}<b>{branch?.name}</b>{tr(". Staff then sign in on it with their name + 4-digit PIN. Print agents get a token to paste into the in-store print agent.")}</p>
      {me?.device && <div className="card">{tr("This browser is registered as ")}<b>{me.device.name}</b> ({tr(MODES[me.device.mode])}).
        <button className="sm" style={{ marginLeft: 8 }} onClick={async () => { await run(() => api.post('/auth/forget-device', {})); reload(); }}>{tr("Forget on this browser")}</button></div>}
      <div className="table-wrap"><table className="data">
        <thead><tr><th>{tr("Name")}</th><th>{tr("Mode")}</th><th>{tr("Register")}</th><th>{tr("Registered")}</th><th>{tr("Last seen")}</th><th>{tr("Status")}</th><th /></tr></thead>
        <tbody>{rows.map((d) => (
          <tr key={d.id}><td>{d.name}</td><td>{tr(MODES[d.mode])}</td><td>{registers.find((r) => r.id === d.register_id)?.name}</td>
            <td>{dt(d.created_at)} · {d.created_by_name}</td><td>{dt(d.last_seen_at)}</td>
            <td>{d.revoked_at ? <span className="pill">{tr("revoked")}</span> : <span className="pill ok">{tr("active")}</span>}</td>
            <td>{!d.revoked_at && <button className="sm" onClick={async () => { if (confirm(tr("Revoke this device? Its sessions end immediately.")) && await run(() => api.del(`/devices/${d.id}`))) load(); }}>{tr("Revoke")}</button>}</td></tr>
        ))}</tbody></table></div>
      {f && (
        <Modal title={tr("Register device")} onClose={() => setF(null)}>
          <div className="stack">
            <label className="field">{tr("Device name")}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={tr("e.g. Counter 1, Bar tablet")} /></label>
            <label className="field">{tr("Mode")}<select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            {['pos', 'takeaway', 'waiter'].includes(f.mode) && <label className="field">{tr("Register (cash drawer)")}<select value={f.register_id ?? ''} onChange={(e) => setF({ ...f, register_id: Number(e.target.value) || null })}>
              {registers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
            <button className="primary lg" disabled={!f.name} onClick={async () => {
              const r = await run(() => api.post('/auth/devices', { name: f.name, mode: f.mode, register_id: ['pos', 'takeaway', 'waiter'].includes(f.mode) ? f.register_id : null }), tr("Device registered"));
              if (!r) return;
              setF(null); load();
              if (f.mode === 'print_agent') setToken(r.token);
              else if (confirm(tr("This browser is now a terminal. Sign out and go to the staff PIN screen?"))) {
                await api.post('/auth/logout', {}); await reload();
                nav(`/${tenant}/${f.mode === 'kiosk' ? 'kiosk' : 'terminal'}`);
              }
            }}>{tr("Register ")}{f.mode === 'print_agent' ? tr("print agent") : tr("this browser")}</button>
          </div>
        </Modal>
      )}
      {token && (
        <Modal title={tr("Print agent token")} onClose={() => setToken(null)}>
          <p>{tr("Copy this token into the print agent's ")}<code>{tr(".env")}</code> {tr(" as ")}<code>{tr("BMS_DEVICE_TOKEN")}</code>{tr(". It is shown only once.")}</p>
          <textarea readOnly value={token} onFocus={(e) => e.target.select()} />
        </Modal>
      )}
    </div>
  );
}

export function PrintJobs() {
  const tr = useTr();
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api.get('/print/jobs').then(setRows); }, []);
  return (
    <div className="stack">
      <h1>{tr("Print Queue")}</h1>
      <p className="muted">{tr("KOT and receipt jobs for this branch. Jobs are delivered to the in-store print agent; pending jobs are replayed when it reconnects.")}</p>
      <div className="table-wrap"><table className="data"><thead><tr><th>#</th><th>{tr("Kind")}</th><th>{tr("Printer")}</th><th>{tr("Status")}</th><th>{tr("Attempts")}</th><th>{tr("Created")}</th><th>{tr("Printed")}</th><th>{tr("Error")}</th></tr></thead>
        <tbody>{rows.map((j) => <tr key={j.id}><td>{j.id}</td><td>{j.kind}</td><td>{j.printer ?? '—'}</td>
          <td><span className={`pill ${j.status === 'printed' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'no_printer' ? '' : 'warn'}`}>{j.status}</span></td>
          <td>{j.attempts}</td><td>{dt(j.created_at)}</td><td>{dt(j.printed_at)}</td><td className="small bad">{j.error}</td></tr>)}</tbody></table></div>
    </div>
  );
}
