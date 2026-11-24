import { useT as useTr } from '../i18n';
import { fmt, fmtQty, dt, ORDER_TYPES } from '../util';

/** 80mm receipt layout. Content is rendered by React (escaped) and printed via window.print(). */
export function Receipt({ data }: { data: any }) {
  const tr = useTr();
  const t = data.ticket;
  const b = data.branch;
  return (
    <div className="receipt">
      <div className="center">
        <b>{b.company_name}</b><br />
        {b.legal_name && <>{b.legal_name}<br /></>}
        {b.name}<br />
        {b.address && <>{b.address}<br /></>}
        {b.phone && <>{tr("Tel ")}{b.phone}<br /></>}
        {b.tax_id && <>{tr("Tax ID ")}{b.tax_id}<br /></>}
        {b.receipt_header && <div style={{ whiteSpace: 'pre-wrap' }}>{b.receipt_header}</div>}
      </div>
      <div className="sep" />
      <div>{tr("Ticket: ")}{t.ticket_ref}<br />{dt(t.closed_at ?? t.opened_at)}<br />
        {tr(ORDER_TYPES[t.order_type])}{t.table_name ? tr(" · Table {0}", t.table_name) : ''}{t.pax ? tr(" · {0} pax", t.pax) : ''}<br />
        {tr("Channel: ")}{t.channel_name}{t.waiter_name ? tr(" · Staff: {0}", t.waiter_name) : ''}
        {t.delivery_company_name && <><br />{tr("Delivery: ")}{t.delivery_company_name}</>}
        {t.customer_name && <><br />{tr("Customer: ")}{t.customer_name} {t.customer_phone}</>}
        {t.delivery_address && <><br />{tr("Address: ")}{t.delivery_address}</>}
      </div>
      {data.credit_client && (
        <>
          <div className="sep" />
          <div><b>{tr("CREDIT SALE")}</b><br />{tr("Client: ")}<b>{data.credit_client.name}</b>
            {data.credit_client.phone && <><br />{tr("Tel: ")}{data.credit_client.phone}</>}
            {data.credit_client.address && <><br />{data.credit_client.address}</>}
            {data.credit_client.tax_id && <><br />{tr("Tax ID: ")}{data.credit_client.tax_id}</>}
          </div>
        </>
      )}
      <div className="sep" />
      <table style={{ width: '100%' }}>
        <tbody>
          {t.lines.map((l: any) => (
            <tr key={l.id}>
              <td>{fmtQty(l.qty)} {tr(" x ")}{l.item_name}{l.size_name ? ` (${l.size_name})` : ''}
                {(l.modifiers as any[]).map((m) => <div key={m.id}>&nbsp; + {m.name}</div>)}
              </td>
              <td style={{ textAlign: 'right', verticalAlign: 'top' }}>{fmt(l.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sep" />
      <Row l={tr("Subtotal")} v={fmt(t.subtotal)} />
      {t.discount_amount > 0 && <Row l={tr("Discount")} v={'-' + fmt(t.discount_amount)} />}
      <Row l={tr("Tax {0}%", b.tax_rate) + (b.tax_inclusive ? tr(" (incl.)") : "")} v={fmt(t.tax_amount)} />
      <Row l={<b>{tr("TOTAL ")}{t.currency}</b>} v={<b>{fmt(t.total)}</b>} />
      {t.payments.filter((p: any) => p.kind === 'payment').map((p: any) => (
        <Row key={p.id} l={`${p.method_name}${p.currency_code !== t.currency ? ` ${fmt(p.amount)} ${p.currency_code} @${p.rate}` : ''}`} v={fmt(p.base_amount)} />
      ))}
      {t.change_amount > 0 && <Row l={tr("Change")} v={fmt(t.change_amount)} />}
      {t.refunded_amount > 0 && <Row l={tr("Refunded")} v={'-' + fmt(t.refunded_amount)} />}
      <div className="sep" />
      {b.receipt_footer && <div className="center" style={{ whiteSpace: 'pre-wrap' }}>{b.receipt_footer}</div>}
      {data.credit_client && <><br /><div>{tr("Signature: ____________________")}</div></>}
    </div>
  );
}

const Row = ({ l, v }: { l: React.ReactNode; v: React.ReactNode }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{l}</span><span>{v}</span></div>
);
