import { useT as useTr } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { useBranchEvents } from '../socket';
import { todayLocal } from '../util';
import { Modal, useAction } from './ui';

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'To confirm', cls: 'warn' }, confirmed: { label: 'Confirmed', cls: 'ok' }, seated: { label: 'Seated', cls: 'info' },
  cancelled: { label: 'Cancelled', cls: '' }, no_show: { label: 'No-show', cls: 'bad' },
};

/** Table bookings for a date range: confirm, assign a table, seat (opens the ticket), no-show, cancel, or add a phone booking. */
export function ReservationsPanel({ from, to, onSeated }: { from: string; to: string; onSeated?: (ticketId: number) => void }) {
  const tr = useTr();
  const { branchId, can } = useSession();
  const run = useAction();
  const [rows, setRows] = useState<any[] | null>(null);
  const [tables, setTables] = useState<any[]>([]);
  const [add, setAdd] = useState<any>(null);
  const load = useCallback(() => api.get(`/reservations?from=${from}&to=${to}`).then(setRows).catch(() => setRows([])), [from, to]);
  useEffect(() => { load(); api.get('/tables').then((t) => setTables(t.filter((x: any) => x.active))); }, [load]);
  useBranchEvents(branchId, ['reservation:new', 'reservation:changed', 'tables:changed'], () => load());
  const patch = async (id: number, body: object, msg?: string) => { if (await run(() => api.patch(`/reservations/${id}`, body), msg)) load(); };
  const write = can('pos.order');

  return (
    <div className="stack">
      <div className="row between">
        <span className="muted small">{rows?.filter((r) => r.status === 'pending' || r.status === 'confirmed').length ?? 0} {tr(" upcoming")}</span>
        {write && <button className="primary" onClick={() => setAdd({ customer_name: '', customer_phone: '', pax: '2', date: from, time: '', special_request: '', table_id: null })}>{tr("+ New booking")}</button>}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{tr("When")}</th><th>{tr("Guest")}</th><th className="num">{tr("Pax")}</th><th>{tr("Request")}</th><th>{tr("Table")}</th><th>{tr("Status")}</th><th /></tr></thead>
          <tbody>
            {rows?.map((r) => {
              const live = r.status === 'pending' || r.status === 'confirmed';
              return (
                <tr key={r.id}>
                  <td><b>{r.local_time}</b>{from !== to && <div className="small muted">{r.local_date}</div>}</td>
                  <td>{r.customer_name}<div className="small"><a href={`tel:${r.customer_phone}`}>{r.customer_phone}</a>{r.source === 'online' ? tr(" · online") : ''}</div></td>
                  <td className="num">{r.pax}</td>
                  <td className="small">{r.special_request}</td>
                  <td>{live && write
                    ? <select aria-label={tr("Assign table")} value={r.table_id ?? ''} onChange={(e) => patch(r.id, { table_id: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">—</option>{tables.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.seats})</option>)}</select>
                    : r.table_name ?? '—'}{r.ticket_ref && <div className="small muted">{r.ticket_ref}</div>}</td>
                  <td><span className={`pill ${STATUS[r.status]?.cls}`}>{tr(STATUS[r.status]?.label) ?? r.status}</span></td>
                  <td className="right">{live && write && <div className="row nowrap" style={{ justifyContent: 'flex-end' }}>
                    {r.status === 'pending' && <button className="sm ok" onClick={() => patch(r.id, { status: 'confirmed' }, 'Reservation confirmed')}>{tr("Confirm")}</button>}
                    <button className="sm primary" disabled={!r.table_id} title={r.table_id ? tr("Guests arrived: open the table") : tr("Assign a table first")} onClick={async () => {
                      const t = await run(() => api.post(`/reservations/${r.id}/seat`, {}), tr("Guests seated"));
                      if (t) { load(); onSeated?.(t.id); }
                    }}>{tr("Seat")}</button>
                    <button className="sm" onClick={() => patch(r.id, { status: 'no_show' })}>{tr("No-show")}</button>
                    <button className="sm danger" onClick={() => confirm(tr("Cancel this reservation?")) && patch(r.id, { status: 'cancelled' }, 'Reservation cancelled')}>{tr("Cancel")}</button>
                  </div>}</td>
                </tr>
              );
            })}
            {rows?.length === 0 && <tr><td colSpan={7} className="muted">{tr("No reservations.")}</td></tr>}
          </tbody>
        </table>
      </div>
      {add && (
        <Modal title={tr("New booking (phone / walk-in)")} onClose={() => setAdd(null)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => api.post('/reservations', { ...add, pax: Number(add.pax), special_request: add.special_request || null }), tr("Booking saved"));
            if (r) { setAdd(null); load(); }
          }}>
            <div className="grid2">
              <label className="field">{tr("Name *")}<input value={add.customer_name} maxLength={80} onChange={(e) => setAdd({ ...add, customer_name: e.target.value })} /></label>
              <label className="field">{tr("Phone *")}<input type="tel" value={add.customer_phone} maxLength={20} onChange={(e) => setAdd({ ...add, customer_phone: e.target.value })} /></label>
              <label className="field">{tr("Guests *")}<input type="number" min={1} max={100} value={add.pax} onChange={(e) => setAdd({ ...add, pax: e.target.value })} /></label>
              <label className="field">{tr("Table")}<select value={add.table_id ?? ''} onChange={(e) => setAdd({ ...add, table_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{tr("— assign later —")}</option>{tables.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.seats} {tr(" seats)")}</option>)}</select></label>
              <label className="field">{tr("Date *")}<input type="date" min={todayLocal()} value={add.date} onChange={(e) => setAdd({ ...add, date: e.target.value })} /></label>
              <label className="field">{tr("Arrival time *")}<input type="time" value={add.time} onChange={(e) => setAdd({ ...add, time: e.target.value })} /></label>
            </div>
            <label className="field">{tr("Special request")}<input value={add.special_request} maxLength={500} onChange={(e) => setAdd({ ...add, special_request: e.target.value })} /></label>
            <button className="primary lg" disabled={!add.customer_name || !add.customer_phone || !add.time}>{tr("Save booking")}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

/** Back-office page: reservations for any date range. */
export function ReservationsPage() {
  const tr = useTr();
  const [from, setFrom] = useState(todayLocal());
  const [to, setTo] = useState(todayLocal());
  return (
    <div className="stack">
      <h1>{tr("📅 Reservations")}</h1>
      <div className="row">
        <label className="field">{tr("From")}<input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="field">{tr("To")}<input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>
      <ReservationsPanel from={from} to={to < from ? from : to} />
    </div>
  );
}
