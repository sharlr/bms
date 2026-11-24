import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one } from '../lib/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { idParam, parse } from '../lib/validate.js';
import {
  createBackup, deleteVersion, DUMP_MAGIC, filePath, NEXT_RUN_SQL, registerVersion, restoreBackup, tenantDir,
} from '../master/backup.js';
import { masterPool } from '../master/pools.js';
import { audit, requirePerm } from '../plugins/context.js';

const MAX_UPLOAD = 2 * 1024 ** 3; // 2 GB
const nextRun = NEXT_RUN_SQL.replace(/\$TZ/g, '$1').replace(/\$TIME/g, '$2');
const tz = z.string().max(60).refine((v) => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Invalid timezone');
const scheduleSchema = z.strictObject({
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM'), timezone: tz,
  retention_days: z.coerce.number().int().min(1).max(3650), enabled: z.boolean(),
});

const tenantAdmin = (req: FastifyRequest) => {
  const a = requirePerm(req, 'backup.manage');
  if (!a.user.is_tenant_admin) throw forbidden('Only tenant administrators can restore, upload or delete backups');
  return a;
};

export function backupRoutes(app: FastifyInstance) {
  // Raw file upload (restore from a downloaded backup) is streamed, never buffered in memory.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.get('/backups', async (req) => {
    requirePerm(req, 'backup.manage');
    const versions = await many(masterPool,
      `SELECT id, version_no, kind, filename, size_bytes, created_by, created_at, expires_at FROM backup_versions
        WHERE tenant_id = $1 ORDER BY version_no DESC`, [req.tenant.id]);
    const schedules = await many(masterPool,
      `SELECT id, to_char(time_of_day, 'HH24:MI') AS time, timezone, retention_days, enabled, next_run_at, last_run_at, last_error
         FROM backup_schedules WHERE tenant_id = $1 ORDER BY id`, [req.tenant.id]);
    return { versions, schedules };
  });

  app.post('/backups', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = requirePerm(req, 'backup.manage');
    const v = await createBackup(req.tenant.id, 'manual', a.user.full_name, null);
    await audit(req, 'backup.create', 'backup_versions', v.id);
    reply.code(201);
    return v;
  });

  app.get('/backups/:id/download', async (req, reply) => {
    requirePerm(req, 'backup.manage');
    const { id } = parse(idParam, req.params);
    const v = await one<any>(masterPool, 'SELECT filename FROM backup_versions WHERE id = $1 AND tenant_id = $2', [id, req.tenant.id]);
    if (!v) throw notFound();
    const file = filePath(req.tenant.slug, v.filename);
    const st = await fs.stat(file).catch(() => null);
    if (!st) throw notFound('Backup file is missing on the server');
    await audit(req, 'backup.download', 'backup_versions', id);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', st.size);
    reply.header('Content-Disposition', `attachment; filename="${req.tenant.slug}_${v.filename}"`);
    return reply.send(createReadStream(file));
  });

  app.delete('/backups/:id', async (req) => {
    tenantAdmin(req);
    const { id } = parse(idParam, req.params);
    await deleteVersion(req.tenant.id, id);
    await audit(req, 'backup.delete', 'backup_versions', id);
    return { ok: true };
  });

  app.post('/backups/:id/restore', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const a = tenantAdmin(req);
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ confirm: z.string() }), req.body);
    if (b.confirm !== req.tenant.slug) throw badRequest(`Type "${req.tenant.slug}" to confirm the restore`);
    const r = await restoreBackup(req.tenant.id, id, a.user.full_name);
    // Audit after the restore so the entry survives it.
    await audit(req, 'backup.restore', 'backup_versions', id, r).catch(() => undefined);
    return r;
  });

  app.post('/backups/upload', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = tenantAdmin(req);
    if (!req.headers['content-type']?.startsWith('application/octet-stream')) throw badRequest('Send the backup file as application/octet-stream');
    await fs.mkdir(tenantDir(req.tenant.slug), { recursive: true, mode: 0o700 });
    const name = `backup_${new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)}_uploaded.dump`;
    const file = filePath(req.tenant.slug, name);
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      await pipeline(req.body as Readable, async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          size += chunk.length;
          if (size > MAX_UPLOAD) throw badRequest('Backup file is too large (max 2 GB)');
          if (head.length < DUMP_MAGIC.length) head = Buffer.concat([head, chunk]).subarray(0, DUMP_MAGIC.length);
          yield chunk;
        }
      }, createWriteStream(file, { mode: 0o600 }));
      if (head.toString('latin1') !== DUMP_MAGIC) throw badRequest('This is not a BMS backup file');
    } catch (e) {
      await fs.rm(file, { force: true });
      throw e;
    }
    const v = await registerVersion(req.tenant.id, 'uploaded', name, a.user.full_name, null);
    await audit(req, 'backup.upload', 'backup_versions', v.id, { size });
    reply.code(201);
    return v;
  });

  app.post('/backups/schedules', async (req, reply) => {
    requirePerm(req, 'backup.manage');
    const b = parse(scheduleSchema, req.body);
    const row = await one(masterPool,
      `INSERT INTO backup_schedules (tenant_id, time_of_day, timezone, retention_days, enabled, next_run_at)
       VALUES ($3, $2::time, $1, $4, $5, ${nextRun}) RETURNING id`, [b.timezone, b.time, req.tenant.id, b.retention_days, b.enabled]);
    reply.code(201);
    return row;
  });

  app.patch('/backups/schedules/:id', async (req) => {
    requirePerm(req, 'backup.manage');
    const { id } = parse(idParam, req.params);
    const cur = await one<any>(masterPool,
      `SELECT to_char(time_of_day, 'HH24:MI') AS time, timezone, retention_days, enabled FROM backup_schedules WHERE id = $1 AND tenant_id = $2`, [id, req.tenant.id]);
    if (!cur) throw notFound();
    const b = { ...cur, ...parse(scheduleSchema.partial(), req.body) };
    await masterPool.query(
      `UPDATE backup_schedules SET time_of_day = $2::time, timezone = $1, retention_days = $4, enabled = $5, next_run_at = ${nextRun}
        WHERE id = $3`, [b.timezone, b.time, id, b.retention_days, b.enabled]);
    return { ok: true };
  });

  app.delete('/backups/schedules/:id', async (req) => {
    requirePerm(req, 'backup.manage');
    const { id } = parse(idParam, req.params);
    const r = await masterPool.query('DELETE FROM backup_schedules WHERE id = $1 AND tenant_id = $2', [id, req.tenant.id]);
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });
}
