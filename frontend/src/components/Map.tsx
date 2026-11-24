import { lazy, Suspense, type ComponentProps } from 'react';

// Leaflet is ~50 kB gzipped: load it only when a map is actually shown.
const Lazy = lazy(() => import('./MapPicker').then((m) => ({ default: m.MapPicker })));
export function MapPicker(props: ComponentProps<typeof Lazy>) {
  return <Suspense fallback={<div className="muted small" style={{ height: props.height ?? 300 }}>Loading map…</div>}><Lazy {...props} /></Suspense>;
}

/** Link that opens a delivery location in OpenStreetMap (for riders / staff). */
export const mapLink = (lat: number, lng: number) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;
