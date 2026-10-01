# Deployment

Nothing is deployed automatically. CI (`.github/workflows/safedrive.yml`) runs:
- lint and format
- typecheck
- unit and integration tests against PostgreSQL 16
- build
- `npm audit`
- Metro bundles for Android and iOS
- Docker image builds

Production deployment requires the credentials listed below and a human decision.

## Environments
| | development | test / CI | staging | production |
|---|---|---|---|---|
| `NODE_ENV` | development | test | staging | production |
| DB | local Postgres | `safedrive_test` (reset by tests) | managed Postgres 16 | managed Postgres 16 + PITR backups |
| Redis | optional | no | yes | yes (more than one API instance) |
| Push | `log` | `log` (mocked) | `expo` (test project) | `expo` |
| Speed limits | `osm` public | fake provider | `osm` self-hosted + optional `here` | `here`/`tomtom` (contract) + `osm` fallback |
| Demo | on | on | on | off unless needed for sales |
| Tiles | OSM public (dev only) | — | provider key | provider key |

## Backend + web with Docker
```bash
cp .env.example .env    # fill JWT_SECRET, METRICS_TOKEN, provider keys; set NODE_ENV=production
docker compose up --build -d
```
The compose stack is:
- `postgres:16`
- `redis:7`
- `api` (Node 22, non-root, healthcheck `/health`, migrations applied on start under an advisory lock)
- `web` (nginx: static SPA, CSP, and proxying of `/api` and `/ws` to the API)

Images are built from the `safedrive/` folder:
```bash
docker build -f apps/api/Dockerfile -t safedrive-api .
docker build -f apps/web/Dockerfile -t safedrive-web .
```
Note: the Docker builds were not run end-to-end in the development sandbox, because its build containers have no network access. CI builds both images on pushes that touch `safedrive/`, after the checks pass.

## Managed hosting (example)
Any container platform works: Fly.io, Render, Railway, ECS or Cloud Run. Requirements:
- HTTPS termination. Set `TRUST_PROXY=true` behind a load balancer so rate limits see real client IPs.
- WebSocket support with idle timeouts of at least 60 s.
- `REDIS_URL` when running more than one API instance.
- Workers: each instance runs them safely (`FOR UPDATE SKIP LOCKED`, idempotent jobs). You can also set `WORKERS_ENABLED=false` on all but one instance.
- Prometheus scraping of `/metrics` with `Authorization: Bearer METRICS_TOKEN`.
- Backups: daily snapshots plus PITR. Telemetry partitions are monthly.

## Mobile (EAS)
1. Create an Expo account and run `cd apps/mobile && npx eas init`. This writes the real `extra.eas.projectId`.
2. Set `bundleIdentifier` / `package` (currently `com.example.safedrive`) to your own identifiers.
3. Set `extra.apiUrl` to the public API URL. Use `app.config.ts` or EAS build profiles for staging and production.
4. Push credentials:
   - `eas credentials` for Android: upload the FCM v1 service-account key.
   - iOS: an APNs key.
5. Build: `npx eas build --platform android` and `npx eas build --platform ios`. This requires a **Google Play Developer** account ($25) and an **Apple Developer Program** membership ($99/yr).
6. Store review:
   - Background-location declaration form (Google Play) and a video showing the feature.
   - App Store review notes explaining "Always" location (visible, trip-only monitoring).
   - Privacy labels and data-safety forms; use [PRIVACY.md](PRIVACY.md).

## First admin
Set `BOOTSTRAP_ADMIN_EMAIL` **before** opening registration, then register that account. It only works while no admin exists. Later admins: `DATABASE_URL=... npm run admin:grant -w @safedrive/api -- person@example.com`.

## Rollback
- API and web images are immutable: redeploy the previous tag.
- Migrations are forward-only. Take a snapshot before deploying a migration.
