export const fmt = (n: number | null | undefined, currency = '') =>
  (n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (currency ? ` ${currency}` : '');

export const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, ''));

export const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '');
export const time = (s: string | null | undefined) => (s ? new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
export const minutesSince = (s: string) => Math.max(0, Math.floor((Date.now() - new Date(s).getTime()) / 60000));

export const today = () => new Date().toISOString().slice(0, 10);
export const thisMonth = () => new Date().toISOString().slice(0, 7);

export const ORDER_TYPES: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };
/** Today's date in the device's local timezone (YYYY-MM-DD). */
export const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
