/** Unit conversions and geodesy helpers. Internally speeds are km/h, distances metres. */

const EARTH_RADIUS_M = 6_371_008.8;
const MS_TO_KMH = 3.6;
const KMH_TO_MPH = 0.621371;

export function msToKmh(ms: number): number {
  return ms * MS_TO_KMH;
}

export function kmhToMs(kmh: number): number {
  return kmh / MS_TO_KMH;
}

export function kmhToMph(kmh: number): number {
  return kmh * KMH_TO_MPH;
}

export type SpeedUnit = 'kmh' | 'mph';

/** Converts an internal km/h value to the display unit of a country profile. */
export function toDisplaySpeed(kmh: number, unit: SpeedUnit): number {
  return unit === 'mph' ? kmhToMph(kmh) : kmh;
}

export interface LatLon {
  lat: number;
  lon: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees [0, 360). */
export function bearingDegrees(a: LatLon, b: LatLon): number {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Point at a fraction t (0..1) between a and b (linear, fine for short segments). */
export function interpolate(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

export function isValidCoordinate(p: LatLon): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lon >= -180 &&
    p.lon <= 180
  );
}
