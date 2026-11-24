import { useT as useTr } from '../../i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { CrudPage } from '../../components/CrudPage';
import { ReservationsPage } from '../../components/Reservations';
import { Loading, Modal, useAction } from '../../components/ui';
import { LANGUAGES, SOFTWARE, THEMES, useT } from '../../i18n';
import { useSession } from '../../session';
import { fmt } from '../../util';
import { BackupPage } from './Backup';
import { Dashboard } from './Dashboard';
import { Profile } from './Profile';
import { CommissionReport, Expenses, ExchangeRates } from './Finance';
import { FloorEditor } from './FloorEditor';
import { LowStock, Movements, Recipes, Stock, Waste } from './Inventory';
import { MenuCatalog } from './MenuCatalog';
import { MenuItems } from './MenuItems';
import { Orders } from './Orders';
import { ItemSalesReport, SettlementReport, StaffReport } from './RangeReports';
import { MonthlyReport, ShiftHistory, XReport, ZReport } from './Reports';
import { Branches, Companies, Devices, PrintJobs, Users } from './Settings';

interface NavItem { to?: string; label: string; perm?: string; children?: NavItem[]; external?: boolean }

const NAV: NavItem[] = [
  { to: '', label: 'Dashboard' },
  {
    label: 'POS', children: [
      { to: 'pos-terminal', label: 'POS Terminal', perm: 'pos.access', external: true },
      { to: 'floor', label: 'Floor Plan', perm: 'floor.manage' },
      { to: 'kds-screen', label: 'Kitchen Display', perm: 'kds.view', external: true },
      { to: 'orders', label: 'Orders / Tickets', perm: 'pos.access' },
      { to: 'reservations', label: 'Reservations', perm: 'pos.access' },
      {
        label: 'Delivery & Commissions', children: [
          { to: 'delivery/partners', label: 'Delivery Partners', perm: 'delivery.manage' },
          { to: 'delivery/zones', label: 'Zones', perm: 'delivery.manage' },
          { to: 'delivery/rules', label: 'Commission Rules', perm: 'delivery.manage' },
          { to: 'delivery/commissions', label: 'Commission Report', perm: 'delivery.manage' },
        ],
      },
      {
        label: 'Recipes & Inventory', children: [
          { to: 'inventory/ingredients', label: 'Ingredients' },
          { to: 'inventory/stock', label: 'Branch Stock' },
          { to: 'inventory/recipes', label: 'Recipes' },
          { to: 'inventory/movements', label: 'Stock Ledger' },
          { to: 'inventory/low', label: 'Low Stock Alerts' },
        ],
      },
      { to: 'waste', label: 'Waste Management' },
      { to: 'rates', label: 'Exchange Rates' },
      {
        label: 'Counter Expenses', children: [
          { to: 'expenses', label: 'Expenses', perm: 'expenses.record' },
          { to: 'expenses/categories', label: 'Categories', perm: 'org.manage' },
        ],
      },
      {
        label: 'Reports', children: [
          { to: 'reports/x', label: 'X Report', perm: 'reports.x' },
          { to: 'reports/z', label: 'Z Report (close day)', perm: 'reports.z' },
          { to: 'reports/shifts', label: 'X/Z History', perm: 'reports.x' },
          { to: 'reports/monthly', label: 'Monthly Consolidated', perm: 'reports.monthly' },
          { to: 'reports/staff', label: 'Staff Activity', perm: 'reports.monthly' },
          { to: 'reports/settlements', label: 'Settlement-wise Receipts', perm: 'reports.monthly' },
          { to: 'reports/items', label: 'Item-wise Sales', perm: 'reports.monthly' },
        ],
      },
    ],
  },
  {
    label: 'Menu', children: [
      { to: 'menu/catalog', label: 'Menu Overview & Prices' },
      { to: 'menu/categories', label: 'Categories' },
      { to: 'menu/items', label: 'Items, Sizes & Prices' },
      { to: 'menu/modifiers', label: 'Modifiers' },
      { to: 'menu/cooking-notes', label: 'Cooking Notes' },
      { to: 'menu/stations', label: 'Kitchens & Bars' },
    ],
  },
  {
    label: 'Clients', children: [
      { to: 'clients', label: 'Client List' },
      { to: 'coupons', label: 'Coupons', perm: 'clients.manage' },
    ],
  },
  {
    label: 'Backup & Restore', children: [
      { to: 'backup', label: 'Backup & Restore', perm: 'backup.manage' },
    ],
  },
  {
    label: 'Settings', children: [
      { to: 'settings/companies', label: 'Companies', perm: 'org.manage' },
      { to: 'settings/branches', label: 'Branches', perm: 'org.manage' },
      { to: 'settings/users', label: 'Users', perm: 'users.manage' },
      { to: 'settings/roles', label: 'Roles & Permissions', perm: 'users.manage' },
      { to: 'settings/devices', label: 'Devices / Terminals', perm: 'org.manage' },
      { to: 'settings/printers', label: 'Printers (KOT)', perm: 'org.manage' },
      { to: 'settings/registers', label: 'Registers', perm: 'org.manage' },
      { to: 'settings/payment-methods', label: 'Payment Methods', perm: 'org.manage' },
      { to: 'settings/channels', label: 'Receipt Channels', perm: 'org.manage' },
      { to: 'settings/print-jobs', label: 'Print Queue', perm: 'org.manage' },
    ],
  },
];

