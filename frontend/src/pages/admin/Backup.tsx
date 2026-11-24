import { useCallback, useEffect, useRef, useState } from 'react';
import { api, tenantSlug } from '../../api';
import { Modal, useAction, useToast } from '../../components/ui';
import { useSession } from '../../session';

const KIND: Record<string, { label: string; cls: string }> = {
  auto: { label: 'Auto', cls: 'ok' }, manual: { label: 'Manual', cls: 'info' },
  uploaded: { label: 'Uploaded', cls: 'warn' }, pre_restore: { label: 'Before restore', cls: '' },
};
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;
const when = (s: string) => new Date(s).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const gmt = (tz: string) => {
  try { return new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? tz; } catch { return tz; }
};
const daysLeft = (s: string | null) => (s ? Math.max(0, Math.ceil((new Date(s).getTime() - Date.now()) / 86400000)) : null);
const ZONES: string[] = (Intl as any).supportedValuesOf?.('timeZone') ?? [Intl.DateTimeFormat().resolvedOptions().timeZone];

export function BackupPage() {
  const { me } = useSession();
  const run = useAction();
  const toast = useToast();
  const [data, setData] = useState<{ versions: any[]; schedules: any[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [sched, setSched] = useState<any>(null);
  const [restore, setRestore] = useState<any>(null);
  const [confirmText, setConfirmText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const isAdmin = !!me?.user?.is_tenant_admin;
  const slug = tenantSlug();

  const load = useCallback(() => api.get('/backups').then(setData), []);
  useEffect(() => { load(); }, [load]);

  const newBackup = async () => {
    setBusy('Creating backup…');
    const v = await run(() => api.post('/backups', {}));
    setBusy('');
    if (v) { toast(`Version ${v.version_no} created`); load(); }
  };

  // Restore from a file: upload it as a new version, then confirm the restore of that version.
  const upload = async (f: File) => {
    setBusy(`Uploading ${f.name}…`);
    const v = await run(async () => {
      const r = await fetch(`/api/t/${slug}/backups/upload`, {
        method: 'POST', credentials: 'same-origin', body: f,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'bms' },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? 'Upload failed');
      return d;
    });
    setBusy('');
    if (fileRef.current) fileRef.current.value = '';
    if (v) { await load(); setConfirmText(''); setRestore(v); }
  };

  const doRestore = async () => {
    const v = restore;
    setRestore(null);
    setBusy(`Restoring version ${v.version_no}… do not close this page.`);
    const r = await run(() => api.post(`/backups/${v.id}/restore`, { confirm: confirmText }));
    setBusy('');
    if (r) {
      alert(`Version ${r.restored} restored. A safety backup of the previous data was saved as version ${r.safety_version}.\nThe page will reload.`);
      location.reload();
    }
  };

  const saveSchedule = async () => {
    const body = { time: sched.time, timezone: sched.timezone, retention_days: Number(sched.retention_days), enabled: sched.enabled };
    if (await run(() => (sched.id ? api.patch(`/backups/schedules/${sched.id}`, body) : api.post('/backups/schedules', body)), 'Schedule saved')) { setSched(null); load(); }
  };

  if (!data) return null;
  return (
    <div className="stack" style={{ gap: '1rem' }}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ marginBottom: '.2rem' }}>Backup</h1>
          <div className="muted">Backing up your restaurant data keeps it safe from data loss or mistakes. Backups cover every company and branch of {me?.tenant.name}.</div>
        </div>
        <div className="row">
          {isAdmin && <>
            <input ref={fileRef} type="file" accept=".dump" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <button disabled={!!busy} onClick={() => fileRef.current?.click()}>⤒ Restore from file</button>
          </>}
          <button className="primary" disabled={!!busy} onClick={newBackup}>+ New Backup</button>
        </div>
      </div>
      {busy && <div className="card warn" role="status">⏳ {busy}</div>}

      <div className="card stack">
        <div className="row between"><h2 style={{ margin: 0 }}>Scheduled Backups</h2>
          <button onClick={() => setSched({ time: '00:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, retention_days: 30, enabled: true })}>+ Add Schedule</button></div>
        <div className="table-wrap" style={{ boxShadow: 'none' }}>
          <table className="data">
            <thead><tr><th>Schedule</th><th>Next Backup</th><th>Retention</th><th>Status</th><th className="right">Actions</th></tr></thead>
            <tbody>
              {data.schedules.map((s) => (
                <tr key={s.id}>
                  <td>Daily at {s.time} ({gmt(s.timezone)})
                    {s.last_error && <div className="small bad">Last run failed: {s.last_error}</div>}</td>
                  <td>{s.enabled ? when(s.next_run_at) : <span className="muted">—</span>}</td>
                  <td>{s.retention_days} days</td>
                  <td>
                    <label className="switch" title={s.enabled ? 'Enabled' : 'Disabled'}>
                      <input type="checkbox" checked={s.enabled} aria-label="Schedule enabled"
                        onChange={async (e) => { if (await run(() => api.patch(`/backups/schedules/${s.id}`, { enabled: e.target.checked }))) load(); }} />
                      <span />
                    </label>
                  </td>
                  <td className="right">
                    <button className="sm ghost" title="Edit" aria-label="Edit schedule" onClick={() => setSched({ ...s })}>✏️</button>
                    <button className="sm ghost" title="Delete" aria-label="Delete schedule" onClick={async () => { if (confirm('Delete this schedule?') && await run(() => api.del(`/backups/schedules/${s.id}`))) load(); }}>🗑</button>
                  </td>
                </tr>
              ))}
              {data.schedules.length === 0 && <tr><td colSpan={5} className="muted">No schedule yet — add one so backups run automatically.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Backup Versions</h2>
        <div className="table-wrap" style={{ boxShadow: 'none' }}>
          <table className="data">
            <thead><tr><th>Version</th><th>Date of Backup</th><th>Expires In</th><th className="right">Actions</th></tr></thead>
            <tbody>
              {data.versions.map((v) => {
                const d = daysLeft(v.expires_at);
                return (
                  <tr key={v.id}>
                    <td><b>Version {v.version_no}</b> <span className={`pill ${KIND[v.kind]?.cls}`}>{KIND[v.kind]?.label ?? v.kind}</span>
                      <div className="small muted">{v.filename} · {mb(v.size_bytes)}{v.created_by ? ` · ${v.created_by}` : ''}</div></td>
                    <td>{when(v.created_at)}</td>
                    <td>{d === null ? <span className="muted">Never</span> : <span className={d <= 3 ? 'warn' : ''}>{d} {d === 1 ? 'Day' : 'Days'}</span>}</td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      {isAdmin && <button className="sm ghost" title="Restore this version" aria-label={`Restore version ${v.version_no}`} disabled={!!busy} onClick={() => { setConfirmText(''); setRestore(v); }}>↺</button>}
                      <a className="btn sm ghost" title="Download" aria-label={`Download version ${v.version_no}`} href={`/api/t/${slug}/backups/${v.id}/download`}>⬇</a>
                      {isAdmin && <button className="sm ghost" title="Delete" aria-label={`Delete version ${v.version_no}`} onClick={async () => {
                        if (confirm(`Delete backup version ${v.version_no}? This cannot be undone.`) && await run(() => api.del(`/backups/${v.id}`), 'Backup deleted')) load();
                      }}>🗑</button>}
                    </td>
                  </tr>
                );
              })}
              {data.versions.length === 0 && <tr><td colSpan={4} className="muted">No backups yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {sched && (
        <Modal title={sched.id ? 'Edit schedule' : 'Add schedule'} onClose={() => setSched(null)}>
          <div className="stack">
            <div className="grid2">
              <label className="field">Every day at<input type="time" value={sched.time} onChange={(e) => setSched({ ...sched, time: e.target.value })} /></label>
              <label className="field">Timezone<select value={sched.timezone} onChange={(e) => setSched({ ...sched, timezone: e.target.value })}>
                {ZONES.map((z) => <option key={z} value={z}>{z} ({gmt(z)})</option>)}</select></label>
              <label className="field">Keep each backup for (days)<input type="number" min={1} max={3650} value={sched.retention_days} onChange={(e) => setSched({ ...sched, retention_days: e.target.value })} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={sched.enabled} onChange={(e) => setSched({ ...sched, enabled: e.target.checked })} /> Enabled</label>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button onClick={() => setSched(null)}>Cancel</button><button className="primary" onClick={saveSchedule}>Save</button></div>
          </div>
        </Modal>
      )}

      {restore && (
        <Modal title={`Restore version ${restore.version_no}?`} onClose={() => setRestore(null)}>
          <div className="stack">
            <div className="card bad">⚠ All current data of <b>{me?.tenant.name}</b> (every company and branch: sales, menu, stock, users…) will be replaced by
              this backup from <b>{when(restore.created_at)}</b>. Anything recorded after that time is lost.</div>
            <p className="small muted">A safety backup of the current data is taken automatically first, so you can undo this.</p>
            <label className="field">Type <b>{slug}</b> to confirm<input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus /></label>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setRestore(null)}>Cancel</button>
              <button className="danger" disabled={confirmText !== slug} onClick={doRestore}>Restore</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
