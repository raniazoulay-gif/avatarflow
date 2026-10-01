# SafeDrive

**נוהגים בטוח. יודעים יותר. שומרים על המשפחה.**

SafeDrive is a family driving-safety platform. A young driver presses **START DRIVING**. Parents then see the trip live: location, speed, the road's speed limit and how far over it the driver is. They get notified when speeding has lasted **10 continuous seconds**, and again only if it escalates (ATTENTION ≥10% → WARNING ≥30% → CRITICAL ≥50% over the limit). A trip summary, trip history, a transparent Safety Score and SOS are included.

Monitoring is **always visible to the driver and needs their consent**. There is no covert mode. SafeDrive never places an emergency call by itself.

Hebrew/RTL is the first-class UI language. Israel is the default market (km/h, Asia/Jerusalem, 100/101/102).

| Part | Path | Stack |
|---|---|---|
| Safety engine (shared) | `packages/core` | TypeScript, pure, deterministic, 42 unit tests |
| Backend API + workers | `apps/api` | Node 22, Fastify 5, PostgreSQL 16, optional Redis, WebSocket, 59 integration/E2E/failure tests |
| Parent dashboard + admin panel | `apps/web` | React 18, Vite, Leaflet, Hebrew RTL |
| Driver mobile app | `apps/mobile` | React Native / Expo SDK 52, background location, 18 tests |
| Database schema | `database/migrations` | SQL migrations (partitioned telemetry) |
| Docs | `docs/` | see below |

## Quick start (local)

```bash
# 1. PostgreSQL 16 with a role/database (or: docker compose up postgres)
createuser -P safedrive            # password: safedrive (dev only)
createdb -O safedrive safedrive_dev
createdb -O safedrive safedrive_test

# 2. Install, configure, run
cp .env.example .env               # set JWT_SECRET (openssl rand -base64 48) and BOOTSTRAP_ADMIN_EMAIL
npm install
npm run dev:api                    # http://localhost:4000 (migrations run on start)
npm run dev:web                    # http://localhost:5173

# 3. Demo (simulated data, labelled DEMO everywhere)
DEMO_EMAIL=parent@example.com DEMO_PASSWORD='Choose-A-Strong-1' npm run demo -- full 5
```

To run the full stack in containers: `docker compose up --build`. The web app is then at http://localhost:8080.

Mobile: `cd apps/mobile && npm install && npx expo run:android` (a development build is required for background location). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Tests

```bash
npm run test:unit        # safety engine (core)
npm run test:api         # API integration + E2E acceptance + failure scenarios (needs PostgreSQL)
cd apps/mobile && npm test   # trip controller: offline queue, restart, SOS
npm run lint && npm run typecheck && npm run build
```

## Documentation

[PRD](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md) · [Database](docs/DATABASE.md) · [API](docs/API.md) · [Security](docs/SECURITY.md) · [Privacy](docs/PRIVACY.md) · [Mobile permissions](docs/MOBILE_PERMISSIONS.md) · [Provider integrations](docs/PROVIDER_INTEGRATIONS.md) · [Testing](docs/TESTING.md) · [Deployment](docs/DEPLOYMENT.md) · [Roadmap](docs/ROADMAP.md) · [Known limitations](docs/KNOWN_LIMITATIONS.md) · [Demo](docs/DEMO.md) · [Legal & compliance notes](docs/LEGAL_AND_COMPLIANCE_NOTES.md)

## Capability status (honest summary)

| Capability | Status |
|---|---|
| Speed engine, 10-second rule, severity, aggregation, escalation | **Implemented** (unit + E2E tested) |
| Live parent view (web), trip history/replay, Safety Score, notifications in-app/realtime | **Implemented** |
| Background location on the phone (Android foreground service / iOS background mode) | **Implemented in code**. Bundles build for both platforms, but it hasn't been run on a physical device in this environment. |
| Offline queue, idempotent sync, resume after restart, offline SOS | **Implemented** (tested with fakes) |
| Speed limits | **Partially supported**: OSM/Overpass (coverage varies). HERE/TomTom adapters need keys (**Requires external configuration**). |
| Push notifications to phones | **Requires external configuration** (EAS projectId and real device). Server side is implemented and tested with a mocked Expo API. |
| SOS: family alert with location | **Implemented**. Calls to 100/101/102 happen only when the user taps them. |
| Phone usage while driving | **Partially supported** (SafeDrive in the foreground while moving). Other apps: **Platform restricted**. |
| Remote monitoring request | **Implemented** (the driver must accept on the phone; never silent) |
| Waze / Google data | **Unavailable by design** (deep links only, no scraping) |
