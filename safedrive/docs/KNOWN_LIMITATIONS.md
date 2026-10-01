# Known limitations

These are stated honestly so that nothing is assumed to work when it doesn't.

1. **Not run on physical phones in this environment.**
   - The mobile app typechecks, its controller is unit-tested, and Metro bundles build for Android and iOS.
   - Background location, the foreground service and OS kill or relaunch behaviour still need device testing.
2. **Push notifications are not live.** The server pipeline is complete and tested with a mocked Expo API. Real delivery needs an EAS project and FCM/APNs credentials.
3. **Speed-limit coverage depends on OSM.**
   - Roads without `maxspeed` show **"speed limit unavailable"**, and no violation is recorded there. This is a deliberate choice: no false accusations.
   - HERE and TomTom adapters exist but have not been run against the live services.
4. **Public OSM services are for development only.** Overpass and tile servers have usage policies. Production needs a self-hosted or commercial endpoint.
5. **GPS speed is from the phone.** It is accurate enough for the 10%+ thresholds on open roads. It is less reliable in tunnels, urban canyons and at low speed. Fixes worse than 50 m accuracy are ignored, and states show `LOCATION_UNAVAILABLE`.
6. **Phone-usage detection is minimal by OS design.** Only interaction with SafeDrive itself while moving is detected. Other apps, typing and calls can't be observed (iOS) or would need a special Android permission and native module (not built).
7. **The app does not block the phone or place emergency calls.** SOS alerts the family; calling 100/101/102 needs a tap.
8. **No automatic trip detection.** The driver starts the trip, or accepts a parent's request.
9. **Single-instance realtime without Redis.** Several API instances need `REDIS_URL`.
10. **The web session uses localStorage tokens.** This is mitigated by CSP and output escaping; an httpOnly-cookie session is on the roadmap.
11. **There is no email verification, password reset, data export or age check yet.** The dashboard doesn't show device capability flags yet (the API returns them). Push delivery receipts are not polled.
12. **Not covered by automated tests:**
    - Docker images were not built in the development sandbox (it has no network inside build containers). CI builds them.
    - The WebSocket 30-second access re-check.
    - Load and scale. No benchmarks have been run.
13. **The offline queue holds up to 20,000 points.** That is about 5.5 hours at 1 Hz, and longer with adaptive sampling. Beyond that, the oldest points are dropped.
14. **Forced RTL.** The app forces RTL natively (Hebrew-first). An English-only user would still see an RTL layout until per-language RTL switching is added.
