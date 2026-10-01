import AsyncStorage from '@react-native-async-storage/async-storage';
import { type QueueItem, type QueueSnapshot, type QueueStorage } from '@safedrive/core';
import { type KeyValueStore } from './trip-controller';

export const kv: KeyValueStore = {
  get: (k) => AsyncStorage.getItem(k),
  set: (k, v) => AsyncStorage.setItem(k, v),
  remove: (k) => AsyncStorage.removeItem(k),
};

/** Items per stored chunk: keeps every AsyncStorage value far below Android's ~2 MB row limit. */
const CHUNK = 500;

/**
 * Durable telemetry queue: survives app kills and phone restarts. Stored in chunks so a
 * long offline period does not create one huge value, and only chunks that changed are
 * rewritten (appending a fix rewrites the last chunk only).
 */
export class AsyncQueueStorage<T> implements QueueStorage<T> {
  private written = new Map<string, string>();
  constructor(private readonly key = 'sd.telemetryQueue') {}

  async load(): Promise<QueueSnapshot<T> | null> {
    const metaRaw = await AsyncStorage.getItem(`${this.key}.meta`);
    if (!metaRaw) return null;
    const meta = JSON.parse(metaRaw) as Omit<QueueSnapshot<T>, 'items'> & { chunks: number };
    const keys = Array.from({ length: meta.chunks }, (_, i) => `${this.key}.${i}`);
    const pairs = keys.length ? await AsyncStorage.multiGet(keys) : [];
    const items: QueueItem<T>[] = [];
    for (const [k, v] of pairs) {
      if (!v) continue;
      this.written.set(k, v);
      items.push(...(JSON.parse(v) as QueueItem<T>[]));
    }
    const { chunks: _c, ...rest } = meta;
    return { ...rest, items };
  }

  async save(s: QueueSnapshot<T>): Promise<void> {
    const { items, ...rest } = s;
    const chunks = Math.ceil(items.length / CHUNK);
    const changed: [string, string][] = [];
    for (let i = 0; i < chunks; i++) {
      const k = `${this.key}.${i}`;
      const v = JSON.stringify(items.slice(i * CHUNK, (i + 1) * CHUNK));
      if (this.written.get(k) !== v) changed.push([k, v]);
    }
    const stale = [...this.written.keys()].filter(
      (k) => Number(k.slice(this.key.length + 1)) >= chunks,
    );
    // Meta first: after a crash in between, at worst the newest chunk is missing (skipped on load).
    await AsyncStorage.setItem(`${this.key}.meta`, JSON.stringify({ ...rest, chunks }));
    if (changed.length) await AsyncStorage.multiSet(changed);
    for (const [k, v] of changed) this.written.set(k, v);
    if (stale.length) {
      await AsyncStorage.multiRemove(stale);
      for (const k of stale) this.written.delete(k);
    }
  }
}
