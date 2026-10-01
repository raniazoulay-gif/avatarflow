/** In-process metrics (exported as JSON for the admin dashboard and Prometheus text). */

export class Metrics {
  private counters = new Map<string, number>();
  private timings = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  readonly startedAt = Date.now();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  time(name: string, ms: number): void {
    const t = this.timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    t.count += 1;
    t.totalMs += ms;
    t.maxMs = Math.max(t.maxMs, ms);
    this.timings.set(name, t);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): { counters: Record<string, number>; timings: Record<string, { count: number; avgMs: number; maxMs: number }>; uptimeSec: number } {
    const timings: Record<string, { count: number; avgMs: number; maxMs: number }> = {};
    for (const [k, v] of this.timings) {
      timings[k] = { count: v.count, avgMs: Math.round((v.totalMs / v.count) * 10) / 10, maxMs: Math.round(v.maxMs) };
    }
    return {
      counters: Object.fromEntries(this.counters),
      timings,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  prometheus(): string {
    const lines: string[] = [];
    const name = (k: string) => `safedrive_${k.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    for (const [k, v] of this.counters) lines.push(`${name(k)}_total ${v}`);
    for (const [k, v] of this.timings) {
      lines.push(`${name(k)}_ms_sum ${v.totalMs}`, `${name(k)}_ms_count ${v.count}`);
    }
    lines.push(`safedrive_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);
    return `${lines.join('\n')}\n`;
  }
}
