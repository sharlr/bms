import { config } from '../config.js';
import { encrypt, hashSecret, randomToken } from '../lib/crypto.js';
import { ident, one, tx } from '../lib/db.js';
import { conflict, badRequest, notFound } from '../lib/errors.js';
import { seedBranchDefaults, seedCompanyDefaults, seedRoles } from '../services/seed.js';
import fs from 'node:fs/promises';
import { archiveTenant, tenantDir } from './backup.js';
import { migrate } from './migrate.js';
import { evict, masterPool, tenantPool } from './pools.js';

export const RESERVED_SLUGS = new Set([
  'api', 'app', 'admin', 'platform', 'assets', 'static', 'public', 'www', 'mail', 'login', 'logout', 'health',
  'socket-io', 'favicon', 'robots', 'root', 'system', 'postgres', 'template', 'master', 'bms',
]);

export interface ProvisionInput {
  slug: string;
  name: string;
  companyName: string;
  currency: string;
  branchName: string;
  branchCode: string;
  adminUsername: string;
  adminFullName: string;
  adminPassword: string;
  adminPin?: string;
}

const dbNameFor = (slug: string) => `${config.TENANT_DB_PREFIX}${slug.replace(/-/g, '_')}`;

/**
 * Provision a tenant: dedicated PostgreSQL role + dedicated database (owned by that role, PUBLIC revoked),
 * run tenant migrations, seed org hierarchy and the first administrator.
 */
