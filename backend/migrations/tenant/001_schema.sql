-- =====================================================================
-- Tenant database schema. Every tenant gets its OWN database with this
-- schema; nothing here is shared across tenants.
-- Hierarchy inside a tenant: companies -> branches. All operational data
-- carries company_id and/or branch_id for strict segregation.
-- =====================================================================

-- ---------- Reference ----------
CREATE TABLE currencies (
  code     char(3) PRIMARY KEY,
  name     text NOT NULL,
  symbol   text NOT NULL DEFAULT '',
  decimals smallint NOT NULL DEFAULT 2
);

-- ---------- Organisation ----------
CREATE TABLE companies (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  legal_name    text,
  tax_id        text,
  address       text,
  phone         text,
  email         text,
  base_currency char(3) NOT NULL REFERENCES currencies(code),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id             bigint NOT NULL REFERENCES companies(id),
  name                   text NOT NULL,
  code                   text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,10}$'),
  address                text,
  phone                  text,
  timezone               text NOT NULL DEFAULT 'UTC',
  receipt_header         text,
  receipt_footer         text,
  tax_rate               numeric(6,3) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate < 100),
  tax_inclusive          boolean NOT NULL DEFAULT true,
  online_ordering        boolean NOT NULL DEFAULT false,
  auto_accept_self_orders boolean NOT NULL DEFAULT false,
  delivery_batch_minutes int NOT NULL DEFAULT 15 CHECK (delivery_batch_minutes BETWEEN 0 AND 240),
  active                 boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX ON branches (company_id);

CREATE TABLE branch_sequences (
  branch_id  bigint NOT NULL REFERENCES branches(id),
  seq_name   text NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, seq_name)
);

CREATE TABLE registers (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id  bigint NOT NULL REFERENCES branches(id),
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true
);
CREATE INDEX ON registers (branch_id);

-- Receipt channels: every ticket is linked to exactly one channel.
CREATE TABLE receipt_channels (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   bigint NOT NULL REFERENCES companies(id),
  branch_id    bigint REFERENCES branches(id),           -- NULL = all branches of company
  code         text NOT NULL,
  name         text NOT NULL,
  channel_type text NOT NULL CHECK (channel_type IN ('pos','waiter','takeaway','kiosk','qr','online','delivery')),
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code)
);

-- ---------- Users / auth ----------
CREATE TABLE roles (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  permissions text[] NOT NULL DEFAULT '{}',
  is_system   boolean NOT NULL DEFAULT false
);

CREATE TABLE users (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username        text NOT NULL CHECK (username ~ '^[a-z0-9._-]{3,40}$'),
  full_name       text NOT NULL,
  password_hash   text,                 -- argon2id, for back-office login
  pin_hash        text,                 -- argon2id, 4-digit PIN for terminals
  role_id         bigint NOT NULL REFERENCES roles(id),
  is_tenant_admin boolean NOT NULL DEFAULT false,
  color           text NOT NULL DEFAULT '#2563eb',
  active          boolean NOT NULL DEFAULT true,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));

-- Which companies / branches a user may operate in. branch_id NULL = every branch of the company.
CREATE TABLE user_access (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id bigint NOT NULL REFERENCES companies(id),
  branch_id  bigint REFERENCES branches(id)
);
CREATE UNIQUE INDEX user_access_uq ON user_access (user_id, company_id, coalesce(branch_id, 0));

-- Registered terminals (POS, waiter tablet, takeaway, kiosk, KDS, print agent).
CREATE TABLE devices (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id    bigint NOT NULL REFERENCES branches(id),
  register_id  bigint REFERENCES registers(id),
  name         text NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('pos','waiter','takeaway','kiosk','kds','print_agent')),
  token_hash   text NOT NULL UNIQUE,
  created_by   bigint REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE sessions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    bigint REFERENCES devices(id),
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX ON sessions (user_id);

-- ---------- Floor plan ----------
CREATE TABLE floors (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id bigint NOT NULL REFERENCES branches(id),
  name      text NOT NULL,
  sort      int NOT NULL DEFAULT 0,
  active    boolean NOT NULL DEFAULT true
);

