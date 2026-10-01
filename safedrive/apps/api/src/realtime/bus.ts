/**
 * Pub/sub between API instances and WebSocket clients. In-memory for a single
 * instance; Redis pub/sub when REDIS_URL is set (horizontal scaling).
 */
import { EventEmitter } from 'node:events';

export interface RealtimeMessage {
  type: string;
  data: unknown;
}

export interface RealtimeBus {
  publish(channel: string, msg: RealtimeMessage): Promise<void>;
  subscribe(channel: string, fn: (msg: RealtimeMessage) => void): () => void;
  close(): Promise<void>;
  readonly kind: string;
}

export class MemoryBus implements RealtimeBus {
  readonly kind = 'memory';
  private readonly ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(0);
  }
  async publish(channel: string, msg: RealtimeMessage): Promise<void> {
    this.ee.emit(channel, msg);
  }
  subscribe(channel: string, fn: (msg: RealtimeMessage) => void): () => void {
    this.ee.on(channel, fn);
    return () => this.ee.off(channel, fn);
  }
  async close(): Promise<void> {
    this.ee.removeAllListeners();
  }
}

export async function createRedisBus(url: string): Promise<RealtimeBus> {
  const { Redis } = await import('ioredis');
  const pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  const sub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  const local = new MemoryBus();
  const counts = new Map<string, number>();
  sub.on('message', (channel: string, raw: string) => {
    try {
      void local.publish(channel, JSON.parse(raw) as RealtimeMessage);
    } catch {
      /* ignore malformed */
    }
  });
  return {
    kind: 'redis',
    async publish(channel, msg) {
      await pub.publish(channel, JSON.stringify(msg));
    },
    subscribe(channel, fn) {
      const n = counts.get(channel) ?? 0;
      if (n === 0) void sub.subscribe(channel);
      counts.set(channel, n + 1);
      const off = local.subscribe(channel, fn);
      return () => {
        off();
        const left = (counts.get(channel) ?? 1) - 1;
        counts.set(channel, left);
        if (left === 0) void sub.unsubscribe(channel);
      };
    },
    async close() {
      pub.disconnect();
      sub.disconnect();
    },
  };
}

export const familyChannel = (familyId: string): string => `family:${familyId}`;
export const userChannel = (userId: string): string => `user:${userId}`;
