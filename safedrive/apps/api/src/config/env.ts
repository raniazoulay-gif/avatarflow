import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().default(20),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(10),
  TRUST_PROXY: bool.default('false'),
  DEMO_MODE_ENABLED: bool.default('true'),
  // Speed-limit providers (empty = disabled). See docs/PROVIDER_INTEGRATIONS.md
  SPEED_LIMIT_PROVIDERS: z.string().default('osm'),
  HERE_API_KEY: z.string().optional(),
  TOMTOM_API_KEY: z.string().optional(),
  OVERPASS_URL: z.string().default('https://overpass-api.de/api/interpreter'),
  OVERPASS_MIN_INTERVAL_MS: z.coerce.number().int().default(1100),
  SPEED_LIMIT_CACHE_TTL_DAYS: z.coerce.number().int().default(30),
  SPEED_LIMIT_NEGATIVE_TTL_HOURS: z.coerce.number().int().default(24),
  SPEED_LIMIT_LOOKUP_MIN_METERS: z.coerce.number().default(100),
  SPEED_LIMIT_LOOKUP_MIN_SECONDS: z.coerce.number().default(30),
  PROVIDER_HTTP_TIMEOUT_MS: z.coerce.number().int().default(4000),
  // Push notifications
  PUSH_PROVIDER: z.enum(['log', 'expo', 'none']).default('log'),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  // Sent in the User-Agent of provider calls (OSM usage policy)
  CONTACT_EMAIL: z.string().default('ops@example.com'),
  // Web map tiles handed to clients (MapProvider)
  MAP_TILE_URL: z.string().default('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
  MAP_ATTRIBUTION: z.string().default('© OpenStreetMap contributors'),
  // Jobs
  OFFLINE_AFTER_SECONDS: z.coerce.number().int().default(90),
  AUTO_END_TRIP_AFTER_MINUTES: z.coerce.number().int().default(30),
  WORKERS_ENABLED: bool.default('true'),
  METRICS_TOKEN: z.string().optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.DEMO_MODE_ENABLED) {
    // Demo data is labelled, but production should opt in explicitly.
    console.warn('DEMO_MODE_ENABLED is true in production');
  }
  return env;
}
