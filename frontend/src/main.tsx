import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider, useParams } from 'react-router-dom';
import { Loading, OverrideProvider, ToastProvider } from './components/ui';
import { Landing, Login, TenantHome, Terminal } from './pages/Auth';
import { CustomerOrder, ReservationStatus, Reserve, SandboxPay, Track } from './pages/Customer';
import { SessionProvider } from './session';
import './styles.css';
const Pos = lazy(() => import('./pages/Pos').then((m) => ({ default: m.Pos })));
const Platform = lazy(() => import('./pages/Platform').then((m) => ({ default: m.Platform })));
const Kiosk = lazy(() => import('./pages/Kiosk').then((m) => ({ default: m.Kiosk })));
const Kds = lazy(() => import('./pages/Kds').then((m) => ({ default: m.Kds })));
const AdminApp = lazy(() => import('./pages/admin/AdminApp').then((m) => ({ default: m.AdminApp })));

function ErrorScreen() {
  return (
    <div className="login-wrap"><div className="card login-card stack center">
      <h2>Something went wrong</h2>
      <p className="muted">Please reload the page. If it keeps happening, tell the restaurant staff.</p>
      <button className="primary lg" onClick={() => location.reload()}>Reload</button>
    </div></div>
  );
}

function TenantRoot() {
  const { tenant } = useParams();
  return (
    <SessionProvider key={tenant}>
      <OverrideProvider>
        <Outlet />
      </OverrideProvider>
    </SessionProvider>
  );
}

const router = createBrowserRouter([
  { path: '/', element: <Landing />, errorElement: <ErrorScreen /> },
  { path: '/platform', element: <Platform /> },
  {
    path: '/:tenant',
    element: <TenantRoot />,
    errorElement: <ErrorScreen />,
    children: [
      { index: true, element: <TenantHome /> },
      { path: 'login', element: <Login /> },
      { path: 'terminal', element: <Terminal /> },
      { path: 'pos', element: <Pos /> },
      { path: 'kds', element: <Kds /> },
      { path: 'kiosk', element: <Kiosk /> },
      { path: 'menu', element: <CustomerOrder /> },
      { path: 'order', element: <CustomerOrder /> },
      { path: 'track/:token', element: <Track /> },
      { path: 'pay/sandbox/:id', element: <SandboxPay /> },
      { path: 'reserve', element: <Reserve /> },
      { path: 'reservation/:token', element: <ReservationStatus /> },
      { path: 'app/*', element: <AdminApp /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <Suspense fallback={<Loading />}><RouterProvider router={router} /></Suspense>
    </ToastProvider>
  </StrictMode>,
);
