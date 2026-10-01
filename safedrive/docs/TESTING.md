# Testing

| Suite | Command | Count | What it proves |
|---|---|---|---|
| Safety engine (unit) | `npm run test:unit` | 42 | Speed math and inclusive thresholds. The 10-second rule: 0–9 s no event, 10 s exactly one; reset when back at the limit; 5% over doesn't start the timer. Escalation once per level, no single-second spikes, end confirmation, unavailable/low-confidence limits ignored, bad GPS ignored, gaps break continuity, duplicates and out-of-order ignored, state survives JSON round-trips. Also: Safety Score determinism, caps and distance weighting; hard braking/acceleration; trip state machine; notification dedupe, cooldown and SOS-cannot-be-muted; adaptive telemetry; offline queue (order, restart, backoff, concurrent init); demo generator; Hebrew i18n. |
| API integration / E2E / failure | `npm run test:api` (PostgreSQL) | 58 | See below |
| Mobile controller | `cd apps/mobile && npm test` | 18 | START flow; permission denied; ordered upload; offline queue then sync with original timestamps; retries never duplicate; offline stop completed later; restart keeps the queue; offline SOS; adaptive plan. Regressions: double-tap START creates one trip; failed GPS start ends the trip; a stop survives a restart without restarting GPS; 4xx batches are dropped while 5xx batches are kept; 409 on stop completes it; concurrent SOS presses are both delivered; concurrent resume runs once and continues the sequence. Also the phone-usage capability layer. |
| Static | `npm run lint`, `npm run typecheck`, `npm run format:check` | — | ESLint (typescript-eslint, react-hooks), strict TS, Prettier |
| Build | `npm run build`; `npx expo export --platform android/ios` | — | API, web and Metro bundles for both platforms |

## API suites (`apps/api/test`)
- **acceptance.test.ts (8):** the end-to-end story over HTTP + WebSocket.
  1. The parent connects to the live channel.
  2. The driver starts; the parent is notified.
  3. 9 s of speeding creates nothing; 10 s creates exactly one ATTENTION event.
  4. WARNING and CRITICAL each produce one notification. The CRITICAL text is in Hebrew with sound.
  5. Slowing down closes the event with a full summary.
  6. The trip ends; summary, history and score are visible.
  7. SOS produces a critical alert, which the parent acknowledges.
  8. The push worker delivers.
- **security.test.ts (17):**
  - Isolation: 404 across families, no cross-trip uploads, driver vs parent role checks, realtime only to the right family, non-admins blocked.
  - Auth: bad tokens, password rules, refresh rotation with chain revocation, logout, lockout, consent and single-use invites, suspension ends sessions.
  - Telemetry: malformed or simulated data refused.
  - Abuse: the client can't set `isDemo`, `seq` can't be rewritten, late points after the end are refused, the provider lookup cap and jump guard work.
- **resilience.test.ts (20):**
  - Idempotent re-send; concurrent overlapping batches serialised; delayed sync keeps device time; late points after the end don't alert.
  - Limit unavailable leads to no violation; provider failure leads to "unavailable" and shows in health; inaccurate GPS leads to no violation; the cache prevents repeated calls.
  - Engine state survives a restart or another instance.
  - Offline driver detection, auto-end, retention, partitions, invalid push token removal.
  - Monitoring request lifecycle; mute ATTENTION but never SOS; phone-usage events and duplicates; account deletion.
- **providers.test.ts (10):** OSM maxspeed parsing (numeric, mph, IL implicit), heading-aware way matching, "no data" handling, geometry reuse, HTTP errors; HERE and TomTom parsing; cache keys; Expo push receipts.
- **demo.test.ts (3):** the full scenario through the real pipeline, labelled demo; the short burst produces no event; the degraded scenario survives network/GPS loss; demo runs only in demo families.

## Running locally
```bash
service postgresql start      # or docker compose up -d postgres
# role safedrive/safedrive and databases safedrive_test / safedrive_dev must exist
export TEST_DATABASE_URL=postgres://safedrive:safedrive@localhost:5432/safedrive_test
npm run test:unit && npm run test:api && (cd apps/mobile && npm test)
```

## What is NOT covered by automated tests (manual / device testing required)
- Background location on physical Android and iOS devices: screen off, navigation app in the foreground, OEM battery savers, app swiped away, phone reboot during a trip.
- Real push delivery through FCM/APNs (needs credentials).
- Live HERE/TomTom calls (needs keys), and Overpass coverage in specific Israeli areas.
- The 30-second WebSocket access re-check.
- Web UI flows. They were checked manually with Playwright screenshots during development; there is no committed browser E2E suite yet.
- Load testing: no benchmark has been run. The design (per-trip row lock, batched inserts, partitions, caching) targets thousands of concurrent drivers per API instance, but this is **not measured**.

## Device test checklist
1. **Start** a trip with "Always" location, open Waze, and drive 10 minutes. Expect a continuous route, alerts at the parent, and the persistent notification visible.
2. **Airplane mode** for 5 minutes mid-trip. Expect the points to sync afterwards, with no gaps in timestamps and no duplicates.
3. **Swipe the app away** mid-trip. Expect the trip to continue (Android foreground service; iOS relaunch) or the parent to get an "offline" alert.
4. **Deny background location.** Expect the warning in the app, and the parent sees `backgroundLocation: false`.
5. **SOS without network.** Expect the alert to be delivered when back online; the tap-to-call numbers open the dialer.
6. **Reboot** during a trip. On reopening the app it resumes or completes the trip, with no stuck "ENDING".
