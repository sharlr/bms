import { useT as useTr } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { platformApi } from '../api';
import { Modal, useAction } from '../components/ui';
import { dt } from '../util';

/** Super-admin console: provision tenants (one dedicated database each), suspend / reactivate. */
export function Platform() {
  const tr = useTr();
  const [me, setMe] = useState<any>(undefined);
  const [tenants, setTenants] = useState<any[]>([]);
  const [login, setLogin] = useState({ email: '', password: '' });
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<any>(null);
  const [confirmText, setConfirmText] = useState('');
  const run = useAction();
  const load = useCallback(async () => {
    try { setMe(await platformApi.get('/me')); setTenants(await platformApi.get('/tenants')); } catch { setMe(null); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (me === undefined) return null;
  if (!me) return (
    <div className="login-wrap">
      <form className="card login-card stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => platformApi.post('/login', login))) load(); }}>
        <h1>{tr("Platform administration")}</h1>
        <label className="field">{tr("Email")}<input type="email" autoComplete="username" value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} /></label>
        <label className="field">{tr("Password")}<input type="password" autoComplete="current-password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} /></label>
        <button className="primary lg">{tr("Sign in")}</button>
      </form>
    </div>
  );

  return (
    <div className="content stack" style={{ maxWidth: 1100, margin: 'auto' }}>
      <div className="row between"><h1>{tr("Tenants")}</h1>
        <div className="row"><span className="muted">{me.email}</span>
          <button onClick={() => setForm({ slug: '', name: '', company_name: '', currency: 'USD', branch_name: 'Main', branch_code: 'MAIN', admin_username: 'admin', admin_full_name: '', admin_password: '', admin_pin: '' })} className="primary">{tr("+ New tenant")}</button>
          <button onClick={async () => { await platformApi.post('/logout', {}); setMe(null); }}>{tr("Sign out")}</button></div></div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>{tr("Slug / URL")}</th><th>{tr("Name")}</th><th>{tr("Database")}</th><th>{tr("Status")}</th><th>{tr("Created")}</th><th /></tr></thead>
        <tbody>{tenants.map((t) => (
          <tr key={t.id}><td><a href={`/${t.slug}`}>/{t.slug}</a></td><td>{t.name} <button className="sm ghost" title={tr("Rename")} aria-label={tr("Rename {0}", t.name)} onClick={async () => {
              const name = prompt(tr("Display name for /{0}", t.slug), t.name)?.trim();
              if (name && name !== t.name && await run(() => platformApi.patch(`/tenants/${t.id}`, { name }), tr("Tenant renamed"))) load();
            }}>✏️</button></td><td><code>{t.db_name}</code></td>
            <td><span className={`pill ${t.status === 'active' ? 'ok' : 'bad'}`}>{t.status}</span></td><td>{dt(t.created_at)}</td>
            <td>{t.status === 'active'
              ? <button className="sm" onClick={async () => { if (confirm(tr("Suspend {0}?", t.slug)) && await run(() => platformApi.post(`/tenants/${t.id}/status`, { status: 'suspended' }))) load(); }}>{tr("Suspend")}</button>
              : <div className="row nowrap">
                {t.status === 'suspended' && <button className="sm" onClick={async () => { if (await run(() => platformApi.post(`/tenants/${t.id}/status`, { status: 'active' }))) load(); }}>{tr("Activate")}</button>}
                <button className="sm danger" onClick={() => { setConfirmText(''); setDel(t); }}>{tr("Delete")}</button>
              </div>}</td></tr>
        ))}</tbody></table></div>
      {del && (
        <Modal title={tr("Delete tenant {0}?", del.slug)} onClose={() => !busy && setDel(null)}>
          <div className="stack">
            <div className="card bad">{tr("⚠ This permanently deletes ")}<b>{del.name}</b>{tr(": its database ")}<code>{del.db_name}</code>{tr(", all its companies, branches, sales, users and in-app backups. Its URL ")}<code>/{del.slug}</code> {tr(" stops working immediately.")}</div>
            <p className="small muted">{tr("A final archive of the database is kept on the server in the backups volume under ")}<code>{tr("_deleted/")}</code>.</p>
            <label className="field">{tr("Type ")}<b>{del.slug}</b> {tr(" to confirm")}<input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus /></label>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button disabled={busy} onClick={() => setDel(null)}>{tr("Cancel")}</button>
              <button className="danger" disabled={busy || confirmText !== del.slug} onClick={async () => {
                setBusy(true);
                const r = await run(() => platformApi.del(`/tenants/${del.id}`, { confirm: confirmText }), tr("Tenant deleted"));
                setBusy(false);
                if (r) { setDel(null); load(); }
              }}>{busy ? tr("Deleting…") : tr("Delete permanently")}</button>
            </div>
          </div>
        </Modal>
      )}
      {form && (
        <Modal title={tr("Provision tenant (dedicated database)")} onClose={() => !busy && setForm(null)} wide>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault(); setBusy(true);
            const r = await run(() => platformApi.post('/tenants', { ...form, admin_pin: form.admin_pin || undefined }), tr("Tenant provisioned"));
            setBusy(false);
            if (r) { setForm(null); load(); }
          }}>
            <div className="grid2">
              <label className="field">{tr("URL slug (bms.nexusrajan.com/")}<b>{form.slug || tr("slug")}</b>)<input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} /></label>
              <label className="field">{tr("Tenant name")}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label className="field">{tr("First company")}<input value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} /></label>
              <label className="field">{tr("Base currency")}<input maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></label>
              <label className="field">{tr("First branch")}<input value={form.branch_name} onChange={(e) => setForm({ ...form, branch_name: e.target.value })} /></label>
              <label className="field">{tr("Branch code")}<input value={form.branch_code} onChange={(e) => setForm({ ...form, branch_code: e.target.value.toUpperCase() })} /></label>
              <label className="field">{tr("Admin username")}<input value={form.admin_username} onChange={(e) => setForm({ ...form, admin_username: e.target.value.toLowerCase() })} /></label>
              <label className="field">{tr("Admin full name")}<input value={form.admin_full_name} onChange={(e) => setForm({ ...form, admin_full_name: e.target.value })} /></label>
              <label className="field">{tr("Admin password (10+, upper, lower, digit)")}<input type="password" autoComplete="new-password" value={form.admin_password} onChange={(e) => setForm({ ...form, admin_password: e.target.value })} /></label>
              <label className="field">{tr("Admin PIN (optional)")}<input inputMode="numeric" maxLength={4} value={form.admin_pin} onChange={(e) => setForm({ ...form, admin_pin: e.target.value.replace(/\D/g, '') })} /></label>
            </div>
            <button className="primary lg" disabled={busy}>{busy ? tr("Provisioning…") : tr("Create tenant")}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
