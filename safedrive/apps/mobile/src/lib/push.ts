/**
 * Push notifications (Expo push service). Registration needs a real device and an EAS
 * projectId (app.json extra.eas.projectId) - see docs/PROVIDER_INTEGRATIONS.md.
 * Without them the device registers with pushToken = null and parents still get
 * in-app + realtime notifications.
 */
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { call } from './api';
import { kv } from './storage';
import { phoneUsageCapabilities } from './phone-usage';
import { type PermissionLevel } from './trip-controller';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', { name: 'כללי', importance: Notifications.AndroidImportance.DEFAULT });
  await Notifications.setNotificationChannelAsync('alerts', { name: 'התראות מהירות', importance: Notifications.AndroidImportance.HIGH });
  await Notifications.setNotificationChannelAsync('critical', {
    name: 'SOS וחריגות קריטיות',
    importance: Notifications.AndroidImportance.MAX,
    bypassDnd: false,
    vibrationPattern: [0, 400, 200, 400],
  });
}

async function pushToken(): Promise<{ token: string | null; status: string }> {
  const perm = await Notifications.getPermissionsAsync();
  let status = perm.status;
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { token: null, status: 'denied' };
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!Device.isDevice || !projectId || projectId.startsWith('REPLACE')) return { token: null, status: 'granted' };
  try {
    return { token: (await Notifications.getExpoPushTokenAsync({ projectId })).data, status: 'granted' };
  } catch {
    return { token: null, status: 'granted' };
  }
}

const K_DEVICE = 'sd.deviceId';

/** Registers (or refreshes) this device with its permissions and honest capability flags. */
export async function registerDevice(location: PermissionLevel): Promise<string | null> {
  await ensureChannels();
  const push = await pushToken();
  const body = {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    model: Device.modelName ?? undefined,
    appVersion: Constants.expoConfig?.version ?? undefined,
    pushToken: push.token,
    ...(push.token ? { pushProvider: 'expo' } : {}),
    capabilities: { ...phoneUsageCapabilities(), backgroundLocation: location === 'background' },
    permissions: {
      location_foreground: location === 'background' || location === 'foreground' ? 'granted' : location,
      location_background: location === 'background' ? 'granted' : location === 'undetermined' ? 'undetermined' : 'denied',
      notifications: push.status === 'granted' ? 'granted' : 'denied',
    },
  };
  const existing = await kv.get(K_DEVICE);
  try {
    if (existing) {
      await call(`/devices/${existing}`, 'PATCH', body);
      return existing;
    }
  } catch {
    // device revoked or unknown: register again below
  }
  try {
    const r = await call<{ id: string }>('/devices', 'POST', body);
    await kv.set(K_DEVICE, r.id);
    return r.id;
  } catch {
    return existing;
  }
}

export function onNotificationTap(fn: (data: Record<string, unknown>) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) => fn((r.notification.request.content.data ?? {}) as Record<string, unknown>));
  return () => sub.remove();
}
