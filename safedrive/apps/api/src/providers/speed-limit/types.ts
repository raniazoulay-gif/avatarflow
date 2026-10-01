/** Provider abstraction: business logic never talks to a vendor directly. */

export interface SpeedLimitQuery {
  lat: number;
  lon: number;
  headingDeg: number | null;
  countryCode: string;
}

export interface SpeedLimitResult {
  limitKmh: number | null;
  /** 0..1 - below the configured minimum the engine treats the limit as unavailable. */
  confidence: number;
  source: string;
  roadName: string | null;
  externalId: string | null;
  highway?: string | null;
  country: string | null;
  region: string | null;
  /**
   * Polyline of the matched road segment, when the provider returns it (OSM). While the
   * vehicle stays on it, the limit is reused without another provider call.
   */
  geometry?: Array<{ lat: number; lon: number }>;
}

export interface SpeedLimitProvider {
  readonly id: string;
  /** False when not configured (e.g. missing API key) - the chain skips it. */
  available(): boolean;
  /** null = the provider answered "no data here"; throws on errors/timeouts. */
  lookup(q: SpeedLimitQuery): Promise<SpeedLimitResult | null>;
}

export interface RoadMatch {
  externalId: string;
  name: string | null;
  ref: string | null;
  highway: string | null;
  distanceM: number;
}

/** Map-matching of a fix to a road (OSM ways via Overpass in the default build). */
export interface RoadMatchingProvider {
  readonly id: string;
  available(): boolean;
  match(q: SpeedLimitQuery): Promise<RoadMatch | null>;
}
