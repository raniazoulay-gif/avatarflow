/**
 * Speed-limit resolution with layered caching and provider fallback:
 *   memory LRU -> speed_limits table (per ~30 m cell + heading bucket) -> providers in order.
 * Demo trips never call external providers: they only use the limit carried by the
 * simulated point. Usage per provider is accounted for cost monitoring.
 */
import { type Db } from '../db/pool.js';
import {
  type SpeedLimitProvider,
  type SpeedLimitQuery,
  type SpeedLimitResult,
} from '../providers/speed-limit/types.js';
import { type Metrics } from './metrics.js';

const CELL_DEG = 0.0003; // ~33 m north-south

export function cellKey(q: SpeedLimitQuery): string {
  const la = Math.round(q.lat / CELL_DEG);
  const lo = Math.round(q.lon / CELL_DEG);
  const h =
    q.headingDeg === null ? 'x' : String(Math.round((((q.headingDeg % 360) + 360) % 360) / 45) % 8);
  return `${la}:${lo}:${h}`;
}

export interface ProviderHealth {
  id: string;
  available: boolean;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  calls: number;
  errors: number;
  avgLatencyMs: number;
}

interface CacheEntry {
  result: SpeedLimitResult | null;
  expiresAt: number;
}

export class SpeedLimitService {
  private readonly memory = new Map<string, CacheEntry>();
  private readonly health = new Map<string, ProviderHealth>();
  private usage = new Map<
    string,
    { calls: number; errors: number; cacheHits: number; totalMs: number }
  >();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly providers: SpeedLimitProvider[],
    private readonly metrics: Metrics,
    private readonly opts: {
      positiveTtlMs: number;
      negativeTtlMs: number;
      errorTtlMs: number;
      memoryMax: number;
    },
  ) {
    for (const p of providers) {
      this.health.set(p.id, {
        id: p.id,
        available: p.available(),
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
        calls: 0,
        errors: 0,
        avgLatencyMs: 0,
      });
    }
  }

  startUsageFlush(intervalMs = 30_000): void {
    this.flushTimer = setInterval(() => void this.flushUsage().catch(() => undefined), intervalMs);
    this.flushTimer.unref();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  providerHealth(): ProviderHealth[] {
    return [...this.health.values()].map((h) => ({ ...h }));
  }

  private bump(provider: string, f: 'calls' | 'errors' | 'cacheHits', ms = 0): void {
    const u = this.usage.get(provider) ?? { calls: 0, errors: 0, cacheHits: 0, totalMs: 0 };
    u[f] += 1;
    u.totalMs += ms;
    this.usage.set(provider, u);
  }

  async flushUsage(): Promise<void> {
    const pending = this.usage;
    this.usage = new Map();
    for (const [provider, u] of pending) {
      await this.db.query(
        `INSERT INTO provider_usage (provider, day, calls, errors, cache_hits, total_ms)
         VALUES ($1, current_date, $2, $3, $4, $5)
         ON CONFLICT (provider, day) DO UPDATE SET calls = provider_usage.calls + EXCLUDED.calls,
           errors = provider_usage.errors + EXCLUDED.errors, cache_hits = provider_usage.cache_hits + EXCLUDED.cache_hits,
           total_ms = provider_usage.total_ms + EXCLUDED.total_ms`,
        [provider, u.calls, u.errors, u.cacheHits, Math.round(u.totalMs)],
      );
    }
  }

  private remember(key: string, result: SpeedLimitResult | null, ttlMs: number): void {
    if (this.memory.size >= this.opts.memoryMax) {
      const first = this.memory.keys().next().value;
      if (first !== undefined) this.memory.delete(first);
    }
    this.memory.set(key, { result, expiresAt: Date.now() + ttlMs });
  }

  /** Returns a limit or null ("unavailable"). Never throws: failures degrade to null. */
  async resolve(q: SpeedLimitQuery): Promise<SpeedLimitResult | null> {
    const key = cellKey(q);
    const mem = this.memory.get(key);
    if (mem && mem.expiresAt > Date.now()) {
      this.bump('cache', 'cacheHits');
      this.metrics.inc('speed_limit_cache_hit');
      return mem.result;
    }
    const cached = await this.db.query<{
      provider: string;
      limit_kmh: number | null;
      confidence: number;
      road_name: string | null;
      country: string | null;
      region: string | null;
      expires_at: Date;
    }>(
      'SELECT provider, limit_kmh, confidence, road_name, country, region, expires_at FROM speed_limits WHERE cell_key = $1 AND expires_at > now()',
      [key],
    );
    const row = cached.rows[0];
    if (row) {
      const r: SpeedLimitResult | null =
        row.limit_kmh === null
          ? null
          : {
              limitKmh: row.limit_kmh,
              confidence: row.confidence,
              source: row.provider,
              roadName: row.road_name,
              externalId: null,
              country: row.country,
              region: row.region,
            };
      this.remember(key, r, Math.max(1000, row.expires_at.getTime() - Date.now()));
      this.bump('cache', 'cacheHits');
      this.metrics.inc('speed_limit_cache_hit');
      return r;
    }

    let anyAnswered = false;
    for (const p of this.providers) {
      if (!p.available()) continue;
      const h = this.health.get(p.id) as ProviderHealth;
      const t0 = performance.now();
      try {
        const r = await p.lookup(q);
        const ms = performance.now() - t0;
        h.calls += 1;
        h.avgLatencyMs = Math.round(((h.avgLatencyMs * (h.calls - 1) + ms) / h.calls) * 10) / 10;
        h.lastSuccessAt = Date.now();
        this.bump(p.id, 'calls', ms);
        this.metrics.inc(`provider_${p.id}_calls`);
        this.metrics.time(`provider_${p.id}_latency`, ms);
        anyAnswered = true;
        if (r && r.limitKmh !== null) {
          await this.store(key, r, this.opts.positiveTtlMs);
          return r;
        }
      } catch (e) {
        h.errors += 1;
        h.lastErrorAt = Date.now();
        h.lastError = (e as Error).message.slice(0, 200);
        this.bump(p.id, 'errors');
        this.metrics.inc(`provider_${p.id}_errors`);
      }
    }
    if (anyAnswered) {
      // Everybody answered "no data": negative-cache so we do not ask again every second.
      await this.store(key, null, this.opts.negativeTtlMs);
    } else {
      this.remember(key, null, this.opts.errorTtlMs);
    }
    return null;
  }

  private async store(key: string, r: SpeedLimitResult | null, ttlMs: number): Promise<void> {
    this.remember(key, r, ttlMs);
    let segmentId: string | null = null;
    if (r?.externalId) {
      const seg = await this.db.query<{ id: string }>(
        `INSERT INTO road_segments (provider, external_id, name, highway, maxspeed_kmh, country, region)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (provider, external_id) DO UPDATE SET name = EXCLUDED.name, maxspeed_kmh = EXCLUDED.maxspeed_kmh, fetched_at = now()
         RETURNING id`,
        [r.source, r.externalId, r.roadName, r.highway ?? null, r.limitKmh, r.country, r.region],
      );
      segmentId = seg.rows[0]?.id ?? null;
    }
    await this.db.query(
      `INSERT INTO speed_limits (cell_key, provider, limit_kmh, confidence, road_segment_id, road_name, country, region, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' milliseconds')::interval)
       ON CONFLICT (cell_key) DO UPDATE SET provider = EXCLUDED.provider, limit_kmh = EXCLUDED.limit_kmh,
         confidence = EXCLUDED.confidence, road_segment_id = EXCLUDED.road_segment_id, road_name = EXCLUDED.road_name,
         fetched_at = now(), expires_at = EXCLUDED.expires_at`,
      [
        key,
        r?.source ?? 'none',
        r?.limitKmh ?? null,
        r?.confidence ?? 0,
        segmentId,
        r?.roadName ?? null,
        r?.country ?? null,
        r?.region ?? null,
        String(ttlMs),
      ],
    );
  }
}