function groupLabels(items: NavItem[]): string[] {
  return items.flatMap((i) => (i.children ? [i.label, ...groupLabels(i.children)] : []));
}
function leafPaths(items: NavItem[]): string[] {
  return items.flatMap((i) => (i.children ? leafPaths(i.children) : i.to ? [i.to] : []));
}

function NavTree({ items, depth, can, close, open, setOpen }: {
  items: NavItem[]; depth: number; can: (p: string) => boolean; close: () => void;
  open: Record<string, boolean>; setOpen: (o: Record<string, boolean>) => void;
}) {
  const { tenant } = useParams();
  const loc = useLocation();
  const t = useT();
  const here = loc.pathname.split('/app/')[1] ?? '';
  const visible = items.filter((i) => (i.children ? i.children.some((c) => !c.perm || can(c.perm) || c.children) : !i.perm || can(i.perm)));
  return (
    <div className={depth === 1 ? 'sub' : depth >= 2 ? 'subsub' : ''}>
      {visible.map((i) => {
        if (i.children) {
          const isOpen = open[i.label] ?? leafPaths(i.children).includes(here);
          return (
            <div key={i.label}>
              <div className={depth === 0 ? 'group-title' : 'subtitle'} role="button" tabIndex={0}
                onClick={() => setOpen({ ...open, [i.label]: !isOpen })} onKeyDown={(e) => e.key === 'Enter' && setOpen({ ...open, [i.label]: !isOpen })}>
                {t(i.label)}<span>{isOpen ? '▾' : '▸'}</span>
              </div>
              {isOpen && <NavTree items={i.children} depth={depth + 1} can={can} close={close} open={open} setOpen={setOpen} />}
            </div>
          );
        }
        if (i.external) {
          const target = i.to === 'pos-terminal' ? 'pos' : 'kds';
          return <Link key={i.label} to={`/${tenant}/${target}`} onClick={close}>{t(i.label)} ↗</Link>;
        }
        return <NavLink key={i.label} end={i.to === ''} to={`/${tenant}/app/${i.to}`} onClick={close}>{t(i.label)}</NavLink>;
      })}
    </div>
  );
}

