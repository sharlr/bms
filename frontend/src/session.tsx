import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getBranchId, setContext } from './api';
import { useLang } from './i18n';

export interface Me {
  tenant: { slug: string; name: string };
  device: { id: number; name: string; mode: string; branch_id: number; register_id: number | null } | null;
  user: null | {
    id: number; username: string; full_name: string; is_tenant_admin: boolean; role_name: string; color: string;
    permissions: string[]; device_bound: boolean; position: string | null; theme: string; language: string; landing_page: string;
  };
  context: null | {
    companies: { id: number; name: string; base_currency: string }[];
    branches: { id: number; name: string; code: string; company_id: number; company_name: string; base_currency: string }[];
  };
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<Me | null>;
  branchId: number | null;
  switchBranch: (branchId: number) => void;
  can: (perm: string) => boolean;
  currency: string;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<number | null>(getBranchId());
  const { setLang } = useLang();

  const reload = useCallback(async () => {
    try {
      const m = await api.get<Me>('/auth/me');
      // Device-bound sessions use the device's branch; others keep the stored choice if still accessible.
      let b = m.device && m.user?.device_bound ? m.device.branch_id : getBranchId();
      const branches = m.context?.branches ?? [];
      if (m.user && branches.length && !branches.some((x) => x.id === b)) b = branches[0].id;
      if (m.user && b) {
        const br = branches.find((x) => x.id === b);
        setContext(br?.company_id ?? null, b);
        setBranchId(b);
      }
      setMe(m);
      // Theme + language follow the signed-in user (kept locally so terminals/login screens match).
      // Theme + language follow the signed-in user (kept on the device so login / terminal screens match).
      if (m.user) { localStorage.setItem('bms:theme', m.user.theme); setLang(m.user.language); }
      document.documentElement.dataset.theme = localStorage.getItem('bms:theme') ?? 'gold';
      setError(null);
      return m;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [setLang]);

  useEffect(() => { reload(); }, [reload]);

  const switchBranch = (id: number) => {
    const br = me?.context?.branches.find((x) => x.id === id);
    if (!br) return;
    setContext(br.company_id, id);
    setBranchId(id);
  };
  const can = (perm: string) => !!me?.user && (me.user.is_tenant_admin || me.user.permissions.includes('*') || me.user.permissions.includes(perm));
  const currency = me?.context?.branches.find((b) => b.id === branchId)?.base_currency ?? '';

  return <Ctx.Provider value={{ me, loading, error, reload, branchId, switchBranch, can, currency }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}

export const LANDING_PAGES = [
  { code: 'auto', label: 'Automatic (by role)' }, { code: 'home', label: 'Home / dashboard' },
  { code: 'pos', label: 'POS terminal' }, { code: 'kds', label: 'Kitchen display' }, { code: 'orders', label: 'Orders / tickets' },
] as const;

/**
 * Where a user lands after signing in. "auto": managers/admins → Home, cashiers & waiters → POS, kitchen → KDS.
 * A chosen page the user has no right to falls back to Home.
 */
export function landingRoute(u: NonNullable<Me['user']>): string {
  const has = (p: string) => u.is_tenant_admin || u.permissions.includes('*') || u.permissions.includes(p);
  let lp = u.landing_page;
  if (lp === 'auto') lp = has('reports.monthly') || has('org.manage') || has('users.manage') ? 'home' : has('pos.access') ? 'pos' : has('kds.view') ? 'kds' : 'home';
  if ((lp === 'pos' || lp === 'orders') && !has('pos.access')) lp = 'home';
  if (lp === 'kds' && !has('kds.view')) lp = 'home';
  return ({ home: 'app', pos: 'pos', kds: 'kds', orders: 'app/orders' } as Record<string, string>)[lp] ?? 'app';
}
