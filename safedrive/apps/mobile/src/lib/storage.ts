import AsyncStorage from '@react-native-async-storage/async-storage';
import { type QueueSnapshot, type QueueStorage } from '@safedrive/core';
import { type KeyValueStore } from './trip-controller';

export const kv: KeyValueStore = {
  get: (k) => AsyncStorage.getItem(k),
  set: (k, v) => AsyncStorage.setItem(k, v),
  remove: (k) => AsyncStorage.removeItem(k),
};

/** Durable telemetry queue: survives app kills and phone restarts. */
export class AsyncQueueStorage<T> implements QueueStorage<T> {
  constructor(private readonly key = 'sd.telemetryQueue') {}
  async load(): Promise<QueueSnapshot<T> | null> {
    const raw = await AsyncStorage.getItem(this.key);
    return raw ? (JSON.parse(raw) as QueueSnapshot<T>) : null;
  }
  async save(s: QueueSnapshot<T>): Promise<void> {
    await AsyncStorage.setItem(this.key, JSON.stringify(s));
  }
}
