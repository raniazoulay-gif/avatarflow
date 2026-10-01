# Architecture

```
 Driver phone (Expo)                       Backend (Fastify, Node 22)                 Parent
 ┌──────────────────────┐   HTTPS (JWT)   ┌────────────────────────────────┐  WS   ┌──────────────┐
 │ Background location  │ ─────────────▶  │ /trips/:id/telemetry           │ ────▶ │ Web dashboard│
 │ TripController       │  batches, idem- │  ├ SpeedLimitService (cache →  │       │ (React/RTL)  │
 │  ├ OutboundQueue     │  potent (seq)   │  │   DB → OSM/HERE/TomTom)     │       └──────────────┘
 │  │  (AsyncStorage)   │                 │  ├ SpeedingTracker (core)      │  push ┌──────────────┐
 │  ├ adaptive plan     │ ◀── live view ─ │  ├ Motion detector (core)      │ ────▶ │ Parent phone │
 │  └ SOS (persisted)   │                 │  ├ Notifications (rules core)  │       └──────────────┘
 └──────────────────────┘                 │  └ Realtime bus (memory/Redis) │
                                          │ Workers: push outbox, offline, │
                                          │ auto-end, partitions/retention │
                                          └───────────────┬────────────────┘
                                                          │
                                                 PostgreSQL 16 (+ Redis optional)
```

## Principles
- **One engine, three runtimes.**
  - `packages/core` holds all safety logic as pure, deterministic functions with no I/O: the speed math, the 10-second tracker, motion detection, scoring, trip-state machine, telemetry policy, offline queue, notification rules, i18n and demo scenarios.
  - The server runs it authoritatively. The mobile app uses the same queue, policy and state machine.
- **The server is authoritative for violations.**
  - The phone only sends raw fixes. Speed limits are resolved on the server, so the phone's battery and data plan are spared and the rules can't be bypassed on the device.
  - The tracker state is stored per trip (`trips.engine_state`, JSON). Consequences:
    - A restart or a second API instance continues the same 10-second window.
    - Uploads for a trip are serialised with `SELECT … FOR UPDATE` on the trip row.
- **Idempotency everywhere.**
  - Telemetry has primary key `(trip_id, seq, recorded_at)` and uses `ON CONFLICT DO NOTHING`. The response tells the client which points were accepted and which were duplicates.
  - Other dedupe mechanisms:

    | What | Dedupe |
    |---|---|
    | Safety events | `dedupe_key` |
    | Notifications | `(recipient, dedupe_key)` |
    | SOS | `client_id` |
    | Open speeding event | at most one per trip, enforced by a partial unique index |
- **Late data.**
  - Device timestamps are kept. A batch synced after an outage is processed in order.
  - Points that arrive after the trip ended are stored but do not trigger live alerts.
- **Degrade, never invent.** When the provider fails or times out, the limit becomes "unavailable" (and is cached negatively). It is never guessed from neighbouring roads.

## Speed-limit resolution
1. **In-memory LRU** by cell (~33 m grid) and heading bucket.
2. **Database** `speed_limits` cache (30-day TTL; 24-hour negative TTL).
3. **Road-geometry reuse**: while the car stays within 15 m of the matched OSM way, there are no new provider calls. On the same road, the limit refreshes every 120 s.
4. **Provider chain**: `SPEED_LIMIT_PROVIDERS`, default `osm`, optionally `here` and `tomtom`.
   - Lookups are throttled to every 100 m or 30 s, or happen immediately when leaving the matched road.
   - Calls are counted in `provider_usage`.

## Realtime
- `GET /ws`. The first message must authenticate with an access token.
- The socket then subscribes only to the user's own channel and the channels of the families where the user is a PARENT. Every 30 s the socket re-checks the session (closing it when revoked) and the family list (unsubscribing families the user was removed from).
- Events: `trip.update` (live view), `trip.started`, `trip.ended`, `notification`, `sos`, `sos.status`.
- With `REDIS_URL` set, events go over Redis pub/sub so several API instances can be used. Otherwise the bus is in-memory, which supports a single instance only.

## Notifications
1. Rules from the core decide:
   - preferences (minimum severity, muted types)
   - dedupe
   - cooldown
   - sound from WARNING up
   - SOS can never be muted
2. The notification row is written.
3. The realtime event is published.
4. A row is added to the push outbox. A worker sends it every 2 s with `FOR UPDATE SKIP LOCKED` and exponential retry. Invalid tokens are removed.

## Workers (in the API process; `WORKERS_ENABLED`)

| Job | Interval |
|---|---|
| Push outbox | 2 s |
| Offline detection | 15 s (notifies once when a live trip goes silent for 90 s) |
| Auto-end silent trips | 60 s (30 min) |
| Maintenance: monthly telemetry partitions + retention | 6 h |

## Mobile
- `TripController` (pure TS, tested) orchestrates:
  - permission check
  - trip start
  - each fix → enqueue → upload when due (30 points, or 10 s; 2 s while speeding)
  - offline stop/SOS persisted
  - `resume()` after a restart, which reads `/me/active-trip` and continues the sequence
- `location.ts` wires expo-location with a TaskManager task, defined at module load so headless restarts work.
  - Android uses a foreground service with a visible notification.
  - iOS uses `showsBackgroundLocationIndicator`.
- The adaptive plan from `planTelemetry` changes the sampling interval and distance by movement class, background state and battery. Low-battery thinning is never applied while speeding (the background factor still is).

## Trip state machine (core `trip-state.ts`)
`IDLE → STARTING → ACTIVE ⇄ ATTENTION/WARNING/CRITICAL`

Further states:
- `SPEED_LIMIT_UNAVAILABLE`
- `LOCATION_UNAVAILABLE`
- `OFFLINE`
- `SOS`
- `ENDING → ENDED`
- `PERMISSION_REQUIRED`
- `REMOTE_MONITORING_REQUESTED/ACTIVE`

Transitions are explicit and invalid ones are rejected. The same machine is used on the device and on the server.