CREATE TABLE dining_tables (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id bigint NOT NULL REFERENCES branches(id),
  floor_id  bigint NOT NULL REFERENCES floors(id),
  name      text NOT NULL,
  seats     int NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 100),
  shape     text NOT NULL DEFAULT 'square' CHECK (shape IN ('square','round','rect')),
  pos_x     int NOT NULL DEFAULT 20,
  pos_y     int NOT NULL DEFAULT 20,
  width     int NOT NULL DEFAULT 90,
  height    int NOT NULL DEFAULT 90,
  qr_token  text NOT NULL UNIQUE,
  active    boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, name)
);

-- ---------- Printers ----------
CREATE TABLE printers (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id   bigint NOT NULL REFERENCES branches(id),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('kitchen','beverage','receipt')),
  connection  text NOT NULL DEFAULT '',     -- e.g. tcp://192.168.1.50:9100 (reached by the in-store print agent)
  chars_per_line int NOT NULL DEFAULT 42,
  active      boolean NOT NULL DEFAULT true
);

-- ---------- Menu ----------
CREATE TABLE menu_categories (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  parent_id  bigint REFERENCES menu_categories(id),
  name       text NOT NULL,
  color      text NOT NULL DEFAULT '#64748b',
  kot_route  text NOT NULL DEFAULT 'kitchen' CHECK (kot_route IN ('kitchen','beverage','none')),
  sort       int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE menu_items (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES companies(id),
  category_id     bigint NOT NULL REFERENCES menu_categories(id),
  name            text NOT NULL,
  description     text,
  sku             text,
  image_url       text,
  kot_route       text CHECK (kot_route IN ('kitchen','beverage','none')),   -- NULL = inherit category
  tracks_stock    boolean NOT NULL DEFAULT false,                           -- per-item stock impact toggle
  allergens       text[] NOT NULL DEFAULT '{}',
  available_online boolean NOT NULL DEFAULT true,
  sort            int NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true
);
CREATE INDEX ON menu_items (company_id, category_id);

CREATE TABLE item_sizes (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name    text NOT NULL,
  sort    int NOT NULL DEFAULT 0,
  active  boolean NOT NULL DEFAULT true,
  UNIQUE (item_id, name)
);

-- Price matrix: item x size x branch. branch_id NULL = company default price.
CREATE TABLE item_prices (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id   bigint NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  size_id   bigint REFERENCES item_sizes(id) ON DELETE CASCADE,
  branch_id bigint REFERENCES branches(id),
  price     numeric(14,2) NOT NULL CHECK (price >= 0)
);
CREATE UNIQUE INDEX item_prices_uq ON item_prices (item_id, coalesce(size_id, 0), coalesce(branch_id, 0));

CREATE TABLE modifier_groups (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  name       text NOT NULL,
  min_select int NOT NULL DEFAULT 0,
  max_select int NOT NULL DEFAULT 10,
  active     boolean NOT NULL DEFAULT true
);
CREATE TABLE modifiers (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    bigint NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name        text NOT NULL,
  price_delta numeric(14,2) NOT NULL DEFAULT 0,
  sort        int NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true
);
CREATE TABLE item_modifier_groups (
  item_id  bigint NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id bigint NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, group_id)
);

-- ---------- Clients, coupons, payment methods, FX ----------
CREATE TABLE clients (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     bigint NOT NULL REFERENCES companies(id),
  name           text NOT NULL,
  phone          text,
  email          text,
  address        text,
  tax_id         text,
  credit_allowed boolean NOT NULL DEFAULT false,
  credit_limit   numeric(14,2) NOT NULL DEFAULT 0,   -- 0 = unlimited
  balance        numeric(14,2) NOT NULL DEFAULT 0,   -- outstanding credit
  notes          text,
  active         boolean NOT NULL DEFAULT true
);
CREATE INDEX ON clients (company_id, phone);

