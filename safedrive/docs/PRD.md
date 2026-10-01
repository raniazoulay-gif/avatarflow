# Product Requirements – SafeDrive

## Problem
Parents of new drivers (17–21) worry about speeding but have no reliable, respectful way to know what happens on the road. Existing trackers are either covert (harmful to trust, often illegal) or noisy (an alert per second of speeding).

## Users
- **Driver**: a young driver who joins a family with explicit consent and starts trips.
- **Parent**: sees live trips, receives alerts, reviews history and the Safety Score, and manages the family, emergency contacts and notification preferences.
- **System admin**: operates the platform through the admin panel (health, users, families, audit, providers, configuration).

## Core rules
1. **Speeding is confirmed only after 10 continuous seconds** above the limit, measured from the first sample where the excess is at least the ATTENTION threshold. If the speed drops back to or below the limit before 10 s, the timer resets and no event is recorded.
2. **Severity** is based on the percentage over the limit, with inclusive thresholds:
   - ATTENTION ≥ 10%
   - WARNING ≥ 30%
   - CRITICAL ≥ 50%

   All thresholds are configurable globally (admin) and per country. Example: at a 100 km/h limit, 110 is ATTENTION, 130 is WARNING and 150 is CRITICAL.
3. **One event per continuous speeding episode.** It is not one per second. Escalation to a higher severity must hold for 3 s, and each escalation sends one notification. The event closes after 3 s at or below the limit and records:
   - start and end time
   - duration
   - maximum speed and the limit
   - maximum excess
   - peak severity
   - road
   - start and end location
4. **No false violation**:
   - When the limit is unavailable or low-confidence, no violation is recorded and the state shows SPEED_LIMIT_UNAVAILABLE.
   - When GPS accuracy is worse than 50 m, the sample is ignored (LOCATION_UNAVAILABLE).
   - A gap of more than 15 s between samples breaks continuity.
5. **Visible, consented monitoring only.**
   - A driver must consent when joining.
   - A parent can only *request* monitoring, and the driver accepts on the phone.
   - The OS indicator and the persistent notification are always on during a trip.
6. **SOS** notifies the family with location, speed and time, using critical priority that preferences cannot mute. Emergency numbers are shown as tap-to-call buttons. The app never dials by itself.

## Features (v1)
- **Driver app:**
  - START DRIVING, live status with large severity colours, and long-press to end the trip.
  - SOS, accept or decline monitoring requests, and a permission checklist.
  - Navigation hand-off to Waze, Google Maps or Apple Maps through public deep links.
  - Offline mode and a demo trip.
- **Parent web dashboard:**
  - Live map with all active drivers, driver pages, trip details (coloured route, speed chart, replay) and the notification centre.
  - SOS centre (acknowledge and resolve).
  - Family settings: invites, emergency contacts, notification preferences.
  - Demo control.
- **Parent mobile view:** live trips and notifications (simplified).
- **Safety Score 0–100**: deterministic and transparent. Every deduction is listed. The score is weighted by distance over the last 20 real trips.
- **Admin panel**: health, users (suspend), families, active trips, audit log, provider usage and errors, safety configuration.
- **Demo mode**: scripted Route 1 scenarios run through the real pipeline and are labelled DEMO everywhere.

## Non-goals (v1)
- Covert tracking, reading other apps, blocking the phone, and automatic emergency calls.
- Reading or scraping Waze or Google Maps data.
- Insurance scoring and resale of data.

## Success metrics
- False violation rate: 0 events when the speed limit is unknown (enforced by tests).
- Alert noise: at most one notification per severity level per episode.
- Alert latency: confirmation at 10 s plus upload (≤2 s while speeding) plus push delivery.
- Battery: adaptive sampling, plus a low-battery factor that is never applied while speeding.
