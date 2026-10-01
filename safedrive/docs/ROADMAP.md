# Roadmap

## Next (before a public launch)
1. **Device validation:** run the [device test checklist](TESTING.md#device-test-checklist) on Samsung, Pixel, Xiaomi and iPhone. Tune the sampling policy and verify battery drain per hour.
2. **Push:** EAS project, FCM/APNs credentials, end-to-end delivery test, critical-alert sound.
3. **Speed-limit coverage in Israel:** measure OSM `maxspeed` coverage on the main routes. Sign up with HERE or TomTom if coverage is insufficient. Self-hosted Overpass.
4. **Auth:** email verification, password reset, an httpOnly-cookie web session, per-IP+account lockout.
5. **Legal review** (see [LEGAL_AND_COMPLIANCE_NOTES.md](LEGAL_AND_COMPLIANCE_NOTES.md)): consent texts, minors, privacy policy and terms in Hebrew.
6. **Browser E2E suite** (Playwright) for the parent dashboard and admin panel.
7. **Driver features:** a self-service "leave family" button and data export.

## Later
- Parent mobile app with a map (currently the web dashboard plus a simple mobile list).
- Android UsageStats-based phone-usage detection (needs a native module and special-access consent). iOS stays restricted.
- Automatic trip detection (Activity Recognition / CoreMotion), still with a visible start confirmation for the driver.
- Weekly reports, goals and positive reinforcement for good driving.
- Crash detection (high-g events) suggesting SOS, never auto-dialling.
- More countries: profiles for limits, emergency numbers, units (mph) and retention.
- Load testing and horizontal-scaling benchmarks. TimescaleDB for telemetry at large scale.
