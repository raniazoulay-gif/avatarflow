/**
 * Leaflet map (MapProvider = configurable raster tiles from /config/client).
 * Markers coloured by severity; optional route polyline coloured by speeding.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  label: string;
  color: string;
}

export interface RouteSegment {
  points: Array<[number, number]>;
  color: string;
}

let tileConfig = {
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors',
};
export function setTileConfig(c: { tileUrl: string; attribution: string }) {
  tileConfig = c;
}

export const SEVERITY_COLORS: Record<string, string> = {
  SAFE: '#15803d',
  ATTENTION: '#d97706',
  WARNING: '#ea580c',
  CRITICAL: '#dc2626',
};

export function MapView({
  markers = [],
  route = [],
  cursor,
  height = 460,
  fit = true,
}: {
  markers?: MapMarker[];
  route?: RouteSegment[];
  cursor?: [number, number] | null;
  height?: number;
  fit?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true }).setView([31.8, 35.0], 8);
    L.tileLayer(tileConfig.tileUrl, { attribution: tileConfig.attribution, maxZoom: 19 }).addTo(
      map.current,
    );
    layer.current = L.layerGroup().addTo(map.current);
    // Leaflet needs the real container size (grid layouts settle after mount).
    const ro = new ResizeObserver(() => map.current?.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      map.current?.remove();
      map.current = null;
      fitted.current = false;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    for (const seg of route) {
      L.polyline(seg.points, { color: seg.color, weight: 5, opacity: 0.9 }).addTo(g);
      bounds.push(...seg.points);
    }
    for (const mk of markers) {
      L.circleMarker([mk.lat, mk.lon], {
        radius: 11,
        color: '#fff',
        weight: 3,
        fillColor: mk.color,
        fillOpacity: 1,
      })
        // Labels contain user-provided names: pass a text node, never an HTML string.
        .bindTooltip(textNode(mk.label), { permanent: true, direction: 'top', offset: [0, -10] })
        .addTo(g);
      bounds.push([mk.lat, mk.lon]);
    }
    if (cursor)
      L.circleMarker(cursor, {
        radius: 8,
        color: '#fff',
        weight: 3,
        fillColor: '#2563eb',
        fillOpacity: 1,
      }).addTo(g);
    if (fit && bounds.length && (!fitted.current || markers.length > 0)) {
      const first = !fitted.current;
      fitted.current = true;
      // Defer one frame so the container has its final size before computing the zoom.
      requestAnimationFrame(() => {
        if (!map.current) return;
        map.current.invalidateSize();
        if (bounds.length === 1)
          map.current.setView(bounds[0] as L.LatLngExpression, Math.max(map.current.getZoom(), 13));
        else if (first)
          map.current.fitBounds(L.latLngBounds(bounds as L.LatLngTuple[]), {
            padding: [30, 30],
            maxZoom: 16,
          });
      });
    }
  }, [markers, route, cursor, fit]);

  return <div ref={el} className="map" style={{ height }} />;
}

function textNode(text: string): HTMLElement {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}
