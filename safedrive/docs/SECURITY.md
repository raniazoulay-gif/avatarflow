# Security

## Threat model (summary)
| Asset | Threat | Control |
|---|---|---|
| Live location of minors | Another family, ex-member or attacker reads it | Every route checks family membership and role (`auth/access.ts`). Non-members get 404 (no existence leak). WebSocket re-checks session and membership every 30 s. |
| Accounts | Credential stuffing, token theft | scrypt hashes; lockout after 10 failures (15 min); auth endpoints limited to 10/min/IP. Access JWT (HS256, pinned alg/iss/aud) lasts 15 min and is checked against a live session. Refresh tokens are opaque, rotated, and stored as hashes; reuse revokes the whole chain. Logout revokes the chain. |
| Alert integrity | A driver hides speeding | `isDemo` is decided by the server (demo families only). Simulated points and limits are rejected on real trips. A sequence number can't be rewritten. Points recorded >2 min after the trip ended are refused. Limits are resolved on the server, never trusted from the phone. |
| Shared providers | One account floods OSM/HERE/TomTom | Lookups are throttled to 100 m / 30 s per trip, capped at 20 per batch. Impossible jumps get no lookup. Providers have a global minimum interval and timeouts. Results are cached, including negative results. |
| Web dashboard | XSS takes over a session | React escapes output. Map labels are text nodes, never HTML. A CSP is set at nginx (`script-src 'self'`, `frame-ancestors 'none'`), plus `nosniff` and `no-referrer`. |
| Admin powers | Privilege escalation | `BOOTSTRAP_ADMIN_EMAIL` only creates the *first* admin; then `npm run admin:grant` is used (DB access required). Admin actions are audited, including viewing a family. |
| Devices | Session hijack through device ids | Devices are linked to sessions and trips only if owned by the caller. Device revocation is scoped to the owner. |
| Input | Injection, DoS | All SQL is parameterised. zod validates every body with length and size caps (500 points/batch, 20 permissions, 30 capability keys). Rate limits: global 300/min, SOS 20/min, monitoring requests 10/min. Demo: ≤5 demo families per account, one run per driver. |

## Secrets
- No secret is in the repository. `.env` is git-ignored and `.env.example` holds empty placeholders.
- Required in production (from a secret manager):
  - `JWT_SECRET` (≥32 chars)
  - `DATABASE_URL`
  - `REDIS_URL`
  - `METRICS_TOKEN`
- Optional: `HERE_API_KEY`, `TOMTOM_API_KEY`, `EXPO_ACCESS_TOKEN`.
- Logs redact the `Authorization` header. Tokens never appear in URLs: the WebSocket authenticates with a message.

## Mobile
- The refresh token is in the OS keystore (`expo-secure-store`); the access token is only in memory.
- AsyncStorage holds:
  - the telemetry queue: location history waiting for upload, kept until it is delivered
  - pending stop/SOS
  - the cached profile
  - the device id
- Sign-out is blocked while a trip or unsynced data exists, so data is never abandoned or uploaded under another account.

## Known gaps (to do before production)
- **Token storage on the web:** tokens are in `localStorage`. CSP reduces the XSS risk. An httpOnly-cookie session with CSRF protection would be stronger.
- **No email verification or password-reset flow yet** (requires an email provider).
- **Lockout is per account,** so an attacker can lock a known account for 15 min. Consider per-IP+account counters or CAPTCHA.
- **No WebSocket revocation test:** the 30-second re-check is implemented, but no automated test covers it.
- **Pending security work:**
  - dependency scanning beyond `npm audit`
  - penetration test
  - mobile certificate pinning (optional)

## Reporting
Report vulnerabilities privately to the operator's security contact (`CONTACT_EMAIL`).
