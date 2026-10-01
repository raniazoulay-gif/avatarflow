# Mobile permissions & platform capabilities

## Permissions requested
| Permission | Platform | When | Why | If denied |
|---|---|---|---|---|
| Location "While using" | iOS / Android (`ACCESS_FINE_LOCATION`) | First START DRIVING | Speed and position during the trip | No trip can start. State `PERMISSION_REQUIRED`. A parent's monitoring request is answered `PERMISSION_REQUIRED`. |
| Location "Always" / background | iOS (`NSLocationAlwaysAndWhenInUseUsageDescription`) / Android (`ACCESS_BACKGROUND_LOCATION`) | Right after foreground is granted | Keeps monitoring while a navigation app is open or the screen is off | Foreground-only monitoring. The app shows a warning and the parent sees `backgroundLocation: false`. |
| Foreground service (location) | Android (`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`) | During a trip | Android requires a visible notification for background location | — |
| Notifications | iOS / Android 13+ (`POST_NOTIFICATIONS`) | After sign-in | Parent alerts, monitoring requests | In-app and realtime only |

Usage descriptions are bilingual (Hebrew/English) in `apps/mobile/app.json`.

## Visible-monitoring guarantees
- **Android:** a persistent foreground-service notification for the whole trip ("SafeDrive - ניטור נסיעה פעיל").
- **iOS:** `showsBackgroundLocationIndicator: true`, so the blue status-bar indicator is shown.
- **In app:** a banner reads "the family sees this trip". Ending the trip takes a long press (to avoid accidental taps).

## Capability matrix
| Capability | Android | iOS | Status |
|---|---|---|---|
| GPS speed/position in foreground | ✔ | ✔ | Implemented |
| Background location during a trip | ✔ (foreground service) | ✔ (background mode `location`) | Implemented in code. Needs a development/production build and a real-device test. |
| Continue after app is swiped away | Usually (foreground service). OEM battery savers may kill it. | iOS relaunches for location events with "Always". | Partially supported (OS dependent) |
| Adaptive sampling (movement, battery) | ✔ | ✔ | Implemented |
| Offline queue + sync | ✔ | ✔ | Implemented (chunked AsyncStorage, 20,000 points max) |
| Push notifications | ✔ (FCM via Expo) | ✔ (APNs via Expo) | Requires external configuration (EAS projectId, FCM key, APNs key) |
| Detect interaction with SafeDrive while moving | ✔ | ✔ | Implemented |
| Detect use of other apps | Needs UsageStats special access + native module | Not possible for third-party apps | Android: Requires external configuration (not built). iOS: Platform restricted. |
| Detect typing, calls, messaging in other apps | ✗ | ✗ | Platform restricted |
| Block the phone while driving | ✗ (only with device-owner/MDM) | ✗ (only Apple's Driving Focus) | Unavailable (not attempted) |
| Read Waze/Google Maps data | ✗ | ✗ | Unavailable by design (deep links only) |
| Place emergency calls automatically | Technically restricted, and not wanted | ✗ | Not implemented on purpose. Tap-to-call only. |
| RTL layout | ✔ | ✔ | Forced natively from first launch (expo-localization plugin) |

## Testing permissions
1. **Android emulator:** use Settings → Location, or `adb shell appops`, to toggle permissions. Simulate driving with an emulator route (Extended controls → Location → Routes).
2. **iOS simulator:** Features → Location → "Freeway Drive".
3. Background behaviour must be verified on physical devices, because OEM battery optimisation differs (Samsung, Xiaomi, Huawei). See [TESTING.md](TESTING.md).
