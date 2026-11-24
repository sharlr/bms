import { config } from './config.js';
import { runScheduler } from './master/backup.js';
import { migrate } from './master/migrate.js';
import { closeAll, masterPool } from './master/pools.js';
import { migrateAllTenants } from './master/provision.js';
import { initRealtime } from './realtime.js';
import { buildServer } from './server.js';

async function main() {
  const app = await buildServer();
  const applied = await migrate(masterPool, 'master');
  if (applied.length) app.log.info(`master migrations applied: ${applied.join(', ')}`);
  await migrateAllTenants((m) => (m.includes('FAILED') ? app.log.error(m) : app.log.info(m)));
  initRealtime(app.server);
  await app.listen({ host: config.HOST, port: config.PORT });

  // Scheduled tenant backups + expiry cleanup, checked every minute (never overlapping).
  let busy = false;
  const tickBackups = () => {
    if (busy) return;
    busy = true;
    runScheduler((m, err) => (err ? app.log.error(m) : app.log.info(m))).catch((e) => app.log.error(e)).finally(() => { busy = false; });
  };
  const backupTimer = setInterval(tickBackups, 60_000);
  tickBackups();

  const shutdown = async () => {
    app.log.info('shutting down');
    clearInterval(backupTimer);
    await app.close();
    await closeAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
