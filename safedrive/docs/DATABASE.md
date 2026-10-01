# Database

PostgreSQL 16. The schema is in `database/migrations/*.sql`. Migrations are applied in name order by the API at start-up, or with `npm run db:migrate`. Each migration runs in a transaction, under an advisory lock, and is tracked in `schema_migrations`.

## Tables

| Area | Table | Notes |
|---|---|---|
| Identity | `users` | email unique (case-insensitive, among non-deleted rows); scrypt hash; lockout counters; `is_system_admin`; status `active/suspended`. |
| | `device_sessions` | Refresh-token sessions, stored as a hash only. `chain_id` allows the whole chain to be revoked on reuse. |
| Family | `families` | `country_code`, `timezone` (default Asia/Jerusalem), `is_demo`. |
| | `family_members` | role PARENT/DRIVER; at most one active membership per user per family. |
| | `drivers` | Driver profile linked to a member; `consent_at` + `consent_version` (required); cached `safety_score`. |
| | `family_invites` | Single-use codes, stored as a hash, with expiry. |
| Devices | `devices`, `permissions` | Platform, push token, honest `capabilities` JSON, permission status history (audited). |
| Monitoring | `monitoring_requests` | REQUESTED → PENDING → ACTIVE, or DECLINED / PERMISSION_REQUIRED / UNAVAILABLE / EXPIRED. |
| Trips | `trips` | `engine_state` JSON (persisted speeding tracker and motion state), `live` JSON (last live view), `is_demo`, summary columns. Partial unique index: one live trip per driver. |
| | `telemetry_points` | **Partitioned by month** on `recorded_at` (plus a default partition). PK `(trip_id, seq, recorded_at)` makes uploads idempotent. `source` gps/simulated; `limit_kmh`, `limit_source`. |
| Roads | `road_segments`, `speed_limits`, `provider_cache` | Speed-limit cache by cell + heading bucket, with expiry; negative entries for "no data". |
| Safety | `safety_events` | Typed events (SPEEDING, HARD_BRAKING, SOS, PHONE_USAGE…), `dedupe_key` unique per trip. |
| | `speeding_events` | Aggregated episode: start/end, duration, max speed, max excess (km/h and %), peak severity, escalations, road, start/end location. At most one OPEN per trip. |
| | `safety_scores` | Score history: per trip (with the breakdown JSON) and the driver's rolling score (no breakdown). |
| Notifications | `notifications` | Unique `(recipient_id, dedupe_key)`. This is also the **push outbox** (`push_status`, `push_attempts`, `next_attempt_at`). |
| | `notification_preferences` | Per user and family, as `prefs` JSON: minimum severity and disabled types (SOS can never be disabled). |
| SOS | `emergency_contacts`, `sos_events` | `client_id` unique (offline retries); status OPEN → ACKNOWLEDGED → RESOLVED. |
| Ops | `audit_logs`, `app_config`, `provider_usage` | Audit of sensitive actions; global safety config and retention overrides; provider calls, errors and latency per day. |

## Retention (IL defaults, overridable globally in `app_config` key `retention`: `rawTelemetryDays`, `tripSummaryDays`, `auditLogDays`, `notificationDays`; per-country profiles are not applied yet)
- Raw telemetry: **30 days**. The maintenance worker deletes old rows. Monthly partitions make it possible to drop a whole month at once.
- Trip summaries, speeding/safety events, scores and SOS: **365 days**. The whole trip is then deleted.
- Audit log: **730 days**.
- Notifications: 180 days.
- Expired sessions: 30 days after expiry.

## Account deletion
`DELETE /me` (password required):
- Deletes all raw telemetry of the user's drivers.
- Strips locations from trips, events, speeding events and SOS, and from the coordinates in other members' notifications about this driver. The anonymous aggregates stay for the family's history.
- Removes the driver profile and family memberships, and revokes devices and sessions.
- Anonymises the user row.

This is covered by a test.

## Scaling notes
- Hot paths are indexed: `trips(driver_id, started_at)`, `telemetry(trip_id, recorded_at)`, `notifications(recipient_id, created_at)`, and the push queue partial index.
- Telemetry volume is roughly 1 row/s per driving driver. Monthly partitions plus 30-day retention keep it bounded. At very large scale, consider TimescaleDB or a columnar archive for raw points.
