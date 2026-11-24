-- Kitchen staff take charge of individual order lines.
ALTER TABLE ticket_lines
  ADD COLUMN kitchen_by bigint REFERENCES users(id),
  ADD COLUMN kitchen_at timestamptz;

-- Customer online payments (QR / online orders), one row per checkout attempt.
CREATE TABLE online_payments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id    bigint NOT NULL REFERENCES tickets(id),
  provider     text NOT NULL,
  provider_ref text,
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  currency     char(3) NOT NULL REFERENCES currencies(code),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
  raw          jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz
);
CREATE INDEX ON online_payments (ticket_id);
CREATE UNIQUE INDEX online_payments_ref_uq ON online_payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
