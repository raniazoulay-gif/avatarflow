import { type Env } from './config/env.js';
import { type Db } from './db/pool.js';
import { type RealtimeBus } from './realtime/bus.js';
import { type AuthService } from './services/auth.js';
import { type FamilyService } from './services/families.js';
import { type Metrics } from './services/metrics.js';
import { type MonitoringService } from './services/monitoring.js';
import { type NotificationService } from './services/notifications.js';
import { type SosService } from './services/sos.js';
import { type SpeedLimitService } from './services/speed-limits.js';
import { type TelemetryService } from './services/telemetry.js';
import { type TripService } from './services/trips.js';
import { type PushNotificationProvider } from './providers/push/push.js';
import { type SpeedLimitProvider } from './providers/speed-limit/types.js';

export interface AppContext {
  env: Env;
  db: Db;
  bus: RealtimeBus;
  metrics: Metrics;
  auth: AuthService;
  families: FamilyService;
  notifications: NotificationService;
  telemetry: TelemetryService;
  trips: TripService;
  monitoring: MonitoringService;
  sos: SosService;
  speedLimits: SpeedLimitService;
  speedLimitProviders: SpeedLimitProvider[];
  push: PushNotificationProvider;
}
