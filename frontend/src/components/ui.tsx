import { useT as useTr } from '../i18n';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { useT } from '../i18n';

// ---------- Toasts ----------
type Toast = { id: number; msg: string; error?: boolean };
const ToastCtx = createContext<(msg: string, error?: boolean) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((msg: string, error = false) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, msg, error }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), error ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">{list.map((t) => <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Wrap an async action: shows errors as toasts, returns undefined on failure. */
export function useAction() {
  const toast = useToast();
  const tr = useT(); // success texts and server error messages are shown in the user's language
  return useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    try {
      const r = await fn();
      if (success) toast(tr(success));
      return r;
    } catch (e) {
      toast(tr(e instanceof Error ? e.message : String(e)), true);
      return undefined;
    }
  }, [toast, tr]);
}

// ---------- Modal ----------
export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const tr = useTr();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label={tr("Close")}>✕</button></div>
        {children}
      </div>
    </div>
  );
}

// ---------- Numpad ----------
export function Numpad({ value, onChange, decimals = true, max = 12 }: { value: string; onChange: (v: string) => void; decimals?: boolean; max?: number }) {
  const press = (k: string) => {
    if (k === '⌫') return onChange(value.slice(0, -1));
    if (k === 'C') return onChange('');
    if (k === '.' && (!decimals || value.includes('.'))) return;
    if (value.length >= max) return;
    onChange(value === '0' && k !== '.' ? k : value + k);
  };
  return (
    <div className="numpad">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', decimals ? '.' : 'C', '0', '⌫'].map((k) => (
        <button key={k} type="button" onClick={() => press(k)}>{k}</button>
      ))}
    </div>
  );
}

export function PinDots({ n }: { n: number }) {
  return <div className="pin-dots">{[0, 1, 2, 3].map((i) => <span key={i} className={i < n ? 'on' : ''} />)}</div>;
}

// ---------- Manager override (supervisor PIN) ----------
type Override = { user_id: number; pin: string };
const OverrideCtx = createContext<(staff: { id: number; full_name: string }[], reason: string) => Promise<Override | null>>(async () => null);

export function OverrideProvider({ children }: { children: ReactNode }) {
  const tr = useTr();
  const [req, setReq] = useState<null | { staff: { id: number; full_name: string }[]; reason: string; resolve: (o: Override | null) => void }>(null);
  const [user, setUser] = useState<number | null>(null);
  const [pin, setPin] = useState('');
  const ask = useCallback((staff: { id: number; full_name: string }[], reason: string) =>
    new Promise<Override | null>((resolve) => { setUser(null); setPin(''); setReq({ staff, reason, resolve }); }), []);
  const close = (o: Override | null) => { req?.resolve(o); setReq(null); };
  return (
    <OverrideCtx.Provider value={ask}>
      {children}
      {req && (
        <Modal title={tr("Manager approval")} onClose={() => close(null)}>
          <p className="muted">{req.reason}</p>
          {!user ? (
            <div className="staff-grid">
              {req.staff.map((s) => <button key={s.id} className="dark" onClick={() => setUser(s.id)}>{s.full_name}</button>)}
            </div>
          ) : (
            <div style={{ maxWidth: 300, margin: 'auto' }}>
              <PinDots n={pin.length} />
              <Numpad value={pin} decimals={false} max={4} onChange={(v) => {
                setPin(v);
                if (v.length === 4) close({ user_id: user, pin: v });
              }} />
            </div>
          )}
        </Modal>
      )}
    </OverrideCtx.Provider>
  );
}

/**
 * Run a privileged POS action. If the server answers "Manager approval required", ask a supervisor
 * to approve with their PIN and retry with `override`.
 */
export function useOverride(staff: () => Promise<{ id: number; full_name: string }[]>) {
  const ask = useContext(OverrideCtx);
  return useCallback(async <T,>(fn: (override?: Override) => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && /approval required/i.test(e.message)) {
        const o = await ask(await staff(), e.message);
        if (!o) throw new Error('Cancelled');
        return fn(o);
      }
      throw e;
    }
  }, [ask, staff]);
}

export function Loading() {
  const tr = useTr(); return <div className="center muted" style={{ padding: '2rem' }}>{tr("Loading…")}</div>; }
