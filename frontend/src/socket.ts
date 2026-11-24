import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { tenantSlug } from './api';

let socket: Socket | null = null;
let socketKey = '';

function getSocket(branchId: number): Socket {
  const key = `${tenantSlug()}:${branchId}`;
  if (socket && socketKey === key) return socket;
  socket?.disconnect();
  socketKey = key;
  socket = io({ path: '/api/socket.io', auth: { tenant: tenantSlug(), branchId }, withCredentials: true, transports: ['websocket', 'polling'] });
  return socket;
}

/** Subscribe to branch realtime events (floor plan, KDS, new customer orders, low stock). */
export function useBranchEvents(branchId: number | null, events: string[], handler: (event: string, data: any) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!branchId) return;
    const s = getSocket(branchId);
    const subs = events.map((e) => {
      const fn = (d: unknown) => ref.current(e, d);
      s.on(e, fn);
      return [e, fn] as const;
    });
    return () => { subs.forEach(([e, fn]) => s.off(e, fn)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, events.join(',')]);
}
