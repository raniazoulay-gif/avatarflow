/**
 * OpenStreetMap speed limits through the Overpass API (maxspeed tags).
 * Licence: ODbL (attribution required). The public overpass-api.de instance has a
 * fair-use policy - production should self-host Overpass or use a commercial provider.
 */
import { distanceMeters, bearingDegrees, type LatLon } from '@safedrive/core';
import { fetchJson, MinIntervalGate, type FetchFn } from '../../lib/http.js';
import {
  type RoadMatch,
  type RoadMatchingProvider,
  type SpeedLimitProvider,
  type SpeedLimitQuery,
  type SpeedLimitResult,
} from './types.js';

interface OverpassWay {
  type: 'way';
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

/** Implicit country limits written as "IL:urban" etc. (lower confidence than explicit signs). */
const IMPLICIT: Record<string, number> = {
  'IL:urban': 50,
  'IL:rural': 80,
  'IL:motorway': 110,
};

export function parseMaxspeed(raw: string | undefined): { kmh: number; confidence: number } | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v in IMPLICIT) return { kmh: IMPLICIT[v] as number, confidence: 0.65 };
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?$/i.exec(v);
  if (!m) return null; // "none", "signals", "variable", "walk", unknown zones -> no limit
  const n = Number(m[1]);
  const kmh = m[2]?.toLowerCase() === 'mph' ? n * 1.609344 : n;
  if (!(kmh > 0 && kmh <= 200)) return null;
  return { kmh: Math.round(kmh), confidence: 0.8 };
}

export function pointToSegmentMeters(p: LatLon, a: LatLon, b: LatLon): number {
  // Local equirectangular projection is accurate enough at these distances.
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 110_540;
  const ax = (a.lon - p.lon) * kx,
    ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx,
    by = (b.lat - p.lat) * ky;
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  const cx = ax + t * dx,
    cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy);
}

function headingDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export interface WayCandidate {
  way: OverpassWay;
  distanceM: number;
  headingPenalty: number;
}

/** Picks the way closest to the fix, preferring ways aligned with the heading. */
export function pickWay(
  ways: OverpassWay[],
  q: SpeedLimitQuery,
  maxDistanceM = 30,
): WayCandidate | null {
  let best: WayCandidate | null = null;
  const p = { lat: q.lat, lon: q.lon };
  for (const w of ways) {
    const g = w.geometry ?? [];
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1] as LatLon;
      const b = g[i] as LatLon;
      const d = pointToSegmentMeters(p, a, b);
      let penalty = 0;
      if (q.headingDeg !== null && distanceMeters(a, b) > 3) {
        const brg = bearingDegrees(a, b);
        const diff = Math.min(
          headingDiff(brg, q.headingDeg),
          headingDiff((brg + 180) % 360, q.headingDeg),
        );
        penalty = diff > 45 ? 25 : diff / 3;
      }
      const score = d + penalty;
      if (d <= maxDistanceM && (!best || score < best.distanceM + best.headingPenalty)) {
        best = { way: w, distanceM: d, headingPenalty: penalty };
      }
    }
  }
  return best;
}

export class OsmOverpassProvider implements SpeedLimitProvider, RoadMatchingProvider {
  readonly id = 'osm';
  private readonly gate: MinIntervalGate;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    minIntervalMs: number,
    private readonly userAgent: string,
    private readonly fetchFn?: FetchFn,
  ) {
    this.gate = new MinIntervalGate(minIntervalMs);
  }

  available(): boolean {
    return !!this.url;
  }

  private async ways(q: SpeedLimitQuery, onlyWithMaxspeed: boolean): Promise<OverpassWay[]> {
    const filter = onlyWithMaxspeed ? '[maxspeed]' : '';
    const query = `[out:json][timeout:8];way(around:35,${q.lat.toFixed(6)},${q.lon.toFixed(6)})[highway]${filter};out tags geom;`;
    const body = new URLSearchParams({ data: query }).toString();
    const res = await this.gate.run(() =>
      fetchJson<{ elements?: OverpassWay[] }>(this.url, {
        method: 'POST',
        body,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.userAgent,
        },
        timeoutMs: this.timeoutMs,
        fetchFn: this.fetchFn,
      }),
    );
    return (res.elements ?? []).filter((e) => e.type === 'way');
  }

  async match(q: SpeedLimitQuery): Promise<RoadMatch | null> {
    const best = pickWay(await this.ways(q, false), q);
    if (!best) return null;
    const t = best.way.tags ?? {};
    return {
      externalId: `way/${best.way.id}`,
      name: t['name:he'] ?? t.name ?? null,
      ref: t.ref ?? null,
      highway: t.highway ?? null,
      distanceM: Math.round(best.distanceM),
    };
  }

  async lookup(q: SpeedLimitQuery): Promise<SpeedLimitResult | null> {
    // All highways nearby: the matched road may legitimately have no maxspeed tag,
    // in which case we must answer "unknown" rather than borrow a neighbour's limit.
    const best = pickWay(await this.ways(q, false), q);
    if (!best) return null;
    const t = best.way.tags ?? {};
    const parsed = parseMaxspeed(t.maxspeed);
    if (!parsed) return null;
    let confidence = parsed.confidence;
    if (
      t['maxspeed:forward'] &&
      t['maxspeed:backward'] &&
      t['maxspeed:forward'] !== t['maxspeed:backward']
    ) {
      confidence = Math.min(confidence, 0.6); // direction-dependent, we used the generic tag
    }
    if (best.distanceM > 20) confidence -= 0.1;
    return {
      limitKmh: parsed.kmh,
      confidence: Math.max(0, Math.round(confidence * 100) / 100),
      source: 'osm',
      roadName: t['name:he'] ?? t.name ?? t.ref ?? null,
      externalId: `way/${best.way.id}`,
      highway: t.highway ?? null,
      country: q.countryCode,
      region: null,
      geometry: simplify(best.way.geometry ?? [], 200),
    };
  }
}

/** Keeps at most `max` vertices (uniform thinning) so the geometry stays small in trip state. */
function simplify(g: LatLon[], max: number): LatLon[] {
  if (g.length <= max) return g.map((p) => ({ lat: p.lat, lon: p.lon }));
  const step = (g.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => g[Math.round(i * step)] as LatLon).map((p) => ({
    lat: p.lat,
    lon: p.lon,
  }));
}

/** Distance from a point to a polyline (metres). */
export function distanceToPolyline(p: LatLon, line: LatLon[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < line.length; i++)
    best = Math.min(best, pointToSegmentMeters(p, line[i - 1] as LatLon, line[i] as LatLon));
  return best;
}
