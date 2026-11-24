-- Master (routing) database: one row per tenant -> one dedicated database + role.
-- No tenant business data is ever stored here.

CREATE TABLE tenants (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,30}[a-z0-9]$'),
  name            text NOT NULL,
  db_name         text NOT NULL UNIQUE,
  db_user         text NOT NULL UNIQUE,
  db_password_enc text NOT NULL,          -- AES-256-GCM, key = SECRETS_KEY env
  status          text NOT NULL DEFAULT 'provisioning'
                  CHECK (status IN ('provisioning','active','suspended','failed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_admins (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admins_email_uq ON platform_admins (lower(email));

CREATE TABLE platform_sessions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,
  admin_id    bigint NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);

CREATE TABLE platform_audit (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id   bigint REFERENCES platform_admins(id),
  action     text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
