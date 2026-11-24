import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Public origin, e.g. https://bms.nexusrajan.com — used for CORS, origin checks, QR links.
  PUBLIC_ORIGIN: z.string().url(),
  PG_HOST: z.string().default('postgres'),
  PG_PORT: z.coerce.number().int().default(5432),
  // App role: needs CREATEDB + CREATEROLE (NOT superuser) to provision tenant databases.
  PG_USER: z.string().min(1),
  PG_PASSWORD: z.string().min(1),
  PG_MASTER_DB: z.string().default('bms_master'),
  PG_SSL: z.enum(['true', 'false']).default('false'),
  TENANT_DB_PREFIX: z.string().regex(/^[a-z_]{1,10}$/).default('bms_t_'),
  TENANT_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  TENANT_POOLS_CACHED: z.coerce.number().int().min(1).default(200),
  // 32-byte hex key used to encrypt tenant DB passwords at rest.
  SECRETS_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'SECRETS_KEY must be 64 hex chars (openssl rand -hex 32)'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  // Customer online payments. 'none' = pay at the restaurant only. 'sandbox' = test checkout, no real money.
  PAYMENT_PROVIDER: z.enum(['none', 'sandbox']).default('none'),
  DEVICE_TTL_DAYS: z.coerce.number().int().min(1).max(730).default(365),
  MIGRATIONS_DIR: z.string().default(path.resolve(process.cwd(), 'migrations')),
  // Tenant backup files (one folder per tenant). Mounted as a volume in Docker.
  BACKUP_DIR: z.string().default(path.resolve(process.cwd(), 'backups')),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Never print values — only which keys are wrong.
  console.error('Invalid environment configuration:');
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  secureCookies: parsed.data.PUBLIC_ORIGIN.startsWith('https://'),
};

if (config.isProd) {
  const weak = ['changeme', 'password', 'postgres', 'secret'];
  if (weak.includes(config.PG_PASSWORD.toLowerCase()) || config.PG_PASSWORD.length < 16) {
    console.error('Refusing to start in production with a weak PG_PASSWORD (min 16 chars).');
    process.exit(1);
  }
  // Sandbox lets anyone mark an order paid with one click: never on a real public (https) site.
  if (config.PAYMENT_PROVIDER === 'sandbox' && config.PUBLIC_ORIGIN.startsWith('https://')) {
    console.error('Refusing to start: PAYMENT_PROVIDER=sandbox is for local testing only.');
    process.exit(1);
  }
  if (/^0+$/.test(config.SECRETS_KEY) || config.SECRETS_KEY === '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef') {
    console.error('Refusing to start in production with a placeholder SECRETS_KEY.');
    process.exit(1);
  }
}
