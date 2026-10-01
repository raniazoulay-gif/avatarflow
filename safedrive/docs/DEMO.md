# Demo

Demo mode shows the whole product without driving. Scripted scenarios on **Route 1 (Tel Aviv → Jerusalem)** are fed through the **real** server pipeline: speed-limit handling, the 10-second rule, escalation, notifications, score and SOS.

Demo data is always labelled:
- families and trips carry `is_demo`
- points carry `source = simulated`
- the UI shows a purple DEMO badge

It never enters real families, real scores or statistics.

## Scenarios (`packages/core/src/demo.ts`)
| Id | Story |
|---|---|
| `full` | Accelerate → normal at 95/100 → 115 (ATTENTION after 10 s) → 135 (WARNING) → 156 (CRITICAL) → recovery and event closed → hard braking → end |
| `short-burst` | 9 seconds over the limit, then back. **No event** (proves the 10-second rule). |
| `degraded` | Network loss (queued and synced later), GPS loss, a road without a known limit (no violation) |
| `sos` | Normal driving, then the driver triggers SOS |

## Run it

**From the web dashboard** (parent account):
1. Open "מצב הדגמה" (Demo mode).
2. Click "יצירת משפחת הדגמה" (Create demo family). This creates a simulated driver.
3. Choose a time speed-up (×1 real time … ×20) and click "הפעלה" (Run) next to a scenario.
4. Open "Live" to watch the map, the severity colours and the toasts.

**From the command line** (with the API running):
```bash
DEMO_EMAIL=parent@example.com DEMO_PASSWORD='Choose-A-Strong-1' npm run demo -- full 5
```
The account is created on first use. Open the web app with the same account to watch.

**Mobile:** the driver app has no client-side simulator. Demo trips are generated on the server only, so a phone can never send simulated points into a real trip. To test the phone itself, use the emulator's route playback (see [MOBILE_PERMISSIONS.md](MOBILE_PERMISSIONS.md#testing-permissions)).

## Disable
Set `DEMO_MODE_ENABLED=false` (recommended in production unless needed for sales).
