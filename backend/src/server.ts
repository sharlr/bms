import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { masterPool } from './master/pools.js';
import { authRoutes } from './modules/auth.js';
import { backupRoutes } from './modules/backup.js';
import { billingRoutes } from './modules/billing.js';
import { financeRoutes } from './modules/finance.js';
import { inventoryRoutes } from './modules/inventory.js';
import { kitchenRoutes } from './modules/kitchen.js';
import { menuRoutes } from './modules/menu.js';
import { orgRoutes } from './modules/org.js';
import { platformRoutes } from './modules/platform.js';
import { posRoutes } from './modules/pos.js';
import { publicRoutes } from './modules/public.js';
import { reportRoutes } from './modules/reports.js';
import { reservationRoutes } from './modules/reservations.js';
import { resourceRoutes } from './modules/resources.js';
import { loadAuth, tenantHook } from './plugins/context.js';

export async function buildServer() {
  const app = Fastify({
    // Only trust X-Forwarded-For from private networks (Traefik on the docker network). Traefik strips
    // client-supplied forwarding headers, so req.ip is the real client IP used for rate limiting & audit.
    trustProxy: 'loopback, linklocal, uniquelocal',
    bodyLimit: 512 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: config.secureCookies ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, { origin: [config.PUBLIC_ORIGIN], credentials: true, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    }
    const pg = err as any;
    if (pg.code === '23505') return reply.code(409).send({ error: 'conflict', message: 'A record with these values already exists' });
    if (pg.code === '23503') return reply.code(400).send({ error: 'reference', message: 'Referenced record does not exist or is in use' });
    if (pg.code === '23514' || pg.code === '22P02') return reply.code(400).send({ error: 'invalid', message: 'Invalid value' });
    if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
      return reply.code((err as FastifyError).statusCode!).send({ error: 'request', message: err.message });
    }
    req.log.error(err);
    // Never leak internals in production.
    return reply.code(500).send({ error: 'internal', message: config.isProd ? 'Internal server error' : err.message });
  });

  app.get('/api/health', { config: { rateLimit: false } }, async () => {
    await masterPool.query('SELECT 1');
    return { ok: true };
  });

  await app.register(platformRoutes, { prefix: '/api/platform' });

  await app.register(async (t) => {
    t.addHook('onRequest', tenantHook);
    t.addHook('preHandler', loadAuth);
    authRoutes(t);
    orgRoutes(t);
    resourceRoutes(t);
    menuRoutes(t);
    posRoutes(t);
    billingRoutes(t);
    kitchenRoutes(t);
    inventoryRoutes(t);
    financeRoutes(t);
    publicRoutes(t);
    backupRoutes(t);
    reportRoutes(t);
    reservationRoutes(t);
  }, { prefix: '/api/t/:tenant' });

  return app;
}
