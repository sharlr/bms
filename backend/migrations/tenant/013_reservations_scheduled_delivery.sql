-- Branch location (centre of the delivery map).
ALTER TABLE branches ADD COLUMN lat numeric(9,6), ADD COLUMN lng numeric(9,6);

-- Orders booked in advance (delivery / pickup time) and the delivery pin chosen on the map.
ALTER TABLE tickets
  ADD COLUMN scheduled_for timestamptz,
  ADD COLUMN delivery_lat numeric(9,6) CHECK (delivery_lat BETWEEN -90 AND 90),
  ADD COLUMN delivery_lng numeric(9,6) CHECK (delivery_lng BETWEEN -180 AND 180);
CREATE INDEX ON tickets (branch_id, scheduled_for) WHERE scheduled_for IS NOT NULL;

-- Date a payment counts as a receipt in date-range reports. Prepayments of advance orders count on the
-- delivery date (set when the order is handed over and closed), not on the day the customer paid.
ALTER TABLE payments ADD COLUMN value_at timestamptz;

CREATE TABLE reservations (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES companies(id),
  branch_id       bigint NOT NULL REFERENCES branches(id),
  table_id        bigint REFERENCES dining_tables(id),
  customer_name   text NOT NULL,
  customer_phone  text NOT NULL,
  pax             int NOT NULL CHECK (pax BETWEEN 1 AND 500),
  reserved_for    timestamptz NOT NULL,           -- date + expected time of arrival
  special_request text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','seated','cancelled','no_show')),
  source          text NOT NULL DEFAULT 'online' CHECK (source IN ('online','staff')),
  public_token    text NOT NULL UNIQUE,
  ticket_id       bigint REFERENCES tickets(id),
  created_by      bigint REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON reservations (branch_id, reserved_for);