CREATE TABLE coupons (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES companies(id),
  code          text NOT NULL,
  discount_type text NOT NULL CHECK (discount_type IN ('percent','fixed')),
  value         numeric(14,2) NOT NULL CHECK (value > 0),
  min_order     numeric(14,2) NOT NULL DEFAULT 0,
  valid_from    timestamptz,
  valid_to      timestamptz,
  max_uses      int,
  used_count    int NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX coupons_code_uq ON coupons (company_id, upper(code));

CREATE TABLE payment_methods (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   bigint NOT NULL REFERENCES companies(id),
  name         text NOT NULL,
  method_type  text NOT NULL CHECK (method_type IN ('cash','card','credit','mobile_money','voucher','other')),
  sort         int NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true
);

-- Manual exchange rates: 1 unit of currency_code = rate units of company base currency.
CREATE TABLE exchange_rates (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     bigint NOT NULL REFERENCES companies(id),
  branch_id      bigint REFERENCES branches(id),    -- NULL = company-wide
  currency_code  char(3) NOT NULL REFERENCES currencies(code),
  rate           numeric(18,8) NOT NULL CHECK (rate > 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by     bigint REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON exchange_rates (company_id, currency_code, effective_from DESC);

-- ---------- Delivery partners & commissions ----------
CREATE TABLE delivery_companies (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       bigint NOT NULL REFERENCES companies(id),
  name             text NOT NULL,
  phone            text,
  email            text,
  available_online boolean NOT NULL DEFAULT true,
  sort             int NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true
);

CREATE TABLE delivery_zones (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE delivery_commission_rules (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_company_id bigint NOT NULL REFERENCES delivery_companies(id) ON DELETE CASCADE,
  branch_id           bigint REFERENCES branches(id),                 -- NULL = all branches
  basis               text NOT NULL CHECK (basis IN ('delivery','item','zone','client')),
  commission_type     text NOT NULL CHECK (commission_type IN ('fixed','percent')),
  value               numeric(14,4) NOT NULL CHECK (value >= 0),
  zone_id             bigint REFERENCES delivery_zones(id),
  client_id           bigint REFERENCES clients(id),
  menu_item_id        bigint REFERENCES menu_items(id),              -- item basis: NULL = every item
  priority            int NOT NULL DEFAULT 0,
  active              boolean NOT NULL DEFAULT true,
  CHECK (basis <> 'zone'   OR zone_id IS NOT NULL),
  CHECK (basis <> 'client' OR client_id IS NOT NULL),
  CHECK (commission_type <> 'percent' OR value <= 100)
);

-- Groups deliveries to the same client + same address within a time window.
CREATE TABLE delivery_batches (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id           bigint NOT NULL REFERENCES branches(id),
  delivery_company_id bigint NOT NULL REFERENCES delivery_companies(id),
  client_key          text NOT NULL,
  address_key         text NOT NULL,
  first_order_at      timestamptz NOT NULL DEFAULT now(),
  ticket_count        int NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dispatched'))
);
CREATE INDEX ON delivery_batches (branch_id, delivery_company_id, client_key, address_key, first_order_at DESC);

-- ---------- Tickets (sales) ----------
CREATE TABLE pos_sessions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id     bigint NOT NULL REFERENCES branches(id),
  register_id   bigint NOT NULL REFERENCES registers(id),
  opened_by     bigint NOT NULL REFERENCES users(id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  opening_float numeric(14,2) NOT NULL DEFAULT 0,
  closed_by     bigint REFERENCES users(id),
  closed_at     timestamptz,
  counted_cash  numeric(14,2),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);
CREATE UNIQUE INDEX pos_sessions_one_open ON pos_sessions (register_id) WHERE status = 'open';

CREATE TABLE tickets (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          bigint NOT NULL REFERENCES companies(id),
  branch_id           bigint NOT NULL REFERENCES branches(id),
  receipt_channel_id  bigint NOT NULL REFERENCES receipt_channels(id),
  pos_session_id      bigint REFERENCES pos_sessions(id),
  ticket_no           bigint NOT NULL,
  ticket_ref          text NOT NULL UNIQUE,
  source              text NOT NULL CHECK (source IN ('pos','waiter','takeaway','kiosk','qr','online')),
  order_type          text NOT NULL CHECK (order_type IN ('dine_in','takeaway','delivery')),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('pending','open','paid','cancelled')),
  refund_status       text NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none','partial','full')),
  table_id            bigint REFERENCES dining_tables(id),
  pax                 int NOT NULL DEFAULT 1 CHECK (pax BETWEEN 0 AND 500),
  guest_status        text NOT NULL DEFAULT 'seated' CHECK (guest_status IN ('seated','ordered','served','bill_requested')),
  client_id           bigint REFERENCES clients(id),
  customer_name       text,
  customer_phone      text,
  delivery_company_id bigint REFERENCES delivery_companies(id),
  delivery_zone_id    bigint REFERENCES delivery_zones(id),
  delivery_address    text,
  delivery_batch_id   bigint REFERENCES delivery_batches(id),
  subtotal            numeric(14,2) NOT NULL DEFAULT 0,
  discount_type       text CHECK (discount_type IN ('percent','fixed')),
  discount_value      numeric(14,2) NOT NULL DEFAULT 0,
  discount_amount     numeric(14,2) NOT NULL DEFAULT 0,
  coupon_id           bigint REFERENCES coupons(id),
  tax_amount          numeric(14,2) NOT NULL DEFAULT 0,
  total               numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount         numeric(14,2) NOT NULL DEFAULT 0,
  change_amount       numeric(14,2) NOT NULL DEFAULT 0,
  refunded_amount     numeric(14,2) NOT NULL DEFAULT 0,
  currency            char(3) NOT NULL REFERENCES currencies(code),
  notes               text,
  public_token        text UNIQUE,
  parent_ticket_id    bigint REFERENCES tickets(id),
  waiter_id           bigint REFERENCES users(id),
  created_by          bigint REFERENCES users(id),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        bigint REFERENCES users(id),
  cancel_reason       text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, ticket_no)
);
CREATE INDEX ON tickets (branch_id, status);
CREATE INDEX ON tickets (branch_id, closed_at);
CREATE INDEX ON tickets (company_id, closed_at);
CREATE INDEX ON tickets (pos_session_id);
CREATE INDEX ON tickets (table_id) WHERE status IN ('pending','open');

CREATE TABLE ticket_lines (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id       bigint NOT NULL REFERENCES tickets(id),
  menu_item_id    bigint NOT NULL REFERENCES menu_items(id),
  size_id         bigint REFERENCES item_sizes(id),
  item_name       text NOT NULL,
  size_name       text,
  qty             numeric(10,3) NOT NULL CHECK (qty > 0),
  unit_price      numeric(14,2) NOT NULL,
  modifiers       jsonb NOT NULL DEFAULT '[]',
  modifiers_total numeric(14,2) NOT NULL DEFAULT 0,
  notes           text,
  allergy_note    text,
  seat_no         int,
  line_total      numeric(14,2) NOT NULL,
  kot_route       text NOT NULL CHECK (kot_route IN ('kitchen','beverage','none')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  kitchen_status  text NOT NULL DEFAULT 'new' CHECK (kitchen_status IN ('new','sent','accepted','preparing','ready','served')),
  sent_at         timestamptz,
  stock_deducted  boolean NOT NULL DEFAULT false,
  refunded_qty    numeric(10,3) NOT NULL DEFAULT 0,
  void_reason     text,
  voided_by       bigint REFERENCES users(id),
  voided_at       timestamptz,
  from_customer   boolean NOT NULL DEFAULT false,
  created_by      bigint REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ticket_lines (ticket_id);

-- Every void / cancel / table clear is logged here and shown on X & Z reports.
CREATE TABLE cancellations (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES companies(id),
  branch_id       bigint NOT NULL REFERENCES branches(id),
  pos_session_id  bigint REFERENCES pos_sessions(id),
  ticket_id       bigint NOT NULL REFERENCES tickets(id),
  ticket_line_id  bigint REFERENCES ticket_lines(id),
  kind            text NOT NULL CHECK (kind IN ('line','ticket','table_clear')),
  item_name       text,
  qty             numeric(10,3),
  amount          numeric(14,2) NOT NULL DEFAULT 0,
  reason          text NOT NULL,
  user_id         bigint NOT NULL REFERENCES users(id),
  approved_by     bigint REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cancellations (branch_id, created_at);
CREATE INDEX ON cancellations (pos_session_id);

CREATE TABLE payments (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id         bigint NOT NULL REFERENCES tickets(id),
  company_id        bigint NOT NULL REFERENCES companies(id),
  branch_id         bigint NOT NULL REFERENCES branches(id),
  pos_session_id    bigint REFERENCES pos_sessions(id),
  payment_method_id bigint NOT NULL REFERENCES payment_methods(id),
  method_type       text NOT NULL,
  currency_code     char(3) NOT NULL REFERENCES currencies(code),
  amount            numeric(14,2) NOT NULL,          -- in currency_code (negative for refunds)
  rate              numeric(18,8) NOT NULL,          -- base units per 1 currency unit
  base_amount       numeric(14,2) NOT NULL,          -- in company base currency
  kind              text NOT NULL CHECK (kind IN ('payment','refund')),
  client_id         bigint REFERENCES clients(id),
  reference         text,
  created_by        bigint REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payments (ticket_id);
CREATE INDEX ON payments (pos_session_id);
CREATE INDEX ON payments (branch_id, created_at);

CREATE TABLE refunds (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id  bigint NOT NULL REFERENCES tickets(id),
  branch_id  bigint NOT NULL REFERENCES branches(id),
  pos_session_id bigint REFERENCES pos_sessions(id),
  amount     numeric(14,2) NOT NULL,
  reason     text NOT NULL,
  lines      jsonb NOT NULL DEFAULT '[]',
  restock    boolean NOT NULL DEFAULT false,
  created_by bigint REFERENCES users(id),
  approved_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE delivery_commissions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id           bigint NOT NULL REFERENCES tickets(id),
  branch_id           bigint NOT NULL REFERENCES branches(id),
  delivery_company_id bigint NOT NULL REFERENCES delivery_companies(id),
  batch_id            bigint REFERENCES delivery_batches(id),
  rule_id             bigint REFERENCES delivery_commission_rules(id),
  basis               text NOT NULL,
  commission_type     text NOT NULL,
  rule_value          numeric(14,4) NOT NULL,
  base_amount         numeric(14,2) NOT NULL,
  amount              numeric(14,2) NOT NULL,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON delivery_commissions (ticket_id);
CREATE INDEX ON delivery_commissions (branch_id, created_at);

-- ---------- Kitchen ----------
CREATE TABLE kot_orders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   bigint NOT NULL REFERENCES tickets(id),
  branch_id   bigint NOT NULL REFERENCES branches(id),
  route       text NOT NULL CHECK (route IN ('kitchen','beverage')),
  printer_id  bigint REFERENCES printers(id),
  kot_no      bigint NOT NULL,
  lines       jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','preparing','ready','served','cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON kot_orders (branch_id, status, created_at);

CREATE TABLE print_jobs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id  bigint NOT NULL REFERENCES branches(id),
  printer_id bigint REFERENCES printers(id),
  kind       text NOT NULL CHECK (kind IN ('kot','receipt','report')),
  ref_id     bigint,
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','printed','failed','no_printer')),
  attempts   int NOT NULL DEFAULT 0,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  printed_at timestamptz
);
CREATE INDEX ON print_jobs (branch_id, status);

-- ---------- Inventory ----------
CREATE TABLE ingredients (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES companies(id),
  name          text NOT NULL,
  unit          text NOT NULL DEFAULT 'unit',
  cost_per_unit numeric(14,4) NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, name)
);

CREATE TABLE branch_stock (
  branch_id     bigint NOT NULL REFERENCES branches(id),
  ingredient_id bigint NOT NULL REFERENCES ingredients(id),
  qty           numeric(14,3) NOT NULL DEFAULT 0,
  min_qty       numeric(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, ingredient_id)
);

CREATE TABLE recipes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  menu_item_id bigint NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  size_id      bigint REFERENCES item_sizes(id) ON DELETE CASCADE,  -- NULL = applies to all sizes
  notes        text
);
CREATE UNIQUE INDEX recipes_uq ON recipes (menu_item_id, coalesce(size_id, 0));

CREATE TABLE recipe_lines (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_id     bigint NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id bigint NOT NULL REFERENCES ingredients(id),
  qty           numeric(14,4) NOT NULL CHECK (qty > 0),
  UNIQUE (recipe_id, ingredient_id)
);

CREATE TABLE waste_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES companies(id),
  branch_id     bigint NOT NULL REFERENCES branches(id),
  ingredient_id bigint REFERENCES ingredients(id),
  menu_item_id  bigint REFERENCES menu_items(id),
  size_id       bigint REFERENCES item_sizes(id),
  qty           numeric(14,3) NOT NULL CHECK (qty > 0),
  reason        text NOT NULL CHECK (reason IN ('spilled','damaged','spoiled','expired','overcooked','other')),
  cost_amount   numeric(14,2) NOT NULL DEFAULT 0,
  deducts_stock boolean NOT NULL DEFAULT true,
  notes         text,
  user_id       bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ingredient_id IS NOT NULL OR menu_item_id IS NOT NULL)
);
CREATE INDEX ON waste_logs (branch_id, created_at);

-- Ticket-referenced stock ledger: every sale movement stores the POS ticket reference.
CREATE TABLE stock_movements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id      bigint NOT NULL REFERENCES branches(id),
  ingredient_id  bigint NOT NULL REFERENCES ingredients(id),
  qty_change     numeric(14,3) NOT NULL,
  balance_after  numeric(14,3) NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('sale','sale_reversal','refund_return','purchase','adjustment','waste','opening')),
  ticket_id      bigint REFERENCES tickets(id),
  ticket_line_id bigint REFERENCES ticket_lines(id),
  ticket_ref     text,
  waste_id       bigint REFERENCES waste_logs(id),
  unit_cost      numeric(14,4),
  note           text,
  user_id        bigint REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (kind NOT IN ('sale','sale_reversal') OR ticket_ref IS NOT NULL)
);
CREATE INDEX ON stock_movements (branch_id, ingredient_id, created_at);
CREATE INDEX ON stock_movements (ticket_id);
CREATE INDEX ON stock_movements (ticket_ref);

