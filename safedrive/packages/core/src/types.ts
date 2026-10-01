/** Wire types shared by the API, the web app and the mobile app. */
import { type Severity } from './config.js';
import { type TripState } from './trip-state.js';

export type Role = 'PARENT' | 'DRIVER';

export interface TelemetryPointInput {
  /** Device-generated UUID, stable across retries. */
  id: string;
  /** Monotonic per trip, starting at 1. */
  seq: number;
  /** Device time of the fix, ISO-8601 or epoch ms. */
  recordedAt: string | number;
  lat: number;
  lon: number;
  altitudeM?: number | null;
  /** GPS speed in m/s (null if the OS did not provide it). */
  speedMs?: number | null;
  headingDeg?: number | null;
  accuracyM?: number | null;
  source?: 'gps' | 'simulated';
}

export interface TelemetryBatchResult {
  accepted: string[];
  duplicates: string[];
  live: LiveTripView | null;
}

export interface LiveTripView {
  tripId: string;
  driverId: string;
  driverName: string;
  isDemo: boolean;
  state: TripState;
  startedAt: string;
  lastUpdateAt: string | null;
  location: { lat: number; lon: number; accuracyM: number | null } | null;
  speedKmh: number | null;
  limitKmh: number | null;
  limitSource: string | null;
  excessKmh: number;
  excessPct: number;
  severity: Severity;
  speedingSeconds: number | null;
  confirming: boolean;
  score: number;
  connection: 'online' | 'stale' | 'offline';
}

export interface ApiError {
  error: string;
  message: string;
}
