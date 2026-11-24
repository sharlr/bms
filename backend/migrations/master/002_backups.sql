-- Per-tenant backups. Kept in the master DB so restoring a tenant DB never erases its own backup list.
CREATE TABLE backup_schedules (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  time_of_day    time NOT NULL,
  timezone       text NOT NULL,
  retention_days int NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  enabled        boolean NOT NULL DEFAULT true,
  next_run_at    timestamptz NOT NULL,
  last_run_at    timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON backup_schedules (next_run_at) WHERE enabled;

CREATE TABLE backup_versions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version_no int NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('auto','manual','uploaded','pre_restore')),
  filename   text NOT NULL,
  size_bytes bigint NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,            -- NULL = keep until deleted
  UNIQUE (tenant_id, version_no)
);
CREATE INDEX ON backup_versions (expires_at) WHERE expires_at IS NOT NULL;
