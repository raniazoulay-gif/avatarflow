/**
 * Native wiring of the TripController:
 *  - background location through expo-location + expo-task-manager (Android foreground
 *    service with a persistent, visible notification; iOS blue location indicator);
 *  - durable queue in AsyncStorage, connectivity from NetInfo, battery from expo-battery.
 *
 * This module is imported from index.ts so the task is defined even when the OS starts
 * the JS runtime headlessly to deliver locations.
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import * as Crypto from 'expo-crypto';
import NetInfo from '@react-native-community/netinfo';
import { AppState, Platform } from 'react-native';
import { OutboundQueue, type TelemetryPlan } from '@safedrive/core';
import { tripApi } from './api';
import { AsyncQueueStorage, kv } from './storage';
import {
  TripController,
  type Fix,
  type LocationSource,
  type PermissionLevel,
  type UploadPoint,
} from './trip-controller';

export const LOCATION_TASK = 'safedrive-trip-location';

let online = true;
let battery: { level: number | null; charging: boolean } = { level: null, charging: false };
let appState = AppState.currentState;

async function readPermission(): Promise<PermissionLevel> {
  const fg = await Location.getForegroundPermissionsAsync();
  if (fg.status === 'undetermined') return 'undetermined';
  if (fg.status !== 'granted') return 'denied';
  const bg = await Location.getBackgroundPermissionsAsync();
  return bg.status === 'granted' ? 'background' : 'foreground';
}

const nativeLocation: LocationSource = {
  permission: readPermission,
  async requestPermission() {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return fg.canAskAgain ? 'undetermined' : 'denied';
    // Background is requested separately (OS rule). Declining it still allows
    // foreground-only monitoring, which the UI reports honestly.
    const bg = await Location.requestBackgroundPermissionsAsync().catch(() => null);
    return bg?.status === 'granted' ? 'background' : 'foreground';
  },
  async start(plan: TelemetryPlan) {
    // Already running (e.g. resumed by a headless start): keep it. Restarting the
    // foreground service from the background is refused on Android 12+.
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
    await startUpdates(plan);
  },
  async updatePlan(plan: TelemetryPlan) {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await startUpdates(plan);
  },
  async stop() {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK))
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  },
};

async function startUpdates(plan: TelemetryPlan): Promise<void> {
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: plan.sampleMs,
    distanceInterval: plan.distanceFilterM,
    deferredUpdatesInterval: plan.sampleMs,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'SafeDrive - ניטור נסיעה פעיל',
      notificationBody:
        'המיקום והמהירות משותפים עם המשפחה עד סיום הנסיעה. Trip monitoring is active.',
      killServiceOnDestroy: false,
    },
  });
}

export const controller = new TripController({
  api: tripApi,
  location: nativeLocation,
  queue: new OutboundQueue<UploadPoint>(new AsyncQueueStorage<UploadPoint>(), {
    maxItems: 20_000,
    idFactory: () => Crypto.randomUUID(),
  }),
  store: kv,
  isOnline: () => online,
  battery: () => battery,
  isBackground: () => appState !== 'active',
  now: () => Date.now(),
  uuid: () => Crypto.randomUUID(),
});

function toFix(l: Location.LocationObject): Fix {
  const c = l.coords;
  return {
    t: l.timestamp,
    lat: c.latitude,
    lon: c.longitude,
    altitudeM: c.altitude ?? null,
    // The OS reports -1 when speed/heading are unknown.
    speedMs: c.speed !== null && c.speed >= 0 ? c.speed : null,
    headingDeg: c.heading !== null && c.heading >= 0 ? c.heading : null,
    accuracyM: c.accuracy ?? null,
  };
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(
  LOCATION_TASK,
  async ({ data, error }) => {
    if (error) {
      await controller.report('GPS_UNAVAILABLE', { message: error.message.slice(0, 200) });
      return;
    }
    if (!controller.snapshot.tripId) {
      // Headless start after the app was killed: restore the live trip first (single-flight;
      // it releases the GPS itself when there is no live trip any more).
      await controller.resume().catch(() => undefined);
    }
    for (const l of data?.locations ?? []) await controller.onFix(toFix(l));
  },
);

let wired = false;
/** Subscribes to connectivity / battery / app-state once (also in headless starts). */
export function wireEnvironment(): void {
  if (wired) return;
  wired = true;
  void NetInfo.fetch()
    .then((s) => (online = s.isConnected !== false && s.isInternetReachable !== false))
    .catch(() => undefined);
  // Retry pending uploads / stop / SOS even when nothing else wakes the app up.
  setInterval(() => {
    if (online && controller.hasPendingWork) void controller.sync();
  }, 30_000);
  NetInfo.addEventListener((s) => {
    const was = online;
    online = s.isConnected !== false && s.isInternetReachable !== false;
    if (online && !was) void controller.sync();
  });
  void Battery.getPowerStateAsync()
    .then((p) => {
      battery = {
        level: p.batteryLevel >= 0 ? p.batteryLevel : null,
        charging:
          p.batteryState === Battery.BatteryState.CHARGING ||
          p.batteryState === Battery.BatteryState.FULL,
      };
    })
    .catch(() => undefined);
  Battery.addBatteryLevelListener(
    ({ batteryLevel }) =>
      (battery = { ...battery, level: batteryLevel >= 0 ? batteryLevel : null }),
  );
  Battery.addBatteryStateListener(
    ({ batteryState }) =>
      (battery = {
        ...battery,
        charging:
          batteryState === Battery.BatteryState.CHARGING ||
          batteryState === Battery.BatteryState.FULL,
      }),
  );
  AppState.addEventListener('change', (s) => {
    appState = s;
    if (s === 'active') void controller.sync();
  });
}

export const platform = Platform.OS === 'ios' ? 'ios' : 'android';

wireEnvironment();
