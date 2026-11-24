import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export interface PlanItem { id: string; kind: string; x: number; y: number; w: number; h: number; label?: string; color?: string }

/** Drawing elements for the restaurant plan: default size, look and label. */
export const KINDS: Record<string, { name: string; icon: string; w: number; h: number; style: CSSProperties }> = {
  wall: { name: 'Wall', icon: '▬', w: 300, h: 12, style: { background: '#475569', borderRadius: 2 } },
  room: { name: 'Room / zone', icon: '⬚', w: 400, h: 300, style: { border: '2px dashed #94a3b8', background: 'rgba(148,163,184,.08)', borderRadius: 6 } },
  bar: { name: 'Bar counter', icon: '🍸', w: 260, h: 50, style: { background: '#92400e', color: '#fff', borderRadius: 8 } },
  kitchen: { name: 'Kitchen', icon: '🍳', w: 260, h: 180, style: { background: '#fef3c7', border: '2px solid #d97706', borderRadius: 6 } },
  door: { name: 'Door', icon: '🚪', w: 70, h: 14, style: { background: '#d6b38a', border: '2px solid #92400e' } },
  window: { name: 'Window', icon: '🪟', w: 120, h: 10, style: { background: '#bae6fd', border: '2px solid #0284c7' } },
  plant: { name: 'Plant', icon: '🌿', w: 40, h: 40, style: { background: '#dcfce7', border: '2px solid #16a34a', borderRadius: '50%' } },
  restroom: { name: 'Restroom', icon: '🚻', w: 140, h: 120, style: { background: '#e0f2fe', border: '2px solid #0369a1', borderRadius: 6 } },
  stage: { name: 'Stage / TV', icon: '🎤', w: 200, h: 80, style: { background: '#ede9fe', border: '2px solid #7c3aed', borderRadius: 6 } },
  text: { name: 'Label', icon: '🔤', w: 160, h: 30, style: { color: '#334155', fontWeight: 700 } },
};

export function Decor({ d, selected, onPointerDown }: { d: PlanItem; selected?: boolean; onPointerDown?: (e: React.PointerEvent) => void }) {
  const k = KINDS[d.kind] ?? KINDS.text;
  const big = Math.min(d.w, d.h) >= 24;
  return (
    <div onPointerDown={onPointerDown}
      style={{
        position: 'absolute', left: d.x, top: d.y, width: d.w, height: d.h, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, overflow: 'hidden', userSelect: 'none', ...k.style, ...(d.color ? { background: d.color } : {}),
        outline: selected ? '3px solid var(--brand)' : undefined, outlineOffset: 2, cursor: onPointerDown ? 'move' : 'default',
        ...(d.kind === 'room' ? { alignItems: 'flex-start', justifyContent: 'flex-start', padding: 6 } : {}),
      }}>
      {big && (d.label ?? (d.kind === 'text' ? 'Label' : `${k.icon} ${k.name}`))}
    </div>
  );
}

/** Fixed-size plan scaled to fit its container width (never enlarged). Children use plan coordinates. */
export function ScaledPlan({ width, height, children, onScale, style }: {
  width: number; height: number; children: ReactNode; onScale?: (s: number) => void; style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setScale(Math.min(1, e.contentRect.width / width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [width]);
  useEffect(() => { onScale?.(scale); }, [scale, onScale]);
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <div style={{ width: width * scale, height: height * scale, position: 'relative' }}>
        <div className="plan" style={{ width, height, transform: `scale(${scale})`, transformOrigin: '0 0', position: 'absolute', left: 0, top: 0, ...style }}>
          {children}
        </div>
      </div>
    </div>
  );
}
