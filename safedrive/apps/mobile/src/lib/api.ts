/**
 * Mobile API client. The refresh token is kept in the OS keystore (expo-secure-store);
 * the short-lived access token stays in memory.
 */
import * as SecureStore from 'expo-secure-store';
import { type LiveTripView } from '@safedrive/core';
import { API_URL } from './config';
import { type TripApi, type UploadPoint } from './trip-controller';

export interface User {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  isSystemAdmin: boolean;
}

let access: string | null = null;
let refreshing: Promise<boolean> | null = null;
const REFRESH_KEY = 'sd.refresh';

export async function saveSession(s: { accessToken: string; refreshToken: string }): Promise<void> {
  access = s.accessToken;
  await SecureStore.setItemAsync(REFRESH_KEY, s.refreshToken);
}

export async function clearSession(): Promise<void> {
  access = null;
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}

export async function restoreSession(): Promise<boolean> {
  return refresh();
}

async function refresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const token = await SecureStore.getItemAsync(REFRESH_KEY);
      if (!token) return false;
      try {
        const r = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: token }),
        });
        if (r.status === 401) {
          await clearSession();
          return false;
        }
        if (!r.ok) return false;
        await saveSession((await r.json()) as { accessToken: string; refreshToken: string });
        return true;
      } catch {
        return false; // offline: keep the stored token for later
      }
    })().finally(() => setTimeout(() => (refreshing = null), 0));
  }
  return refreshing;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function call<T>(path: string, method = 'GET', body?: unknown, retry = true): Promise<T> {
  if (!access && retry) await refresh();
  const r = await fetch(`${API_URL}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(access ? { Authorization: `Bearer ${access}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && retry && (await refresh())) return call<T>(path, method, body, false);
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new HttpError(r.status, data?.message ?? `HTTP ${r.status}`);
  return data as T;
}

export const tripApi: TripApi = {
  startTrip: (input) => call<LiveTripView>('/trips/start', 'POST', input),
  stopTrip: (id) => call(`/trips/${id}/stop`, 'POST', {}),
  upload: (tripId, points: UploadPoint[]) => call(`/trips/${tripId}/telemetry`, 'POST', { points }),
  reportEvent: (tripId, e) => call(`/trips/${tripId}/events`, 'POST', e),
  sos: (input) => call('/sos', 'POST', input),
  activeTrip: () => call('/me/active-trip'),
  respondMonitoring: (id, status) => call(`/monitoring-requests/${id}/respond`, 'POST', { status }),
};
