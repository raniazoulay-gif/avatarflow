/**
 * Commercial speed-limit providers (require API keys; skipped when unconfigured).
 *  - HERE Routing API v8, `spans=speedLimit` on a ~40 m route along the heading.
 *  - TomTom Search API reverse geocoding with `returnSpeedLimit=true`.
 * Both are documented public APIs; check pricing/terms in PROVIDER_INTEGRATIONS.md.
 */
import { fetchJson, type FetchFn } from '../../lib/http.js';
import { type SpeedLimitProvider, type SpeedLimitQuery, type SpeedLimitResult } from './types.js';

function pointAhead(lat: number, lon: number, headingDeg: number | null, meters: number): { lat: number; lon: number } {
  const h = ((headingDeg ?? 0) * Math.PI) / 180;
  const dLat = (meters * Math.cos(h)) / 111_320;
  const dLon = (meters * Math.sin(h)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lon: lon + dLon };
}

interface HereResponse {
  routes?: {
    sections?: {
      spans?: { speedLimit?: number; names?: { value: string }[] }[];
    }[];
  }[];
}

export class HereSpeedLimitProvider implements SpeedLimitProvider {
  readonly id = 'here';
  constructor(
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchFn?: FetchFn,
  ) {}

  available(): boolean {
    return !!this.apiKey;
  }

  async lookup(q: SpeedLimitQuery): Promise<SpeedLimitResult | null> {
    if (!this.apiKey) return null;
    const dest = pointAhead(q.lat, q.lon, q.headingDeg, 40);
    const params = new URLSearchParams({
      transportMode: 'car',
      origin: `${q.lat},${q.lon}`,
      destination: `${dest.lat},${dest.lon}`,
      spans: 'speedLimit,names',
      return: 'summary',
      apikey: this.apiKey,
    });
    const r = await fetchJson<HereResponse>(`https://router.hereapi.com/v8/routes?${params}`, {
      timeoutMs: this.timeoutMs,
      fetchFn: this.fetchFn,
    });
    const span = r.routes?.[0]?.sections?.[0]?.spans?.find((s) => typeof s.speedLimit === 'number');
    if (!span || !span.speedLimit) return null;
    return {
      limitKmh: Math.round(span.speedLimit * 3.6),
      confidence: 0.9,
      source: 'here',
      roadName: span.names?.[0]?.value ?? null,
      externalId: null,
      country: q.countryCode,
      region: null,
    };
  }
}

interface TomTomResponse {
  addresses?: { address?: { speedLimit?: string; street?: string; routeNumbers?: string[]; countrySubdivision?: string } }[];
}

export function parseTomTomSpeed(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+(?:\.\d+)?)(KMH|MPH)$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(m[2]?.toUpperCase() === 'MPH' ? n * 1.609344 : n);
}

export class TomTomSpeedLimitProvider implements SpeedLimitProvider {
  readonly id = 'tomtom';
  constructor(
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchFn?: FetchFn,
  ) {}

  available(): boolean {
    return !!this.apiKey;
  }

  async lookup(q: SpeedLimitQuery): Promise<SpeedLimitResult | null> {
    if (!this.apiKey) return null;
    const params = new URLSearchParams({ key: this.apiKey, returnSpeedLimit: 'true', radius: '30' });
    if (q.headingDeg !== null) params.set('heading', String(Math.round(q.headingDeg)));
    const r = await fetchJson<TomTomResponse>(
      `https://api.tomtom.com/search/2/reverseGeocode/${q.lat},${q.lon}.json?${params}`,
      { timeoutMs: this.timeoutMs, fetchFn: this.fetchFn },
    );
    const a = r.addresses?.[0]?.address;
    const kmh = parseTomTomSpeed(a?.speedLimit);
    if (!kmh) return null;
    return {
      limitKmh: kmh,
      confidence: 0.85,
      source: 'tomtom',
      roadName: a?.street ?? a?.routeNumbers?.[0] ?? null,
      externalId: null,
      country: q.countryCode,
      region: a?.countrySubdivision ?? null,
    };
  }
}
