import { describe, expect, it } from 'vitest';
import {
  OsmOverpassProvider,
  parseMaxspeed,
  pickWay,
  distanceToPolyline,
} from '../src/providers/speed-limit/osm.js';
import {
  HereSpeedLimitProvider,
  TomTomSpeedLimitProvider,
  parseTomTomSpeed,
} from '../src/providers/speed-limit/commercial.js';
import { ExpoPushProvider } from '../src/providers/push/push.js';
import { cellKey } from '../src/services/speed-limits.js';

const json = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

const q = { lat: 32.0, lon: 34.8, headingDeg: 0, countryCode: 'IL' };
const northSouthWay = (id: number, tags: Record<string, string>, lonOffset = 0) => ({
  type: 'way' as const,
  id,
  tags,
  geometry: [
    { lat: 31.999, lon: 34.8 + lonOffset },
    { lat: 32.001, lon: 34.8 + lonOffset },
  ],
});

describe('OSM maxspeed parsing', () => {
  it('parses numeric, mph and Israeli implicit values; rejects non-numeric', () => {
    expect(parseMaxspeed('90')).toEqual({ kmh: 90, confidence: 0.8 });
    expect(parseMaxspeed('30 mph')).toEqual({ kmh: 48, confidence: 0.8 });
    expect(parseMaxspeed('IL:urban')).toEqual({ kmh: 50, confidence: 0.65 });
    expect(parseMaxspeed('none')).toBeNull();
    expect(parseMaxspeed('signals')).toBeNull();
    expect(parseMaxspeed(undefined)).toBeNull();
  });

  it('matches the nearest heading-aligned way within 30 m', () => {
    const ways = [
      northSouthWay(1, { maxspeed: '90' }),
      northSouthWay(2, { maxspeed: '50' }, 0.0002),
    ];
    expect(pickWay(ways, q)?.way.id).toBe(1);
    expect(pickWay([northSouthWay(3, {}, 0.01)], q)).toBeNull(); // ~940 m away
  });

  it('answers "no data" when the matched road has no maxspeed (never borrows a neighbour)', async () => {
    const ways = [
      northSouthWay(1, { highway: 'primary' }),
      northSouthWay(2, { maxspeed: '50' }, 0.0003),
    ];
    const p = new OsmOverpassProvider(
      'http://overpass.test',
      1000,
      0,
      'test',
      json({ elements: ways }),
    );
    expect(await p.lookup(q)).toBeNull();
  });

  it('returns limit, road name and geometry for reuse', async () => {
    const p = new OsmOverpassProvider(
      'http://overpass.test',
      1000,
      0,
      'test',
      json({
        elements: [northSouthWay(9, { maxspeed: '110', name: 'Route 1', 'name:he': 'כביש 1' })],
      }),
    );
    const r = await p.lookup(q);
    expect(r).toMatchObject({
      limitKmh: 110,
      source: 'osm',
      roadName: 'כביש 1',
      externalId: 'way/9',
    });
    expect(r?.geometry).toHaveLength(2);
    expect(distanceToPolyline({ lat: 32.0005, lon: 34.8 }, r!.geometry!)).toBeLessThan(1);
  });

  it('propagates HTTP errors (the service turns them into "unavailable")', async () => {
    const p = new OsmOverpassProvider('http://overpass.test', 1000, 0, 'test', json({}, 429));
    await expect(p.lookup(q)).rejects.toThrow('HTTP 429');
  });
});

describe('commercial providers', () => {
  it('HERE: speedLimit span in m/s -> km/h; skipped without key', async () => {
    const here = new HereSpeedLimitProvider(
      'k',
      1000,
      json({
        routes: [{ sections: [{ spans: [{ speedLimit: 25, names: [{ value: 'Ayalon' }] }] }] }],
      }),
    );
    expect(await here.lookup(q)).toMatchObject({
      limitKmh: 90,
      source: 'here',
      roadName: 'Ayalon',
      confidence: 0.9,
    });
    expect(new HereSpeedLimitProvider(undefined, 1000).available()).toBe(false);
  });

  it('TomTom: "50.00KMH" / "30.00MPH"', async () => {
    expect(parseTomTomSpeed('50.00KMH')).toBe(50);
    expect(parseTomTomSpeed('30.00MPH')).toBe(48);
    const tt = new TomTomSpeedLimitProvider(
      'k',
      1000,
      json({ addresses: [{ address: { speedLimit: '80.00KMH', street: 'Begin' } }] }),
    );
    expect(await tt.lookup(q)).toMatchObject({ limitKmh: 80, roadName: 'Begin' });
  });

  it('cache keys group nearby fixes by ~30 m cell and heading', () => {
    expect(cellKey({ ...q })).toBe(cellKey({ ...q, lat: 32.00005 }));
    expect(cellKey({ ...q })).not.toBe(cellKey({ ...q, headingDeg: 180 }));
  });
});

describe('Expo push provider', () => {
  it('maps tickets to outcomes and flags DeviceNotRegistered as permanent', async () => {
    const p = new ExpoPushProvider(
      undefined,
      1000,
      json({
        data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }],
      }),
    );
    const r = await p.send([
      { token: 'a', title: 't', body: 'b', data: {}, sound: true, priority: 'critical' },
      { token: 'b', title: 't', body: 'b', data: {}, sound: false, priority: 'low' },
    ]);
    expect(r).toEqual([{ ok: true }, { ok: false, error: 'DeviceNotRegistered', permanent: true }]);
  });

  it('network failure is retryable', async () => {
    const failing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const r = await new ExpoPushProvider(undefined, 1000, failing).send([
      { token: 'a', title: 't', body: 'b', data: {}, sound: false, priority: 'normal' },
    ]);
    expect(r[0]).toMatchObject({ ok: false, permanent: false });
  });
});