-- ---------- Counter expenses ----------
CREATE TABLE expense_categories (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL REFERENCES companies(id),
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, name)
);

CREATE TABLE counter_expenses (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     bigint NOT NULL REFERENCES companies(id),
  branch_id      bigint NOT NULL REFERENCES branches(id),
  pos_session_id bigint REFERENCES pos_sessions(id),
  category_id    bigint NOT NULL REFERENCES expense_categories(id),
  description    text NOT NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  currency_code  char(3) NOT NULL REFERENCES currencies(code),
  rate           numeric(18,8) NOT NULL,
  base_amount    numeric(14,2) NOT NULL,
  paid_from_cash boolean NOT NULL DEFAULT true,
  user_id        bigint NOT NULL REFERENCES users(id),
  voided_at      timestamptz,
  voided_by      bigint REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON counter_expenses (branch_id, created_at);

-- ---------- Reports & audit ----------
CREATE TABLE shift_reports (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     bigint NOT NULL REFERENCES companies(id),
  branch_id      bigint NOT NULL REFERENCES branches(id),
  pos_session_id bigint NOT NULL REFERENCES pos_sessions(id),
  report_type    char(1) NOT NULL CHECK (report_type IN ('X','Z')),
  report_no      bigint NOT NULL,
  data           jsonb NOT NULL,
  created_by     bigint NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, report_type, report_no)
);

CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint REFERENCES users(id),
  action     text NOT NULL,
  entity     text,
  entity_id  bigint,
  data       jsonb NOT NULL DEFAULT '{}',
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (created_at);
