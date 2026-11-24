import { useEffect, useRef, useState } from 'react';

// Single-measure charts use one hue (categorical slot 1 of the reference palette); text stays in ink colors.
const SERIES = '#2a78d6';
const INK2 = '#52514e';
const GRID = '#e5e7eb';
const fmtN = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

function Tip({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: 'translate(-50%, -110%)', background: '#0f172a', color: '#fff', padding: '.35rem .55rem', borderRadius: 6, fontSize: '.8rem', pointerEvents: 'none', whiteSpace: 'nowrap', boxShadow: '0 4px 12px rgba(0,0,0,.2)' }}>
      {children}
    </div>
  );
}

/** Line chart for a daily series (x = ISO date). Hover anywhere for a crosshair + tooltip. */
export function LineChart({ data, height = 260, label }: { data: { x: string; y: number }[]; height?: number; label: string }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const m = { t: 12, r: 16, b: 28, l: 64 };
  const iw = w - m.l - m.r, ih = height - m.t - m.b;
  const max = niceMax(Math.max(0, ...data.map((d) => d.y)));
  const X = (i: number) => m.l + (data.length <= 1 ? iw / 2 : (i * iw) / (data.length - 1));
  const Y = (v: number) => m.t + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 80))));
  const day = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${X(i)},${Y(d.y)}`).join(' ');
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (!data.length) return;
    const i = data.length <= 1 ? 0 : Math.round(((px - m.l) / iw) * (data.length - 1));
    setHover(Math.min(data.length - 1, Math.max(0, i)));
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg width={w} height={height} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ display: 'block', touchAction: 'pan-y' }}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={w - m.r} y1={Y(v)} y2={Y(v)} stroke={GRID} />
            <text x={m.l - 8} y={Y(v)} textAnchor="end" dominantBaseline="middle" fontSize="11" fill={INK2}>{fmtN(v)}</text>
          </g>
        ))}
        {data.map((d, i) => i % every === 0 && <text key={d.x} x={X(i)} y={height - 8} textAnchor="middle" fontSize="11" fill={INK2}>{day(d.x)}</text>)}
        <path d={path} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" />
        {hover !== null && data[hover] && <>
          <line x1={X(hover)} x2={X(hover)} y1={m.t} y2={m.t + ih} stroke="#94a3b8" strokeDasharray="3 3" />
          <circle cx={X(hover)} cy={Y(data[hover].y)} r={5} fill={SERIES} stroke="#fff" strokeWidth={2} />
        </>}
      </svg>
      {hover !== null && data[hover] && <Tip x={X(hover)} y={Y(data[hover].y)}><b>{day(data[hover].x)}</b> · {fmtN(data[hover].y)}</Tip>}
    </div>
  );
}

/** Horizontal bars, one measure across categories (one hue). Value is labeled at each bar end. */
export function BarChart({ data, label }: { data: { label: string; value: number }[]; label: string }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const bar = 28, gap = 12, m = { t: 4, r: 80, l: 110 };
  const height = m.t + data.length * (bar + gap);
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const L = (v: number) => ((w - m.l - m.r) * v) / max;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg width={w} height={height} role="img" aria-label={label} style={{ display: 'block' }}>
        <line x1={m.l} x2={m.l} y1={0} y2={height} stroke={GRID} />
        {data.map((d, i) => {
          const y = m.t + i * (bar + gap), len = Math.max(0, L(d.value)), r = Math.min(4, len);
          return (
            <g key={d.label} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect x={0} y={y - gap / 2} width={w} height={bar + gap} fill="transparent" />
              <text x={m.l - 8} y={y + bar / 2} textAnchor="end" dominantBaseline="middle" fontSize="12" fill={INK2}>{d.label}</text>
              {/* rounded only at the data end; flat against the baseline */}
              {len > 0 && <path d={`M${m.l},${y} H${m.l + len - r} Q${m.l + len},${y} ${m.l + len},${y + r} V${y + bar - r} Q${m.l + len},${y + bar} ${m.l + len - r},${y + bar} H${m.l} Z`}
                fill={SERIES} opacity={hover === null || hover === i ? 1 : 0.55} />}
              <text x={m.l + len + 6} y={y + bar / 2} dominantBaseline="middle" fontSize="12" fill="#0b0b0b">{fmtN(d.value)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
