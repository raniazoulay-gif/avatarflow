/**
 * Demo / simulation routes. Every simulated point is generated from a route of
 * waypoints and a speed profile, with explicit speed limits per segment. Demo data
 * is always flagged (`source: 'simulated'`) and stored on trips marked is_demo, so it
 * can never be mistaken for real driving data.
 */
import { distanceMeters, interpolate, type LatLon, bearingDegrees, kmhToMs } from './units.js';

export interface DemoSegment {
  /** Seconds this phase lasts. */
  seconds: number;
  /** Speed at the start and end of the phase (linear ramp). */
  fromKmh: number;
  toKmh: number;
  /** Speed limit for the phase, or null = "unavailable". */
  limitKmh: number | null;
  /** Simulated GPS problems during the phase. */
  gps?: 'ok' | 'lost' | 'inaccurate';
  network?: 'ok' | 'offline';
  label: string;
}

export interface DemoScenario {
  id: string;
  name: string;
  description: string;
  path: LatLon[];
  roadName: string;
  segments: DemoSegment[];
  sosAtSecond?: number;
}

/** Approximate polyline of Route 1 (Tel Aviv towards Jerusalem). */
const ROUTE_1: LatLon[] = [
  { lat: 32.0581, lon: 34.7978 },
  { lat: 32.0372, lon: 34.8459 },
  { lat: 32.0005, lon: 34.8904 },
  { lat: 31.9472, lon: 34.9383 },
  { lat: 31.8732, lon: 35.0019 },
  { lat: 31.8301, lon: 35.0811 },
  { lat: 31.8146, lon: 35.1478 },
  { lat: 31.7905, lon: 35.1935 },
];

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'full',
    name: 'Full escalation',
    description: 'Normal → ATTENTION → WARNING → CRITICAL → recovery → hard braking → end',
    path: ROUTE_1,
    roadName: 'כביש 1',
    segments: [
      { seconds: 20, fromKmh: 0, toKmh: 90, limitKmh: 100, label: 'accelerating' },
      { seconds: 30, fromKmh: 90, toKmh: 95, limitKmh: 100, label: 'normal' },
      { seconds: 5, fromKmh: 95, toKmh: 114, limitKmh: 100, label: 'speed up' },
      { seconds: 20, fromKmh: 114, toKmh: 116, limitKmh: 100, label: 'ATTENTION' },
      { seconds: 5, fromKmh: 116, toKmh: 135, limitKmh: 100, label: 'speed up' },
      { seconds: 15, fromKmh: 135, toKmh: 138, limitKmh: 100, label: 'WARNING' },
      { seconds: 5, fromKmh: 138, toKmh: 155, limitKmh: 100, label: 'speed up' },
      { seconds: 12, fromKmh: 155, toKmh: 158, limitKmh: 100, label: 'CRITICAL' },
      { seconds: 10, fromKmh: 158, toKmh: 95, limitKmh: 100, label: 'slowing down' },
      { seconds: 25, fromKmh: 95, toKmh: 92, limitKmh: 100, label: 'recovered' },
      { seconds: 2, fromKmh: 92, toKmh: 60, limitKmh: 100, label: 'hard braking' },
      { seconds: 15, fromKmh: 60, toKmh: 0, limitKmh: 100, label: 'stopping' },
    ],
  },
  {
    id: 'short-burst',
    name: '9-second burst (no event)',
    description: 'Exceeds the limit for 9 seconds only: no speeding event must be created',
    path: ROUTE_1,
    roadName: 'כביש 1',
    segments: [
      { seconds: 15, fromKmh: 0, toKmh: 95, limitKmh: 100, label: 'accelerating' },
      { seconds: 9, fromKmh: 120, toKmh: 120, limitKmh: 100, label: 'over limit 9s' },
      { seconds: 20, fromKmh: 95, toKmh: 95, limitKmh: 100, label: 'normal' },
      { seconds: 10, fromKmh: 95, toKmh: 0, limitKmh: 100, label: 'stopping' },
    ],
  },
  {
    id: 'degraded',
    name: 'Network / GPS / limit problems',
    description:
      'Network loss (offline queue), GPS loss, speed limit unavailable, hard acceleration',
    path: ROUTE_1,
    roadName: 'כביש 1',
    segments: [
      { seconds: 4, fromKmh: 0, toKmh: 50, limitKmh: 90, label: 'hard acceleration' },
      { seconds: 20, fromKmh: 50, toKmh: 85, limitKmh: 90, label: 'normal' },
      {
        seconds: 20,
        fromKmh: 85,
        toKmh: 88,
        limitKmh: 90,
        network: 'offline',
        label: 'network lost',
      },
      { seconds: 15, fromKmh: 88, toKmh: 88, limitKmh: 90, gps: 'lost', label: 'GPS lost' },
      {
        seconds: 20,
        fromKmh: 88,
        toKmh: 125,
        limitKmh: null,
        label: 'limit unavailable (no violation)',
      },
      { seconds: 15, fromKmh: 90, toKmh: 0, limitKmh: 90, label: 'stopping' },
    ],
  },
  {
    id: 'sos',
    name: 'SOS',
    description: 'Normal drive, SOS after 20 seconds',
    path: ROUTE_1,
    roadName: 'כביש 1',
    segments: [
      { seconds: 15, fromKmh: 0, toKmh: 70, limitKmh: 90, label: 'accelerating' },
      { seconds: 20, fromKmh: 70, toKmh: 0, limitKmh: 90, label: 'stopping' },
    ],
    sosAtSecond: 20,
  },
];

