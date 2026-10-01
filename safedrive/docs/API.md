# API

Base URL: `http://localhost:4000` (dev). JSON over HTTPS.

- **Auth:** `Authorization: Bearer ACCESS_TOKEN`. The access token is a JWT (HS256) valid for 15 minutes. The refresh token is opaque and rotated on every use.
- **Errors:** `{ "error": "code", "message": "…" }` with these codes:

  | Status | Meaning |
  |---|---|
  | 400 | bad request |
  | 401 | unauthorized |
  | 403 | forbidden |
  | 404 | not found, also used for resources of other families so their existence doesn't leak |
  | 409 | conflict |
  | 429 | `too_many_requests` |

- **Rate limits:** 300/min per IP globally; auth and invite acceptance 10/min; SOS 20/min; monitoring requests 10/min.

## Auth & account
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | `{email, password, displayName, locale?}` → tokens + user. Password ≥ 10 chars with letters and digits. |
| POST | `/auth/login` | `{email, password, deviceId?}`. Locks the account after repeated failures. |
| POST | `/auth/refresh` | `{refreshToken}` → new pair. Reusing an old token revokes the whole chain. |
| POST | `/auth/logout`, `/auth/logout-all` | |
| GET / PATCH / DELETE | `/me` | Profile + families; update name/locale; delete the account (password required). |

## Families
| Method | Path | Who |
|---|---|---|
| POST | `/families` | Any user → becomes PARENT |
| GET | `/families`, `/families/:id` | Members |
| POST | `/families/:id/invites` | PARENT. `{role, displayName}` → single-use code |
| POST | `/invites/accept` | `{code, consent}`. Drivers **must** send `consent: true` |
| DELETE | `/families/:id/members/:memberId` | PARENT |
| GET | `/families/:id/live` | PARENT. Live view of all active trips |
| GET | `/families/:id/drivers` | PARENT. Drivers with score, active trip, devices and capabilities |
| GET | `/families/:id/sos` | PARENT |
| GET / POST / DELETE | `/families/:id/emergency-contacts[/:contactId]` | Members read, PARENT writes |
| GET / PUT | `/families/:id/notification-preferences` | Self |

## Drivers & monitoring
| Method | Path | Notes |
|---|---|---|
| GET | `/drivers/:id`, `/drivers/:id/trips?before&limit&includeDemo` | Family members |
| POST | `/drivers/:id/monitoring-requests` | PARENT asks; the driver is notified and must accept on the phone |
| GET | `/me/monitoring-requests` | Driver's pending requests |
| POST | `/monitoring-requests/:id/respond` | `{status: DECLINED/PERMISSION_REQUIRED/UNAVAILABLE/PENDING}` |

## Trips & telemetry
| Method | Path | Notes |
|---|---|---|
| POST | `/trips/start` | `{driverId, deviceId?, monitoringRequestId?, isDemo?}` (the driver themself) → live view |
| POST | `/trips/:id/telemetry` | `{points: [...]}` up to 500 per batch. Each point: `{id (uuid), seq ≥1, recordedAt, lat, lon, altitudeM?, speedMs?, headingDeg?, accuracyM?, source?, simulatedLimitKmh?}`. Response: `{accepted: [ids], duplicates: [ids], live}`. `simulated` points and `simulatedLimitKmh` are rejected on non-demo trips. |
| POST | `/trips/:id/events` | Device events `PHONE_USAGE/GPS_UNAVAILABLE/PERMISSION_PROBLEM/CONNECTIVITY_LOSS`, deduplicated by `clientId` |
| POST | `/trips/:id/stop` | Driver or parent |
| GET | `/trips/:id` | Summary, speeding events, safety events, score breakdown |
| GET | `/trips/:id/points` | Route points with speed/limit/severity (replay and chart) |
| GET | `/me/active-trip` | Used by the app to resume after a restart (includes `lastSeq`) |

## Notifications & SOS
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications?unread&limit` | `{items, unread}` |
| POST | `/notifications/:id/read`, `/notifications/read-all` | |
| POST | `/sos` | `{clientId, driverId, tripId?, lat?, lon?, accuracyM?, speedMs?, triggeredAt?}`. Idempotent by `clientId` |
| POST | `/sos/:id/ack`, `/sos/:id/resolve` | PARENT |

## Devices
`POST /devices`, `PATCH /devices/:id`, `GET /me/devices`, `DELETE /devices/:id`. Body: `{platform, model?, appVersion?, pushToken?, pushProvider?, capabilities?, permissions?}`. Permission changes are audited.

## Demo (when `DEMO_MODE_ENABLED`)
`POST /demo/families` · `POST /demo/runs {driverId, scenarioId: full/short-burst/degraded/sos, speedFactor 1–20}` · `GET /demo/runs` · `POST /demo/runs/:id/cancel`

## Admin (system admins only)
`GET /admin/health`, `/admin/users[/:id]`, `POST /admin/users/:id/suspend|unsuspend`, `GET /admin/families[/:id]` (the view is audited), `/admin/trips/active`, `/admin/provider-usage`, `/admin/audit`, `GET /admin/config`, `PUT /admin/config/safety`

## System
- `GET /health` (liveness)
- `GET /health/ready` (DB + providers)
- `GET /metrics` (Prometheus, Bearer `METRICS_TOKEN`)
- `GET /config/client` (map tiles, thresholds, demo flag)

## Realtime – `GET /ws`
1. Send `{"type":"auth","token":"ACCESS_TOKEN"}` within 5 s.
2. You receive events `{type, data}`:
   - `trip.update`
   - `trip.started`
   - `trip.ended`
   - `notification`
   - `sos`
   - `sos.status`

   Only the user's own events and those of the user's families are delivered.
3. `{"type":"ping"}` → `pong`.
