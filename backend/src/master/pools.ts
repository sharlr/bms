import pg from 'pg';
import { config } from '../config.js';
import { decrypt } from '../lib/crypto.js';
import { one } from '../lib/db.js';

const ssl = config.PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined;

export const masterPool = new pg.Pool({
  host: config.PG_HOST,
  port: config.PG_PORT,
  user: config.PG_USER,
  password: config.PG_PASSWORD,
  database: config.PG_MASTER_DB,
  max: 10,
  ssl,
});

export interface Tenant {
  id: number;
  slug: string;
  name: string;
  status: string;
  pool: pg.Pool;
}

interface CacheEntry { tenant: Tenant; loadedAt: number }
const cache = new Map<string, CacheEntry>();   // insertion order = LRU order
const META_TTL_MS = 60_000;

export function tenantPool(dbName: string, user: string, password: string): pg.Pool {
  const p = new pg.Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user,
    password,
    database: dbName,
    max: config.TENANT_POOL_MAX,
    idleTimeoutMillis: 30_000,
    ssl,
  });
  p.on('error', () => undefined); // idle client errors must not crash the process
  return p;
}

/** Resolve a tenant by URL slug. Each tenant has its own DB + its own DB role. */
export async function getTenant(slug: string): Promise<Tenant | null> {
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) return null;
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.loadedAt < META_TTL_MS) {
    cache.delete(slug);
    cache.set(slug, hit);
    return hit.tenant.status === 'active' ? hit.tenant : null;
  }
  const row = await one<{ id: number; slug: string; name: string; status: string; db_name: string; db_user: string; db_password_enc: string }>(
    masterPool,
    'SELECT id, slug, name, status, db_name, db_user, db_password_enc FROM tenants WHERE slug = $1',
    [slug],
  );
  if (!row) {
    if (hit) evict(slug);
    return null;
  }
  const pool = hit?.tenant.pool ?? tenantPool(row.db_name, row.db_user, decrypt(row.db_password_enc));
  const tenant: Tenant = { id: row.id, slug: row.slug, name: row.name, status: row.status, pool };
  cache.delete(slug);
  cache.set(slug, { tenant, loadedAt: Date.now() });
  while (cache.size > config.TENANT_POOLS_CACHED) {
    const oldest = cache.keys().next().value as string;
    evict(oldest);
  }
  return tenant.status === 'active' ? tenant : null;
}

export function evict(slug: string) {
  const e = cache.get(slug);
  cache.delete(slug);
  e?.tenant.pool.end().catch(() => undefined);
}

export async function closeAll() {
  for (const slug of [...cache.keys()]) evict(slug);
  await masterPool.end();
}
