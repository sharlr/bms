// Usage: PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_PASSWORD='...' node dist/scripts/create-platform-admin.js
// Password is read from the environment so it never appears in shell history / process lists as an argument.
import { hashSecret, isStrongPassword } from '../lib/crypto.js';
import { migrate } from '../master/migrate.js';
import { masterPool } from '../master/pools.js';

const email = process.env.PLATFORM_ADMIN_EMAIL;
const password = process.env.PLATFORM_ADMIN_PASSWORD;
if (!email || !password) {
  console.error('Set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD');
  process.exit(1);
}
if (!isStrongPassword(password)) {
  console.error('Password must be 10+ chars with upper, lower case and a digit');
  process.exit(1);
}
await migrate(masterPool, 'master');
await masterPool.query(
  `INSERT INTO platform_admins (email, password_hash) VALUES ($1, $2)
   ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_attempts = 0, locked_until = NULL`,
  [email, await hashSecret(password)],
);
console.log(`Platform admin ${email} ready.`);
await masterPool.end();
