import { useT as useTr } from '../i18n';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';

export interface LatLng { lat: number; lng: number }
// Used when the branch has no location set (Settings → Branches): Djibouti City.
const FALLBACK: LatLng = { lat: 11.5886, lng: 43.1452 };
const pin = L.divIcon({ html: '<div style="font-size:34px;line-height:34px;transform:translate(-8px,-30px)">📍</div>', className: '', iconSize: [0, 0] });
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Tap the map (or drag the pin) to choose the delivery location. OpenStreetMap tiles. */
export function MapPicker({ value, onChange, center, height = 300 }: {
  value: LatLng | null; onChange: (v: LatLng) => void; center?: LatLng | null; height?: number;
}) {
  const tr = useTr();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  const [locating, setLocating] = useState(false);

  const place = (p: LatLng, pan = false) => {
    if (!map.current) return;
    if (!marker.current) {
      marker.current = L.marker(p, { icon: pin, draggable: true, keyboard: true, title: tr("Delivery location") }).addTo(map.current);
      marker.current.on('dragend', () => { const ll = marker.current!.getLatLng(); cb.current({ lat: round6(ll.lat), lng: round6(ll.lng) }); });
    } else marker.current.setLatLng(p);
    if (pan) map.current.setView(p, Math.max(map.current.getZoom(), 16));
  };

  useEffect(() => {
    if (!el.current) return;
    const start = value ?? center ?? FALLBACK;
    const m = L.map(el.current, { zoomControl: true }).setView(start, value ? 16 : 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => { const p = { lat: round6(e.latlng.lat), lng: round6(e.latlng.lng) }; place(p); cb.current(p); });
    map.current = m;
    if (value) place(value);
    // The map may mount inside a modal that is still animating: recompute its size.
    setTimeout(() => m.invalidateSize(), 200);
    return () => { m.remove(); map.current = null; marker.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const locate = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); const p = { lat: round6(pos.coords.latitude), lng: round6(pos.coords.longitude) }; place(p, true); cb.current(p); },
      () => setLocating(false), { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  return (
    <div className="stack" style={{ gap: '.4rem' }}>
      <div ref={el} style={{ height, borderRadius: 10, border: '1px solid var(--line)', zIndex: 0 }} role="application" aria-label={tr("Map: tap to choose the delivery location")} />
      <div className="row between small">
        <span className={value ? 'ok' : 'muted'}>{value ? tr("📍 Location set ({0}, {1})", value.lat.toFixed(5), value.lng.toFixed(5)) : tr("Tap the map to drop the pin on the delivery location.")}</span>
        <button type="button" className="sm" onClick={locate} disabled={locating}>{locating ? tr("Locating…") : tr("📍 Use my location")}</button>
      </div>
    </div>
  );
}

