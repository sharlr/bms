import { useT as useTr } from '../i18n';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { LangSwitch, SOFTWARE, useT } from '../i18n';
import { useSession } from '../session';

/**
 * Top bar for the full-screen apps (POS, KDS), styled like the back office: themed brand block on the left
 * (same as the sidebar header), breadcrumb, then every button right-aligned and the same size.
 */
export function AppBar({ children, right, onLock }: { children?: ReactNode; right?: ReactNode; onLock: () => void }) {
  const tr = useTr();
  const { me, branchId } = useSession();
  const { tenant } = useParams();
  const t = useT();
  const u = me?.user;
  const branch = me?.context?.branches.find((b) => b.id === branchId);
  return (
    <div className="appbar no-print">
      <div className="side-brand">
        <div className="logo">{SOFTWARE.initials}</div>
        <div><b>{SOFTWARE.name}</b><span>{SOFTWARE.company}</span></div>
      </div>
      <div className="crumb">
        <span className="dim">{me?.tenant.name}</span><span className="dim">/</span>
        <span className="dim">{branch?.company_name}</span><span className="dim">/</span>
        <span>{branch?.name}</span>
      </div>
      <div className="bar-right">
        {right}
        {children}
        <Link className="btn" to={`/${tenant}/app`}>🏠 {t('Dashboard')}</Link>
        <LangSwitch style={{ height: 44 }} onPick={(l) => api.patch('/auth/profile', { language: l }).catch(() => undefined)} />
        <button onClick={onLock}>{tr("🔒 Lock")}</button>
        {u && (
          <div className="user-chip" title={u.role_name}>
            <div className="who"><b>{u.full_name}</b><br /><small>{u.position || u.role_name}</small></div>
            <div className="avatar-sm" style={{ background: u.color }}>
              {u.full_name.split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
