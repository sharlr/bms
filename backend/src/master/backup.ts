import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { decrypt } from '../lib/crypto.js';
import { many, one, tx } from '../lib/db.js';
import { notFound } from '../lib/errors.js';
import { migrate } from './migrate.js';
import { getTenant, masterPool } from './pools.js';

export type BackupKind = 'auto' | 'manual' | 'uploaded' | 'pre_restore';
export const DUMP_MAGIC = 'PGDMP'; // first bytes of a pg_dump custom-format archive

export const tenantDir = (slug: string) => path.join(config.BACKUP_DIR, slug);
export const filePath = (slug: string, filename: string) => path.join(tenantDir(slug), path.basename(filename));

async function creds(tenantId: number) {
  const t = await one<any>(masterPool, 'SELECT slug, db_name, db_user, db_password_enc FROM tenants WHERE id = $1', [tenantId]);
  if (!t) throw notFound('Tenant not found');
  return { slug: t.slug as string, db: t.db_name as string, user: t.db_user as string, password: decrypt(t.db_password_enc) };
}

/** Run pg_dump / pg_restore as the tenant's own DB role (it can only see its own database). */
function run(cmd: string, args: string[], password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      env: { ...process.env, PGPASSWORD: password, PGSSLMODE: config.PG_SSL === 'true' ? 'require' : 'prefer' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => reject(new Error(`${cmd} not available: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.trim() || 'exit ' + code}`))));
  });
}
const conn = (c: { user: string; db: string }) => ['-h', config.PG_HOST, '-p', String(config.PG_PORT), '-U', c.user, '-d', c.db];

/** Record a backup file as the tenant's next version number. */
export async function registerVersion(tenantId: number, kind: BackupKind, filename: string, createdBy: string | null, retentionDays: number | null) {
  const { size } = await fs.stat(filePath((await creds(tenantId)).slug, filename));
  return tx(masterPool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`backup:${tenantId}`]);
    return one<any>(c,
      `INSERT INTO backup_versions (tenant_id, version_no, kind, filename, size_bytes, created_by, expires_at)
       VALUES ($1, (SELECT coalesce(max(version_no), 0) + 1 FROM backup_versions WHERE tenant_id = $1), $2, $3, $4, $5,
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END)
       RETURNING *`, [tenantId, kind, filename, size, createdBy, retentionDays]);
  });
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);

export async function createBackup(tenantId: number, kind: BackupKind, createdBy: string | null, retentionDays: number | null) {
  const c = await creds(tenantId);
  await fs.mkdir(tenantDir(c.slug), { recursive: true, mode: 0o700 });
  const filename = `backup_${stamp()}_${kind}.dump`;
  const file = filePath(c.slug, filename);
  try {
    await run('pg_dump', [...conn(c), '-Fc', '-Z', '6', '--no-owner', '--no-privileges', '-f', file], c.password);
  } catch (e) {
    await fs.rm(file, { force: true });
    throw e;
  }
  return registerVersion(tenantId, kind, filename, createdBy, retentionDays);
}

/**
 * Restore a version over the tenant DB. A pre-restore safety backup is taken first; the restore runs in one
 * transaction (all or nothing); then pending migrations are re-applied in case the backup is from an older release.
 */
export async function restoreBackup(tenantId: number, versionId: number, by: string) {
  const v = await one<any>(masterPool, 'SELECT * FROM backup_versions WHERE id = $1 AND tenant_id = $2', [versionId, tenantId]);
  if (!v) throw notFound('Backup not found');
  const c = await creds(tenantId);
  const file = filePath(c.slug, v.filename);
  await fs.access(file).catch(() => { throw notFound('Backup file is missing on the server'); });
  const safety = await createBackup(tenantId, 'pre_restore', by, 30);
  await run('pg_restore', [...conn(c), '--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', file], c.password);
  const t = await getTenant(c.slug);
  if (t) await migrate(t.pool, 'tenant');
  return { restored: v.version_no, safety_version: safety.version_no };
}

export async function deleteVersion(tenantId: number, versionId: number) {
  const v = await one<any>(masterPool, 'DELETE FROM backup_versions WHERE id = $1 AND tenant_id = $2 RETURNING filename', [versionId, tenantId]);
  if (!v) throw notFound('Backup not found');
  const c = await creds(tenantId);
  await fs.rm(filePath(c.slug, v.filename), { force: true });
}

/** Final archive of a tenant DB before it is deleted, kept outside any tenant folder: BACKUP_DIR/_deleted/. */
export async function archiveTenant(tenantId: number) {
  const c = await creds(tenantId);
  const dir = path.join(config.BACKUP_DIR, '_deleted');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${c.slug}_${stamp()}.dump`);
  await run('pg_dump', [...conn(c), '-Fc', '-Z', '6', '--no-owner', '--no-privileges', '-f', file], c.password);
  return file;
}

/** Next occurrence of a daily HH:MM in the schedule's timezone, strictly in the future. */
export const NEXT_RUN_SQL = `(SELECT CASE WHEN x > now() THEN x ELSE x + interval '1 day' END
  FROM (SELECT (((now() AT TIME ZONE $TZ)::date + $TIME::time) AT TIME ZONE $TZ) AS x) s)`;

/** Called every minute: run due schedules (each claimed with SKIP LOCKED), then purge expired versions. */
export async function runScheduler(log: (msg: string, err?: boolean) => void) {
  for (;;) {
    const job = await tx(masterPool, async (c) => {
      const s = await one<any>(c,
        `SELECT s.* FROM backup_schedules s JOIN tenants t ON t.id = s.tenant_id
          WHERE s.enabled AND s.next_run_at <= now() AND t.status = 'active'
          ORDER BY s.next_run_at LIMIT 1 FOR UPDATE OF s SKIP LOCKED`);
      if (!s) return null;
      await c.query(`UPDATE backup_schedules SET last_run_at = now(), next_run_at = ${NEXT_RUN_SQL.replace(/\$TZ/g, '$2').replace(/\$TIME/g, '$3')} WHERE id = $1`,
        [s.id, s.timezone, s.time_of_day]);
      return s;
    });
    if (!job) break;
    try {
      const v = await createBackup(job.tenant_id, 'auto', 'schedule', job.retention_days);
      await masterPool.query('UPDATE backup_schedules SET last_error = NULL WHERE id = $1', [job.id]);
      log(`backup: tenant ${job.tenant_id} version ${v.version_no} created`);
    } catch (e) {
      await masterPool.query('UPDATE backup_schedules SET last_error = $2 WHERE id = $1', [job.id, (e as Error).message.slice(0, 500)]);
      log(`backup: tenant ${job.tenant_id} FAILED — ${(e as Error).message}`, true);
    }
  }
  const expired = await many<any>(masterPool, 'SELECT id, tenant_id FROM backup_versions WHERE expires_at < now()');
  for (const v of expired) await deleteVersion(v.tenant_id, v.id).catch((e) => log(`backup purge failed: ${(e as Error).message}`, true));
}
