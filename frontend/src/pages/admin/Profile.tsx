import { useT as useTr } from '../../i18n';
import { useState } from 'react';
import { api } from '../../api';
import { useAction } from '../../components/ui';
import { LANGUAGES, THEMES, useT } from '../../i18n';
import { LANDING_PAGES, useSession } from '../../session';

export function Profile() {
  const tr = useTr();
  const { me, reload } = useSession();
  const t = useT();
  const run = useAction();
  const u = me!.user!;
  const [position, setPosition] = useState(u.position ?? '');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pin, setPin] = useState('');
  const save = async (body: object) => { if (await run(() => api.patch('/auth/profile', body), t('Saved'))) await reload(); };

  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h1>{t('My profile')}</h1>
      <div className="card row" style={{ gap: '1rem' }}>
        <div className="avatar-sm" style={{ background: u.color, width: 64, height: 64, fontSize: '1.4rem' }}>
          {u.full_name.split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase()}
        </div>
        <div className="grow">
          <h2 style={{ margin: 0 }}>{u.full_name}</h2>
          <div className="muted small">{t('Username')}: {u.username} · {t('Role')}: {u.role_name}{u.is_tenant_admin ? tr(" · Tenant admin") : ''}</div>
        </div>
      </div>

      <div className="card stack">
        <h2>{t('Preferences')}</h2>
        <form className="row" onSubmit={(e) => { e.preventDefault(); save({ position }); }}>
          <label className="field grow">{t('Position')}<input value={position} maxLength={80} onChange={(e) => setPosition(e.target.value)} placeholder={tr("e.g. Restaurant Manager")} /></label>
          <button className="primary" style={{ alignSelf: 'flex-end' }}>{t('Save')}</button>
        </form>
        <label className="field">{t('Landing page after sign-in')}
          <select style={{ maxWidth: 320 }} value={u.landing_page} onChange={(e) => save({ landing_page: e.target.value })}>
            {LANDING_PAGES.map((l) => <option key={l.code} value={l.code}>{t(l.label)}</option>)}
          </select>
        </label>
        <div className="field">{t('Theme')}
          <div className="row">
            {THEMES.map((th) => (
              <button key={th.code} className={u.theme === th.code ? 'dark' : ''} aria-pressed={u.theme === th.code} onClick={() => save({ theme: th.code })}>
                <span className="swatch" style={{ background: th.swatch }} /> {tr(th.label)}
              </button>
            ))}
          </div>
        </div>
        <div className="field">{t('Language')}
          <div className="row">
            {LANGUAGES.map((l) => (
              <button key={l.code} className={u.language === l.code ? 'dark' : ''} aria-pressed={u.language === l.code} onClick={() => save({ language: l.code })}>
                {l.code.toUpperCase()} · {l.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <form className="card stack" onSubmit={async (e) => {
        e.preventDefault();
        if (pw.next !== pw.confirm) return run(async () => { throw new Error(t('Passwords do not match')); });
        if (await run(() => api.post('/auth/change-password', { current: pw.current, next: pw.next }), t('Saved'))) setPw({ current: '', next: '', confirm: '' });
      }}>
        <h2>{t('Change password')}</h2>
        <div className="grid2">
          <label className="field">{t('Current password')}<input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
          <label className="field">{t('New password')}<input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
          <label className="field">{t('Confirm new password')}<input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></label>
        </div>
        <span className="small muted">{tr("10+ characters with upper case, lower case and a digit. Other sessions are signed out.")}</span>
        <div><button className="primary" disabled={!pw.next}>{t('Change password')}</button></div>
      </form>

      <form className="card row" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api.post('/auth/change-pin', { pin }), t('Saved'))) setPin('');
      }}>
        <label className="field grow">{t('New 4-digit PIN')}<input inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
        <button className="primary" style={{ alignSelf: 'flex-end' }} disabled={pin.length !== 4}>{t('Change PIN')}</button>
      </form>
    </div>
  );
}
