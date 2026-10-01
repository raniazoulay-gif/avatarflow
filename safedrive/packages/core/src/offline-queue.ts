/**
 * Durable, ordered, idempotent outbound queue for telemetry (and other device
 * events). Storage is pluggable (AsyncStorage/SQLite on mobile, memory in tests).
 *
 * Guarantees:
 *  - items keep the order and the device timestamps they were recorded with;
 *  - every item carries a stable id + per-trip sequence number, so a retried
 *    upload is de-duplicated by the server (ON CONFLICT DO NOTHING);
 *  - items are removed only after the server acknowledges them;
 *  - failed uploads back off exponentially (with a cap) and are retried.
 */

export interface QueueItem<T> {
  id: string;
  /** Monotonic per stream (e.g. per trip). */
  seq: number;
  stream: string;
  createdAt: number;
  payload: T;
}

export interface QueueStorage<T> {
  load(): Promise<QueueSnapshot<T> | null>;
  save(snapshot: QueueSnapshot<T>): Promise<void>;
}

export interface QueueSnapshot<T> {
  items: QueueItem<T>[];
  nextSeq: Record<string, number>;
  failures: number;
  nextAttemptAt: number;
}

export interface SendResult {
  /** Ids the server confirmed (stored now or earlier). */
  acknowledged: string[];
}

export type Sender<T> = (batch: QueueItem<T>[]) => Promise<SendResult>;

export interface QueueOptions {
  maxBatch: number;
  maxItems: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  now?: () => number;
  idFactory?: () => string;
}

const DEFAULTS: QueueOptions = {
  maxBatch: 100,
  maxItems: 50_000,
  baseBackoffMs: 2_000,
  maxBackoffMs: 5 * 60_000,
};

function defaultId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class OutboundQueue<T> {
  private snap: QueueSnapshot<T> = { items: [], nextSeq: {}, failures: 0, nextAttemptAt: 0 };
  private loaded = false;
  private flushing: Promise<number> | null = null;
  private readonly opt: QueueOptions;

  constructor(
    private readonly storage: QueueStorage<T>,
    options: Partial<QueueOptions> = {},
  ) {
    this.opt = { ...DEFAULTS, ...options };
  }

  private now(): number {
    return (this.opt.now ?? Date.now)();
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    const s = await this.storage.load();
    if (s) this.snap = s;
    this.loaded = true;
  }

  get size(): number {
    return this.snap.items.length;
  }

  get pendingFailures(): number {
    return this.snap.failures;
  }

  async enqueue(stream: string, payload: T): Promise<QueueItem<T>> {
    await this.init();
    const seq = (this.snap.nextSeq[stream] ?? 0) + 1;
    this.snap.nextSeq[stream] = seq;
    const item: QueueItem<T> = {
      id: (this.opt.idFactory ?? defaultId)(),
      seq,
      stream,
      createdAt: this.now(),
      payload,
    };
    this.snap.items.push(item);
    if (this.snap.items.length > this.opt.maxItems) {
      // Keep the newest data if the device has been offline for an extreme time.
      this.snap.items.splice(0, this.snap.items.length - this.opt.maxItems);
    }
    await this.storage.save(this.snap);
    return item;
  }

  /** Continue sequence numbering for a stream (e.g. after reinstall, from the server). */
  async setNextSeq(stream: string, lastSeq: number): Promise<void> {
    await this.init();
    this.snap.nextSeq[stream] = Math.max(this.snap.nextSeq[stream] ?? 0, lastSeq);
    await this.storage.save(this.snap);
  }

  /** Sends everything that is due, oldest first. Returns the number acknowledged. */
  flush(send: Sender<T>, force = false): Promise<number> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush(send, force).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(send: Sender<T>, force: boolean): Promise<number> {
    await this.init();
    if (!force && this.now() < this.snap.nextAttemptAt) return 0;
    let acked = 0;
    while (this.snap.items.length > 0) {
      const batch = this.snap.items.slice(0, this.opt.maxBatch);
      let res: SendResult;
      try {
        res = await send(batch);
      } catch {
        this.snap.failures += 1;
        const backoff = Math.min(
          this.opt.maxBackoffMs,
          this.opt.baseBackoffMs * 2 ** (this.snap.failures - 1),
        );
        this.snap.nextAttemptAt = this.now() + backoff;
        await this.storage.save(this.snap);
        return acked;
      }
      const ok = new Set(res.acknowledged);
      const before = this.snap.items.length;
      this.snap.items = this.snap.items.filter((i) => !ok.has(i.id));
      const removed = before - this.snap.items.length;
      acked += removed;
      this.snap.failures = 0;
      this.snap.nextAttemptAt = 0;
      await this.storage.save(this.snap);
      if (removed === 0) break; // server accepted nothing: avoid a hot loop
    }
    return acked;
  }
}

export class MemoryQueueStorage<T> implements QueueStorage<T> {
  private data: string | null = null;
  async load(): Promise<QueueSnapshot<T> | null> {
    return this.data ? (JSON.parse(this.data) as QueueSnapshot<T>) : null;
  }
  async save(s: QueueSnapshot<T>): Promise<void> {
    this.data = JSON.stringify(s);
  }
}
