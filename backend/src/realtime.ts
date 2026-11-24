import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { sha256 } from './lib/crypto.js';
import { many, one } from './lib/db.js';
import { getTenant } from './master/pools.js';
import { canAccessBranch, deviceCookie, sessionCookie, sessionFromToken } from './plugins/context.js';

let io: Server | null = null;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

/**
 * Socket rooms: `<tenant>:<branch>` for staff screens (floor plan, KDS, POS),
 * `<tenant>:<branch>:print` for in-store print agents.
 */
export function initRealtime(server: HttpServer) {
  io = new Server(server, {
    path: '/api/socket.io',
    serveClient: false,
    cors: { origin: config.PUBLIC_ORIGIN, credentials: true },
    maxHttpBufferSize: 64 * 1024,
  });

  io.use(async (socket, next) => {
    try {
      const { tenant: slug, branchId, deviceToken } = socket.handshake.auth as Record<string, string>;
      const t = typeof slug === 'string' ? await getTenant(slug) : null;
      if (!t) return next(new Error('unknown tenant'));
      if (deviceToken) {
        const d = await one<any>(t.pool,
          `SELECT id, branch_id FROM devices WHERE token_hash = $1 AND revoked_at IS NULL AND mode = 'print_agent'`, [sha256(deviceToken)]);
        if (!d) return next(new Error('unauthorized'));
        socket.data = { slug, branchId: d.branch_id, printAgent: true, deviceId: d.id };
        return next();
      }
      const origin = socket.handshake.headers.origin;
      if (origin && origin !== config.PUBLIC_ORIGIN) return next(new Error('bad origin'));
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const sid = cookies[sessionCookie(slug)];
      const auth = sid ? await sessionFromToken(t.pool, sid) : null;
      const bid = Number(branchId);
      if (!Number.isInteger(bid)) return next(new Error('branch required'));
      if (auth) {
        const b = await one<any>(t.pool, 'SELECT company_id FROM branches WHERE id = $1', [bid]);
        if (!b || !canAccessBranch(auth, b.company_id, bid)) return next(new Error('forbidden'));
      } else {
        // Kiosk devices may listen for their own order status updates.
        const dev = cookies[deviceCookie(slug)];
        const d = dev ? await one<any>(t.pool, `SELECT branch_id FROM devices WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(dev)]) : null;
        if (!d || d.branch_id !== bid) return next(new Error('unauthorized'));
      }
      socket.data = { slug, branchId: bid, printAgent: false };
      next();
    } catch {
      next(new Error('auth error'));
    }
  });

  io.on('connection', async (socket) => {
    const { slug, branchId, printAgent } = socket.data as { slug: string; branchId: number; printAgent: boolean };
    if (!printAgent) {
      socket.join(`${slug}:${branchId}`);
      return;
    }
    socket.join(`${slug}:${branchId}:print`);
    const t = await getTenant(slug);
    if (!t) return socket.disconnect(true);
    socket.on('print:ack', async (msg: { jobId?: number; ok?: boolean; error?: string }) => {
      if (!msg || !Number.isInteger(msg.jobId)) return;
      await t.pool.query(
        `UPDATE print_jobs SET status = $1, error = $2, attempts = attempts + 1, printed_at = CASE WHEN $1 = 'printed' THEN now() END
          WHERE id = $3 AND branch_id = $4`,
        [msg.ok ? 'printed' : 'failed', msg.ok ? null : String(msg.error ?? '').slice(0, 300), msg.jobId, branchId],
      ).catch(() => undefined);
    });
    // Replay anything queued while the agent was offline.
    const pending = await many(t.pool,
      `SELECT pj.*, p.connection, p.chars_per_line FROM print_jobs pj LEFT JOIN printers p ON p.id = pj.printer_id
        WHERE pj.branch_id = $1 AND pj.status IN ('pending','failed') AND pj.attempts < 5
          AND pj.created_at > now() - interval '12 hours' ORDER BY pj.id`, [branchId]);
    for (const job of pending) socket.emit('print:job', job);
  });
  return io;
}

/** Collects realtime events during a transaction; flushed only after COMMIT. */
export class Events {
  private items: { room: string; event: string; data: unknown }[] = [];
  constructor(private slug: string) {}
  branch(branchId: number, event: string, data: unknown) {
    this.items.push({ room: `${this.slug}:${branchId}`, event, data });
  }
  print(branchId: number, job: unknown) {
    this.items.push({ room: `${this.slug}:${branchId}:print`, event: 'print:job', data: job });
  }
  flush() {
    for (const i of this.items) io?.to(i.room).emit(i.event, i.data);
    this.items = [];
  }
}