/** Click-to-open popover anchored to its trigger; closes on outside click. */
function Pop({ trigger, children }: { trigger: (toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return <div ref={ref} style={{ position: 'relative' }}>{trigger(() => setOpen(!open))}{open && <div className="menu-pop">{children(() => setOpen(false))}</div>}</div>;
}

export function AdminApp() {
  const tr = useTr();
  const { me, loading, can, branchId, switchBranch, reload } = useSession();
  const { tenant } = useParams();
  const nav = useNavigate();
  const t = useT();
  const run = useAction();
  const [sideOpen, setSideOpen] = useState(false); // mobile drawer
  const [sideHidden, setSideHidden] = useState(localStorage.getItem('bms:side-hidden') === '1'); // desktop collapse
  const [open, setOpen] = useState<Record<string, boolean>>({ Dashboard: true, POS: true });
  const [about, setAbout] = useState(false);
  if (loading) return <Loading />;
  if (!me?.user) return <Navigate to={`/${tenant}/login`} replace />;
  const ctx = me.context!;
  const u = me.user;
  const branch = ctx.branches.find((b) => b.id === branchId);
  const logout = async () => { await api.post('/auth/logout', {}); await reload(); nav(`/${tenant}`); };
  const setPref = async (body: object) => { if (await run(() => api.patch('/auth/profile', body))) await reload(); };
  const toggleSide = () => {
    if (window.matchMedia('(max-width: 900px)').matches) return setSideOpen(!sideOpen);
    localStorage.setItem('bms:side-hidden', sideHidden ? '0' : '1');
    setSideHidden(!sideHidden);
  };
  const allGroups = groupLabels(NAV);
  const initials = u.full_name.split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase();

  const g = (perm: string | null, el: ReactNode) => (!perm || can(perm) ? el : <div className="card">{tr("You do not have access to this page.")}</div>);

  return (
    <div className={`shell ${sideHidden ? 'side-hidden' : ''}`}>
      <aside className={`side ${sideOpen ? 'open' : ''}`}>
        <div className="side-brand">
          <div className="logo">{SOFTWARE.initials}</div>
          <div><b>{SOFTWARE.name}</b><span>{SOFTWARE.company}</span><span>{SOFTWARE.version}</span></div>
        </div>
        <div className="side-tools">
          <button title={t('Expand all')} aria-label={t('Expand all')} onClick={() => setOpen(Object.fromEntries(allGroups.map((l) => [l, true])))}>+</button>
          <button title={t('Collapse all')} aria-label={t('Collapse all')} onClick={() => setOpen(Object.fromEntries(allGroups.map((l) => [l, false])))}>−</button>
        </div>
        <NavTree items={NAV} depth={0} can={can} close={() => setSideOpen(false)} open={open} setOpen={setOpen} />
      </aside>
      <div style={{ minWidth: 0 }}>
        <div className="topbar">
          <button className="burger icon-btn" title={sideHidden ? t('Show menu') : t('Hide menu')} aria-label={t('Hide menu')} onClick={toggleSide}>☰</button>
          {/* Tenant / company / branch — the branch select is the context switcher */}
          <div className="crumb">
            <span className="muted">{me.tenant.name}</span><span className="muted">/</span>
            <span>{branch?.company_name}</span><span className="muted">/</span>
            <select aria-label={tr("Company and branch")} value={branchId ?? ''} onChange={(e) => switchBranch(Number(e.target.value))}>
              {ctx.companies.map((c) => (
                <optgroup key={c.id} label={`${c.name} (${c.base_currency})`}>
                  {ctx.branches.filter((b) => b.company_id === c.id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="grow" />
          <Pop trigger={(toggle) => <button className="icon-btn" title={t('Theme')} aria-label={t('Theme')} onClick={toggle}>🎨</button>}>
            {(close) => THEMES.map((th) => (
              <button key={th.code} onClick={() => { close(); setPref({ theme: th.code }); }}>
                <span className="swatch" style={{ background: th.swatch }} /> {tr(th.label)} {u.theme === th.code && '✓'}
              </button>
            ))}
          </Pop>
          <Pop trigger={(toggle) => <button className="icon-btn" aria-label={t('Language')} onClick={toggle}>🌐 {u.language.toUpperCase()} {LANGUAGES.find((l) => l.code === u.language)?.label}</button>}>
            {(close) => LANGUAGES.map((l) => (
              <button key={l.code} onClick={() => { close(); setPref({ language: l.code }); }}>{l.code.toUpperCase()} {l.label} {u.language === l.code && '✓'}</button>
            ))}
          </Pop>
          <Pop trigger={(toggle) => (
            <div className="user-chip" role="button" tabIndex={0} onClick={toggle} onKeyDown={(e) => e.key === 'Enter' && toggle()}>
              <div className="who"><b>{u.full_name}</b><br /><small>{u.position || u.role_name}</small></div>
              <div className="avatar-sm" style={{ background: u.color }}>{initials}</div>
            </div>
          )}>
            {(close) => <>
              <button onClick={() => { close(); nav(`/${tenant}/app/profile`); }}>👤 {t('My profile')}</button>
              <button onClick={() => { close(); setAbout(true); }}>ℹ️ {t('About the Software')}</button>
            </>}
          </Pop>
          <button className="icon-btn" title={t('Sign out')} aria-label={t('Sign out')} onClick={logout}>⎋</button>
        </div>
        {about && (
          <Modal title={t('About the Software')} onClose={() => setAbout(false)}>
            <div className="stack center">
              <div className="side-brand" style={{ background: 'var(--side-bg)', borderRadius: 12, padding: '1rem', justifyContent: 'center' }}>
                <div className="logo">{SOFTWARE.initials}</div><div style={{ textAlign: 'left' }}><b>{SOFTWARE.name}</b><span>{SOFTWARE.version}</span></div>
              </div>
              <p>{tr("Multi-tenant restaurant management & POS.")}<br />© {new Date().getFullYear()} {SOFTWARE.company}</p>
              <p className="small muted">{tr("Tenant: ")}{me.tenant.name} ({me.tenant.slug})</p>
            </div>
          </Modal>
        )}
        <main className="content" key={branchId ?? 0}>
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="profile" element={<Profile />} />
            <Route path="backup" element={g('backup.manage', <BackupPage />)} />
            <Route path="floor" element={g('floor.manage', <FloorEditor />)} />
            <Route path="orders" element={g('pos.access', <Orders />)} />
            <Route path="reservations" element={g('pos.access', <ReservationsPage />)} />
            <Route path="delivery/partners" element={g('delivery.manage', <CrudPage title={tr("Delivery Partners")} path="/delivery/companies"
              columns={[{ key: 'name', label: tr("Name") }, { key: 'phone', label: tr("Phone") }, { key: 'available_online', label: tr("Online") }, { key: 'active', label: tr("Active") }]}
              fields={[{ key: 'name', label: tr("Name"), required: true }, { key: 'phone', label: tr("Phone") }, { key: 'email', label: tr("Email") },
                { key: 'available_online', label: tr("Selectable by online customers"), type: 'bool' }, { key: 'sort', label: tr("Sort"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
              defaults={{ available_online: true, active: true }} />)} />
            <Route path="delivery/zones" element={g('delivery.manage', <CrudPage title={tr("Delivery Zones")} path="/delivery/zones"
              columns={[{ key: 'name', label: tr("Zone") }, { key: 'active', label: tr("Active") }]} fields={[{ key: 'name', label: tr("Zone"), required: true }, { key: 'active', label: tr("Active"), type: 'bool' }]} defaults={{ active: true }} />)} />
            <Route path="delivery/rules" element={g('delivery.manage', <CrudPage title={tr("Commission Rules")} path="/delivery/rules"
              columns={[{ key: 'delivery_company_id', label: tr("Partner") }, { key: 'basis', label: tr("Basis") }, { key: 'commission_type', label: tr("Type") },
                { key: 'value', label: tr("Value"), num: true }, { key: 'zone_id', label: tr("Zone") }, { key: 'client_id', label: tr("Client") }, { key: 'menu_item_id', label: tr("Item") },
                { key: 'branch_id', label: tr("Branch") }, { key: 'priority', label: tr("Priority"), num: true }, { key: 'active', label: tr("Active") }]}
              fields={[
                { key: 'delivery_company_id', label: tr("Delivery partner"), type: 'select', required: true, optionsFrom: { path: '/delivery/companies', label: 'name' }, createOnly: true },
                { key: 'basis', label: tr("Calculation basis"), type: 'select', required: true, options: [
                  { value: 'delivery', label: tr("Per delivery (order)") }, { value: 'item', label: tr("Per item") }, { value: 'zone', label: tr("Per location / zone") }, { value: 'client', label: tr("Per client") }] },
                { key: 'commission_type', label: tr("Commission type"), type: 'select', required: true, options: [{ value: 'fixed', label: tr("Fixed amount") }, { value: 'percent', label: tr("Percentage") }] },
                { key: 'value', label: tr("Value"), type: 'number', required: true },
                { key: 'zone_id', label: tr("Zone (zone basis)"), type: 'select', optionsFrom: { path: '/delivery/zones', label: 'name', nullLabel: '—' } },
                { key: 'client_id', label: tr("Client (client basis)"), type: 'select', optionsFrom: { path: '/clients', label: 'name', nullLabel: '—' } },
                { key: 'menu_item_id', label: tr("Item (item basis; empty = all items)"), type: 'select', optionsFrom: { path: '/menu/items', label: 'name', nullLabel: tr("All items") } },
                { key: 'branch_id', label: tr("Branch (empty = all)"), type: 'select', optionsFrom: { path: '/branches', label: 'name', nullLabel: tr("All branches") } },
                { key: 'priority', label: tr("Priority"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
              defaults={{ basis: 'delivery', commission_type: 'percent', value: 0, priority: 0, active: true }} />)} />
            <Route path="delivery/commissions" element={g('delivery.manage', <CommissionReport />)} />
            <Route path="inventory/ingredients" element={<CrudPage title={tr("Ingredients")} path="/inventory/ingredients" canWrite={can('inventory.manage')}
              columns={[{ key: 'name', label: tr("Name") }, { key: 'unit', label: tr("Unit") }, { key: 'cost_per_unit', label: tr("Cost / unit"), num: true }, { key: 'active', label: tr("Active") }]}
              fields={[{ key: 'name', label: tr("Name"), required: true }, { key: 'unit', label: tr("Unit (g, ml, pcs…)"), required: true }, { key: 'cost_per_unit', label: tr("Cost per unit"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
              defaults={{ unit: 'g', cost_per_unit: 0, active: true }} />} />
            <Route path="inventory/stock" element={<Stock />} />
            <Route path="inventory/recipes" element={<Recipes />} />
            <Route path="inventory/movements" element={<Movements />} />
            <Route path="inventory/low" element={<LowStock />} />
            <Route path="waste" element={<Waste />} />
            <Route path="rates" element={<ExchangeRates />} />
            <Route path="expenses" element={g('expenses.record', <Expenses />)} />
            <Route path="expenses/categories" element={g('org.manage', <CrudPage title={tr("Expense Categories")} path="/expense-categories"
              columns={[{ key: 'name', label: tr("Name") }, { key: 'active', label: tr("Active") }]} fields={[{ key: 'name', label: tr("Name"), required: true }, { key: 'active', label: tr("Active"), type: 'bool' }]} defaults={{ active: true }} />)} />
            <Route path="reports/x" element={g('reports.x', <XReport />)} />
            <Route path="reports/z" element={g('reports.z', <ZReport />)} />
            <Route path="reports/shifts" element={g('reports.x', <ShiftHistory />)} />
            <Route path="reports/monthly" element={g('reports.monthly', <MonthlyReport />)} />
            <Route path="reports/staff" element={g('reports.monthly', <StaffReport />)} />
            <Route path="reports/settlements" element={g('reports.monthly', <SettlementReport />)} />
            <Route path="reports/items" element={g('reports.monthly', <ItemSalesReport />)} />
            <Route path="menu/categories" element={<CrudPage title={tr("Menu Categories")} path="/menu/categories" canWrite={can('menu.manage')}
              columns={[{ key: 'name', label: tr("Name") }, { key: 'station_id', label: tr("Prepared in") }, { key: 'color', label: tr("Color") }, { key: 'sort', label: tr("Sort"), num: true }, { key: 'active', label: tr("Active") }]}
              fields={[{ key: 'name', label: tr("Name"), required: true },
                { key: 'station_id', label: tr("Prepared in (kitchen / bar)"), type: 'select', optionsFrom: { path: '/prep-stations', label: 'name', nullLabel: tr("No kitchen ticket") } },
                { key: 'parent_id', label: tr("Parent category"), type: 'select', optionsFrom: { path: '/menu/categories', label: 'name', nullLabel: tr("— top level —") } },
                { key: 'color', label: tr("Tab color"), type: 'color' }, { key: 'sort', label: tr("Sort"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
              defaults={{ station_id: null, color: '#64748b', sort: 0, active: true }} />} />
            <Route path="menu/items" element={<MenuItems />} />
            <Route path="menu/catalog" element={<MenuCatalog />} />
            <Route path="menu/stations" element={<CrudPage title={tr("Kitchens & Bars (preparation stations)")} path="/prep-stations" canWrite={can('menu.manage')}
              columns={[{ key: 'name', label: tr("Name") }, { key: 'color', label: tr("Colour") }, { key: 'sort', label: tr("Sort"), num: true }, { key: 'active', label: tr("Active") }]}
              fields={[{ key: 'name', label: tr("Name (e.g. Grill, Pizza oven, Pool bar)"), required: true }, { key: 'color', label: tr("Colour on the kitchen display"), type: 'color' },
                { key: 'sort', label: tr("Sort"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
              defaults={{ color: '#2563eb', sort: 0, active: true }} />} />
            <Route path="menu/cooking-notes" element={<CrudPage title={tr("Cooking Notes")} path="/menu/cooking-notes" canWrite={can('menu.manage')}
              columns={[{ key: 'text', label: tr("Note") }, { key: 'sort', label: tr("Sort"), num: true }, { key: 'active', label: tr("Active") }]}
              fields={[{ key: 'text', label: tr("Note (e.g. Well done)"), required: true }, { key: 'sort', label: tr("Sort"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
              defaults={{ sort: 0, active: true }} />} />
            <Route path="menu/modifiers" element={<div className="stack">
              <CrudPage title={tr("Modifier Groups")} path="/menu/modifier-groups" canWrite={can('menu.manage')}
                columns={[{ key: 'name', label: tr("Group") }, { key: 'min_select', label: tr("Min"), num: true }, { key: 'max_select', label: tr("Max"), num: true }, { key: 'active', label: tr("Active") }]}
                fields={[{ key: 'name', label: tr("Name"), required: true }, { key: 'min_select', label: tr("Min selections"), type: 'number' }, { key: 'max_select', label: tr("Max selections"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
                defaults={{ min_select: 0, max_select: 5, active: true }} />
              <CrudPage title={tr("Modifiers")} path="/menu/modifiers" canWrite={can('menu.manage')}
                columns={[{ key: 'group_id', label: tr("Group") }, { key: 'name', label: tr("Modifier") }, { key: 'price_delta', label: tr("Price +/-"), num: true }, { key: 'active', label: tr("Active") }]}
                fields={[{ key: 'group_id', label: tr("Group"), type: 'select', required: true, optionsFrom: { path: '/menu/modifier-groups', label: 'name' }, createOnly: true },
                  { key: 'name', label: tr("Name"), required: true }, { key: 'price_delta', label: tr("Price change"), type: 'number' }, { key: 'sort', label: tr("Sort"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
                defaults={{ price_delta: 0, sort: 0, active: true }} />
            </div>} />
            <Route path="clients" element={<CrudPage title={tr("Client List")} path="/clients" canWrite={can('clients.manage')}
              columns={[{ key: 'name', label: tr("Name") }, { key: 'phone', label: tr("Phone") }, { key: 'credit_allowed', label: tr("Credit") },
                { key: 'credit_limit', label: tr("Limit"), num: true }, { key: 'balance', label: tr("Balance owed"), num: true, render: (r) => fmt(r.balance) }, { key: 'active', label: tr("Active") }]}
              fields={[{ key: 'name', label: tr("Name"), required: true }, { key: 'phone', label: tr("Phone") }, { key: 'email', label: tr("Email") }, { key: 'tax_id', label: tr("Tax ID") },
                { key: 'address', label: tr("Address"), type: 'textarea' }, { key: 'credit_allowed', label: tr("Allow credit sales"), type: 'bool' },
                { key: 'credit_limit', label: tr("Credit limit (0 = unlimited)"), type: 'number' }, { key: 'notes', label: tr("Notes"), type: 'textarea' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
              defaults={{ credit_allowed: false, credit_limit: 0, active: true }} />} />
            <Route path="coupons" element={g('clients.manage', <CrudPage title={tr("Coupons")} path="/coupons"
              columns={[{ key: 'code', label: tr("Code") }, { key: 'discount_type', label: tr("Type") }, { key: 'value', label: tr("Value"), num: true }, { key: 'used_count', label: tr("Used"), num: true }, { key: 'max_uses', label: tr("Max"), num: true }, { key: 'active', label: tr("Active") }]}
              fields={[{ key: 'code', label: tr("Code"), required: true }, { key: 'discount_type', label: tr("Type"), type: 'select', required: true, options: [{ value: 'percent', label: tr("Percent") }, { value: 'fixed', label: tr("Fixed") }] },
                { key: 'value', label: tr("Value"), type: 'number', required: true }, { key: 'min_order', label: tr("Minimum order"), type: 'number' },
                { key: 'valid_from', label: tr("Valid from"), type: 'date' }, { key: 'valid_to', label: tr("Valid to"), type: 'date' }, { key: 'max_uses', label: tr("Max uses"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
              defaults={{ discount_type: 'percent', min_order: 0, active: true }} />)} />
            <Route path="settings/companies" element={g('org.manage', <Companies />)} />
            <Route path="settings/branches" element={g('org.manage', <Branches />)} />
            <Route path="settings/users" element={g('users.manage', <Users />)} />
            <Route path="settings/roles" element={g('users.manage', <Roles />)} />
            <Route path="settings/devices" element={g('org.manage', <Devices />)} />
            <Route path="settings/printers" element={g('org.manage', <CrudPage title={tr("Printers (per branch)")} path="/printers"
              columns={[{ key: 'name', label: tr("Name") }, { key: 'kind', label: tr("Kind") }, { key: 'station_id', label: tr("Kitchen / bar") }, { key: 'connection', label: tr("Connection") }, { key: 'active', label: tr("Active") }]}
              fields={[{ key: 'name', label: tr("Name"), required: true },
                { key: 'kind', label: tr("Kind"), type: 'select', required: true, options: [{ value: 'kot', label: tr("Kitchen ticket (KOT)") }, { value: 'receipt', label: tr("Receipt") }] },
                { key: 'station_id', label: tr("Kitchen / bar (for KOT printers)"), type: 'select', optionsFrom: { path: '/prep-stations', label: 'name', nullLabel: tr("— (receipt printer)") } },
                { key: 'connection', label: tr("Connection"), help: tr("tcp://192.168.1.50:9100 (reached by the in-store print agent), or \"browser\" for receipts") },
                { key: 'chars_per_line', label: tr("Characters per line"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]}
              defaults={{ kind: 'kot', station_id: null, connection: 'tcp://192.168.1.50:9100', chars_per_line: 42, active: true }} />)} />
            <Route path="settings/registers" element={g('org.manage', <CrudPage title={tr("Registers / Counters")} path="/registers"
              columns={[{ key: 'name', label: tr("Name") }, { key: 'active', label: tr("Active") }]} fields={[{ key: 'name', label: tr("Name"), required: true }, { key: 'active', label: tr("Active"), type: 'bool' }]} defaults={{ active: true }} />)} />
            <Route path="settings/payment-methods" element={g('org.manage', <CrudPage title={tr("Payment Methods")} path="/payment-methods"
              columns={[{ key: 'name', label: tr("Name") }, { key: 'method_type', label: tr("Type") }, { key: 'sort', label: tr("Sort"), num: true }, { key: 'active', label: tr("Active") }]}
              fields={[{ key: 'name', label: tr("Name"), required: true }, { key: 'method_type', label: tr("Type"), type: 'select', required: true, options: ['cash', 'card', 'credit', 'mobile_money', 'voucher', 'other'].map((v) => ({ value: v, label: v })) },
                { key: 'sort', label: tr("Sort"), type: 'number' }, { key: 'active', label: tr("Active"), type: 'bool' }]} defaults={{ method_type: 'cash', sort: 0, active: true }} />)} />
            <Route path="settings/channels" element={g('org.manage', <CrudPage title={tr("Receipt Channels")} path="/receipt-channels"
              columns={[{ key: 'code', label: tr("Code") }, { key: 'name', label: tr("Name") }, { key: 'channel_type', label: tr("Type") }, { key: 'branch_id', label: tr("Branch") }, { key: 'active', label: tr("Active") }]}
              fields={[{ key: 'code', label: tr("Code (A-Z, 0-9, _)"), required: true }, { key: 'name', label: tr("Name"), required: true },
                { key: 'channel_type', label: tr("Type"), type: 'select', required: true, options: ['pos', 'waiter', 'takeaway', 'kiosk', 'qr', 'online', 'delivery'].map((v) => ({ value: v, label: v })) },
                { key: 'branch_id', label: tr("Branch (empty = all)"), type: 'select', optionsFrom: { path: '/branches', label: 'name', nullLabel: tr("All branches") } },
                { key: 'active', label: tr("Active"), type: 'bool' }]} defaults={{ channel_type: 'pos', active: true }} />)} />
            <Route path="settings/print-jobs" element={g('org.manage', <PrintJobs />)} />
            <Route path="*" element={<div className="card">{tr("Not found")}</div>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Roles() {
  const tr = useTr();
  const [perms, setPerms] = useState<Record<string, string> | null>(null);
  useEffect(() => { api.get('/auth/permissions').then(setPerms).catch(() => undefined); }, []);
  return <CrudPage title={tr("Roles & Permissions")} path="/roles" deleteLabel={null}
    columns={[{ key: 'name', label: tr("Role") }, { key: 'permissions', label: tr("Permissions"), render: (r) => <span className="small">{r.permissions.join(', ')}</span> }]}
    fields={[{ key: 'name', label: tr("Name"), required: true }]}
    defaults={{ permissions: [] }}
    rowActions={(r, reload) => perms && <PermEditor role={r} perms={perms} onSaved={reload} />} />;
}

function PermEditor({ role, perms, onSaved }: { role: any; perms: Record<string, string>; onSaved: () => void }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>(role.permissions);
  if (!open) return <button className="sm" onClick={() => setOpen(true)}>{tr("Permissions")}</button>;
  return (
    <div className="modal-back"><div className="modal">
      <h2>{role.name}</h2>
      <label className="check"><input type="checkbox" checked={sel.includes('*')} onChange={(e) => setSel(e.target.checked ? ['*'] : [])} /> <b>{tr("All permissions (administrator)")}</b></label>
      <div className="grid2">{Object.entries(perms).map(([k, v]) => (
        <label key={k} className="check small"><input type="checkbox" disabled={sel.includes('*')} checked={sel.includes(k)} onChange={(e) => setSel(e.target.checked ? [...sel, k] : sel.filter((x) => x !== k))} /> {tr(v)}</label>
      ))}</div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: '1rem' }}>
        <button onClick={() => setOpen(false)}>{tr("Cancel")}</button>
        <button className="primary" onClick={async () => { await api.patch(`/roles/${role.id}`, { permissions: sel }); setOpen(false); onSaved(); }}>{tr("Save")}</button>
      </div>
    </div></div>
  );
}
