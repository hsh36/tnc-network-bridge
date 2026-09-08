import { prtgResponseSchema } from '../../shared';
import { buildPrtgResponse } from './prtg';
import { createBridgeMetrics, type BridgeMetrics } from './registry';

let metrics: BridgeMetrics;

const build = (over: Partial<Parameters<typeof buildPrtgResponse>[0]> = {}) =>
  buildPrtgResponse({ metrics, diskWarnPct: 85, ...over });

const channel = (name: string) => build().prtg.result.find((c) => c.channel === name);

beforeEach(() => {
  metrics = createBridgeMetrics();
});

describe('buildPrtgResponse', () => {
  it('matches the schema PRTG requires', () => {
    expect(() => prtgResponseSchema.parse(build())).not.toThrow();
  });

  it('expresses every limit as a string', () => {
    // A numeric limit is silently ignored by PRTG, so the sensor never alerts — the
    // worst failure mode for a monitoring integration, because all looks healthy.
    for (const c of build().prtg.result) {
      for (const key of [
        'limitmaxwarning',
        'limitmaxerror',
        'limitminwarning',
        'limitminerror',
      ] as const) {
        const value = c[key];
        if (value !== undefined) {
          expect(typeof value).toBe('string');
        }
      }
    }
  });

  it('takes the disk warning threshold from configuration', () => {
    const disk = buildPrtgResponse({ metrics, diskWarnPct: 70 }).prtg.result.find(
      (c) => c.channel === 'Disk usage',
    );
    expect(disk?.limitmaxwarning).toBe('70');
  });

  it('computes disk usage as a percentage of used plus free', () => {
    metrics.diskUsage.set(750);
    metrics.diskFree.set(250);

    expect(channel('Disk usage')?.value).toBeCloseTo(75);
  });

  it('reports zero rather than NaN on a filesystem it could not read', () => {
    // Both gauges default to 0, so the naive used/(used+free) is 0/0.
    expect(channel('Disk usage')?.value).toBe(0);
  });

  it('graphs counters in Difference mode, so the sensor shows a rate', () => {
    metrics.syncFiles.inc(10);
    expect(channel('Files synced')?.mode).toBe('Difference');
    expect(channel('Errors')?.mode).toBe('Difference');
  });

  it('leaves gauges in the default absolute mode', () => {
    expect(channel('Active locks')?.mode).toBeUndefined();
  });

  it('reflects the live gauge values', () => {
    metrics.locks.set(4);
    metrics.queueDepth.set(12);
    metrics.throughput.set(1_048_576);
    metrics.sharesOnline.set(2);

    expect(channel('Active locks')?.value).toBe(4);
    expect(channel('Queue depth')?.value).toBe(12);
    expect(channel('Throughput')?.value).toBe(1_048_576);
    expect(channel('Shares online')?.value).toBe(2);
  });

  it('carries a status message and an error flag when given', () => {
    const response = build({ statusText: 'server unreachable', error: true });

    expect(response.prtg.text).toBe('server unreachable');
    expect(response.prtg.error).toBe(1);
  });

  it('omits the error flag when healthy', () => {
    expect(build().prtg.error).toBeUndefined();
  });

  it('keeps the channel set small enough to read', () => {
    // Every channel added is one whose unit can never change afterwards, and a
    // fifty-channel sensor is unreadable.
    expect(build().prtg.result.length).toBeLessThanOrEqual(12);
  });

  it('gives every channel a unit', () => {
    for (const c of build().prtg.result) {
      expect(c.unit ?? c.customunit).toBeDefined();
    }
  });

  it('names channels uniquely', () => {
    const names = build().prtg.result.map((c) => c.channel);
    expect(new Set(names).size).toBe(names.length);
  });
});
