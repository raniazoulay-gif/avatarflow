/** Layered configuration: global -> country:<CC> -> family:<id>, cached briefly. */
import { resolveSafetyConfig, type SafetyConfig } from '@safedrive/core';
import { type Queryable } from '../db/pool.js';

const cache = new Map<string, { at: number; cfg: SafetyConfig }>();
const TTL_MS = 60_000;

export function clearConfigCache(): void {
  cache.clear();
}

export async function safetyConfigFor(db: Queryable, familyId: string, countryCode: string): Promise<SafetyConfig> {
  const key = `${familyId}:${countryCode}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.cfg;
  const { rows } = await db.query<{ scope: string; value: object }>(
    `SELECT scope, value FROM app_config WHERE key = 'safety' AND scope = ANY($1)`,
    [['global', `country:${countryCode}`, `family:${familyId}`]],
  );
  const order = ['global', `country:${countryCode}`, `family:${familyId}`];
  let merged: object = {};
  for (const scope of order) {
    const r = rows.find((x) => x.scope === scope);
    if (r) merged = deepMerge(merged, r.value);
  }
  const cfg = resolveSafetyConfig(merged);
  cache.set(key, { at: Date.now(), cfg });
  return cfg;
}

function deepMerge(a: object, b: object): object {
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] =
      cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)
        ? deepMerge(cur as object, v as object)
        : v;
  }
  return out;
}
