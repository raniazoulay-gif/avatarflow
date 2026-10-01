# Provider integrations

All external services sit behind interfaces, so they can be replaced without touching the safety engine.

## Speed limits – `SpeedLimitProvider` (`apps/api/src/providers/speed-limit/`)
Order of resolution: memory LRU → `speed_limits` DB cache → road-geometry reuse → providers in `SPEED_LIMIT_PROVIDERS` order. The first provider with a confident answer wins; failures fall through to the next.

| Provider | Id | Status | Needs | Notes |
|---|---|---|---|---|
| OpenStreetMap via Overpass | `osm` | **Implemented, coverage varies** | Nothing for the public endpoint. For production, a self-hosted Overpass or a commercial Overpass host. | Parses `maxspeed` including mph and Israeli implicit values (`IL:urban` 50, `IL:rural` 80, `IL:motorway` 110, at lower confidence than explicit signs). Picks the nearest road within 30 m aligned with the heading. When the matched road has no `maxspeed`, the answer is **unavailable**; a neighbour's value is never borrowed. The public endpoint is rate-limited (`OVERPASS_MIN_INTERVAL_MS`, 1.1 s). |
| HERE Routing v8 (`spans=speedLimit`) | `here` | **Requires external configuration** | `HERE_API_KEY` and a HERE contract | The adapter is implemented and unit-tested with mocked responses in the documented format. It has not been called live from this environment. |
| TomTom Reverse Geocoding (`returnSpeedLimit`) | `tomtom` | **Requires external configuration** | `TOMTOM_API_KEY` and a TomTom contract | Same as HERE: unit-tested, not exercised live here. |
| Demo | (internal) | Implemented | — | Only for `is_demo` trips: each simulated point carries its limit. |

Licensing: OSM data is ODbL. Show "© OpenStreetMap contributors" (already in the web UI), and do not resell raw extracts. Read the HERE and TomTom terms on caching duration before raising `SPEED_LIMIT_CACHE_TTL_DAYS`.

**Never used:** Waze or Google Maps data. Their terms forbid scraping or using it to build a competing dataset. SafeDrive does not reverse-engineer private APIs.

Cost and usage control:
- Lookups at most every 100 m / 30 s per trip, or immediately when leaving the matched road; no call while on the same matched road (refresh every 120 s).
- Cache by ~33 m cell × heading bucket; 30-day TTL; 24 h negative TTL.
- At most 20 lookups per uploaded batch; no lookups for impossible jumps.
- `provider_usage` table plus the admin "Providers" page: calls, errors and average latency per provider per day.

## Push notifications – `PushNotificationProvider` (`apps/api/src/providers/push/`)
| Provider | `PUSH_PROVIDER` | Status |
|---|---|---|
| Log (development) | `log` | Implemented |
| Expo Push Service → FCM / APNs | `expo` | **Requires external configuration**: an EAS project (`extra.eas.projectId` in `app.json`), FCM v1 credentials uploaded to EAS (Android), an APNs key uploaded to EAS (iOS), and optionally `EXPO_ACCESS_TOKEN`. Sending and ticket errors (removal of `DeviceNotRegistered` tokens) are implemented and tested against a mocked Expo API. Delivery receipts (`/push/getReceipts`) are not implemented. |
| None | `none` | Implemented (in-app + realtime only) |

Android channels: `default`, `alerts`, and `critical` (SOS and CRITICAL speeding: max importance, vibration).

## Maps – `MapProvider`
- **Web:** Leaflet with tiles from `MAP_TILE_URL` and `MAP_ATTRIBUTION`, served to clients through `/config/client`.
  - The default is the public OSM tile server, which is **for development only** under its tile usage policy.
  - For production, use MapTiler, Stadia, Thunderforest or self-hosted tiles. These require an account and key.
- **Mobile:** no in-app map in v1. The driver view is speed-centred.

## Navigation – `NavigationProvider` (`apps/mobile/src/lib/navigation.ts`)
SafeDrive hands off to navigation apps through their public deep links and does not read anything back:
- Waze: `https://waze.com/ul`
- Google Maps: `https://www.google.com/maps/dir/?api=1`
- Apple Maps: `http://maps.apple.com/`

Monitoring continues in the background if "Always" location was granted.

## Realtime bus
In-memory (single instance) or Redis pub/sub (`REDIS_URL`, multi-instance).
