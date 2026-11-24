import fs from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { config } from '../config.js';

/** Apply pending *.sql files from migrations/<kind> in order, each in its own transaction. */
export async function migrate(pool: pg.Pool, kind: 'master' | 'tenant'): Promise<string[]> {
  const dir = path.join(config.MIGRATIONS_DIR, kind);
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query(`SELECT pg_advisory_lock(hashtext('bms_migrations'))`);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await fs.readFile(path.join(dir, f), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${kind}/${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query(`SELECT pg_advisory_unlock(hashtext('bms_migrations'))`).catch(() => undefined);
    c.release();
  }
  return applied;
}
