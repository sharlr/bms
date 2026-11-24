import { migrate } from '../master/migrate.js';
import { closeAll, masterPool } from '../master/pools.js';
import { migrateAllTenants } from '../master/provision.js';

console.log('master:', (await migrate(masterPool, 'master')).join(', ') || 'up to date');
await migrateAllTenants((m) => console.log(m));
await closeAll();