export async function provisionTenant(input: ProvisionInput): Promise<{ id: number; slug: string }> {
  if (RESERVED_SLUGS.has(input.slug)) throw badRequest('This tenant name is reserved');
  const dbName = dbNameFor(input.slug);
  const dbUser = dbName;
  const dbPassword = randomToken(32); // base64url => safe inside a quoted literal

  const existing = await one(masterPool, 'SELECT 1 FROM tenants WHERE slug = $1', [input.slug]);
  if (existing) throw conflict('Tenant already exists');

  const row = await one<{ id: number }>(
    masterPool,
    `INSERT INTO tenants (slug, name, db_name, db_user, db_password_enc, status) VALUES ($1,$2,$3,$4,$5,'provisioning') RETURNING id`,
    [input.slug, input.name, dbName, dbUser, encrypt(dbPassword)],
  );
  const tenantId = row!.id;
  let createdRole = false;
  let createdDb = false;

  try {
    await masterPool.query(
      `CREATE ROLE ${ident(dbUser)} LOGIN PASSWORD '${dbPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 50`,
    );
    createdRole = true;
    // PG16+: the creating role needs SET on the new role to assign database ownership.
    await masterPool.query(`GRANT ${ident(dbUser)} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`);
    await masterPool.query(`CREATE DATABASE ${ident(dbName)} OWNER ${ident(dbUser)} ENCODING 'UTF8' TEMPLATE template0`);
    createdDb = true;

    const pool = tenantPool(dbName, dbUser, dbPassword);
    try {
      // Lock the DB down: only its owner role may connect or use the public schema.
      await pool.query(`REVOKE ALL ON DATABASE ${ident(dbName)} FROM PUBLIC`);
      await pool.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
      await migrate(pool, 'tenant');
      await tx(pool, async (c) => {
        await seedRoles(c);
        const company = await one<{ id: number }>(
          c, `INSERT INTO companies (name, base_currency) VALUES ($1, $2) RETURNING id`, [input.companyName, input.currency],
        );
        await seedCompanyDefaults(c, company!.id);
        const branch = await one<{ id: number }>(
          c, `INSERT INTO branches (company_id, name, code) VALUES ($1,$2,$3) RETURNING id`,
          [company!.id, input.branchName, input.branchCode],
        );
        await seedBranchDefaults(c, branch!.id);
        const role = await one<{ id: number }>(c, `SELECT id FROM roles WHERE name = 'Administrator'`);
        const user = await one<{ id: number }>(
          c,
          `INSERT INTO users (username, full_name, password_hash, pin_hash, role_id, is_tenant_admin)
           VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
          [input.adminUsername.toLowerCase(), input.adminFullName, await hashSecret(input.adminPassword),
            input.adminPin ? await hashSecret(input.adminPin) : null, role!.id],
        );
        await c.query(`INSERT INTO user_access (user_id, company_id) VALUES ($1,$2)`, [user!.id, company!.id]);
      });
    } finally {
      await pool.end();
    }
    await masterPool.query(`REVOKE SET OPTION FOR ${ident(dbUser)} FROM CURRENT_USER`).catch(() => undefined);
    await masterPool.query(`UPDATE tenants SET status = 'active', updated_at = now() WHERE id = $1`, [tenantId]);
    evict(input.slug);
    return { id: tenantId, slug: input.slug };
  } catch (e) {
    // Roll back infrastructure so a retry starts clean.
    if (createdDb) {
      await masterPool.query(`DROP DATABASE IF EXISTS ${ident(dbName)} WITH (FORCE)`).catch(async () => {
        await masterPool.query(`SET ROLE ${ident(dbUser)}`).catch(() => undefined);
        await masterPool.query(`DROP DATABASE IF EXISTS ${ident(dbName)} WITH (FORCE)`).catch(() => undefined);
        await masterPool.query('RESET ROLE').catch(() => undefined);
      });
    }
    if (createdRole) await masterPool.query(`DROP ROLE IF EXISTS ${ident(dbUser)}`).catch(() => undefined);
    await masterPool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
    throw e;
  }
}

/**
 * Permanently delete a tenant: final archive dump (BACKUP_DIR/_deleted/), drop its database and role,
 * remove its backup folder and master rows. Refuses unless the tenant is suspended (or failed provisioning).
 */
export async function deleteTenant(tenantId: number) {
  const t = await one<any>(masterPool, 'SELECT * FROM tenants WHERE id = $1', [tenantId]);
  if (!t) throw notFound('Tenant not found');
  if (t.status !== 'suspended' && t.status !== 'failed') throw conflict('Suspend the tenant before deleting it');
  evict(t.slug);
  // The archive is the last copy of the data: if it cannot be written, nothing is deleted.
  const archive = t.status === 'failed' ? null : await archiveTenant(tenantId);
  const c = await masterPool.connect();
  try {
    // The app role created this role, so it can take SET on it again to drop the database it owns.
    await c.query(`GRANT ${ident(t.db_user)} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`).catch(() => undefined);
    await c.query(`SET ROLE ${ident(t.db_user)}`).catch(() => undefined);
    await c.query(`DROP DATABASE IF EXISTS ${ident(t.db_name)} WITH (FORCE)`);
    await c.query('RESET ROLE');
    await c.query(`DROP ROLE IF EXISTS ${ident(t.db_user)}`);
  } finally {
    await c.query('RESET ROLE').catch(() => undefined);
    c.release();
  }
  await fs.rm(tenantDir(t.slug), { recursive: true, force: true });
  await masterPool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  return { slug: t.slug as string, archive };
}

/** Apply pending tenant migrations to every active tenant (run on deploy / startup). */
export async function migrateAllTenants(log: (msg: string) => void) {
  const { getTenant } = await import('./pools.js');
  const rows = (await masterPool.query(`SELECT slug FROM tenants WHERE status = 'active' ORDER BY id`)).rows;
  let failed = 0;
  for (const { slug } of rows) {
    // One broken tenant must never prevent the platform (and every other tenant) from starting.
    try {
      const t = await getTenant(slug);
      if (!t) continue;
      const applied = await migrate(t.pool, 'tenant');
      if (applied.length) log(`tenant ${slug}: applied ${applied.join(', ')}`);
    } catch (e) {
      failed++;
      log(`tenant ${slug}: MIGRATION FAILED — ${(e as Error).message}`);
    }
  }
  return { total: rows.length, failed };
}