export interface DemoPoint {
  t: number;
  lat: number;
  lon: number;
  speedMs: number | null;
  headingDeg: number | null;
  accuracyM: number;
  altitudeM: number | null;
  /** Simulated speed limit for the point (demo provider only). */
  limitKmh: number | null;
  online: boolean;
  label: string;
  sos: boolean;
}

/** Points at 1 Hz, moving along the polyline according to the speed profile. */
export function generateDemoPoints(s: DemoScenario, startMs: number): DemoPoint[] {
  const legLengths: number[] = [];
  for (let i = 1; i < s.path.length; i++)
    legLengths.push(distanceMeters(s.path[i - 1] as LatLon, s.path[i] as LatLon));
  const total = legLengths.reduce((a, b) => a + b, 0);
  const positionAt = (meters: number): { p: LatLon; heading: number } => {
    let d = Math.min(Math.max(0, meters), total);
    for (let i = 0; i < legLengths.length; i++) {
      const len = legLengths[i] as number;
      const a = s.path[i] as LatLon;
      const b = s.path[i + 1] as LatLon;
      if (d <= len || i === legLengths.length - 1) {
        return {
          p: interpolate(a, b, len > 0 ? Math.min(1, d / len) : 0),
          heading: bearingDegrees(a, b),
        };
      }
      d -= len;
    }
    return { p: s.path[0] as LatLon, heading: 0 };
  };
  const out: DemoPoint[] = [];
  let sec = 0;
  let travelled = 0;
  for (const seg of s.segments) {
    for (let i = 0; i < seg.seconds; i++) {
      const frac = seg.seconds > 1 ? i / (seg.seconds - 1) : 1;
      const kmh = seg.fromKmh + (seg.toKmh - seg.fromKmh) * frac;
      travelled += kmhToMs(kmh);
      const { p, heading } = positionAt(travelled);
      const gps = seg.gps ?? 'ok';
      if (gps !== 'lost') {
        out.push({
          t: startMs + sec * 1000,
          lat: p.lat,
          lon: p.lon,
          speedMs: kmhToMs(kmh),
          headingDeg: Math.round(heading),
          accuracyM: gps === 'inaccurate' ? 120 : 6,
          altitudeM: null,
          limitKmh: seg.limitKmh,
          online: (seg.network ?? 'ok') === 'ok',
          label: seg.label,
          sos: s.sosAtSecond === sec,
        });
      }
      sec += 1;
    }
  }
  return out;
}

export function demoScenario(id: string): DemoScenario | undefined {
  return DEMO_SCENARIOS.find((d) => d.id === id);
}
