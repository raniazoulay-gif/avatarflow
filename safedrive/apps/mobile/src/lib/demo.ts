/**
 * Demo simulator: feeds a scripted Route 1 scenario into the real TripController at
 * 1 Hz (optionally faster). The trip is created with isDemo = true and every point is
 * tagged source = 'simulated', so it never mixes with real driving data.
 */
import { demoScenario, generateDemoPoints } from '@safedrive/core';
import { controller } from './location';

let timer: ReturnType<typeof setInterval> | null = null;

export async function startDemo(
  driverId: string,
  scenarioId = 'full',
  speedup = 1,
): Promise<boolean> {
  const s = demoScenario(scenarioId);
  if (!s || timer) return false;
  const ok = await controller.start(driverId, null, { demo: true });
  if (!ok) return false;
  const pts = generateDemoPoints(s, Date.now());
  let i = 0;
  timer = setInterval(
    () => {
      const p = pts[i++];
      if (!p) {
        stopDemo(true);
        return;
      }
      void controller.onFix({
        t: p.t,
        lat: p.lat,
        lon: p.lon,
        altitudeM: p.altitudeM,
        speedMs: p.speedMs,
        headingDeg: p.headingDeg,
        accuracyM: p.accuracyM,
        simulatedLimitKmh: p.limitKmh,
      });
    },
    Math.max(50, Math.round(1000 / speedup)),
  );
  return true;
}

export function stopDemo(endTrip = true): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (endTrip) void controller.stop();
}

export const demoRunning = (): boolean => timer !== null;
