import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  REFILL_HZ,
  ThrottleStream,
  TokenBucket,
  TransferQueue,
  concurrencyFor,
  kbpsToBytesPerSecond,
  readLinkSpeedMbps,
  systemClock,
  type Clock,
} from './throttle';

/**
 * T20 acceptance tests.
 *
 * The headline criterion is throughput within ±10 % of the cap over 60 seconds. Waiting
 * a real minute would make the suite unusable and would measure the CI machine's timer
 * jitter as much as the bucket, so time is injected: a virtual clock advances only when
 * the bucket asks to sleep, which measures exactly what the criterion is about — the
 * bucket's own accounting — and does it deterministically. A shorter test with real
 * timers then confirms the wiring is not merely correct in simulation.
 */

/** Advances only when something sleeps, so simulated time is exactly what was waited. */
class VirtualClock implements Clock {
  private current = 0;

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    this.current += ms;
    return Promise.resolve();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// The bucket
// ---------------------------------------------------------------------------

describe('TokenBucket', () => {
  it('delivers within 10% of the cap over a simulated 60 seconds', async () => {
    const clock = new VirtualClock();
    const rate = 1 * MB; // 1 MiB/s
    const bucket = new TokenBucket(rate, clock);
    const total = 60 * rate;

    const startedAt = clock.now();
    for (let sent = 0; sent < total; sent += 64 * 1024) {
      await bucket.consume(64 * 1024);
    }
    const elapsedSeconds = (clock.now() - startedAt) / 1000;
    const measured = total / elapsedSeconds;

    expect(measured).toBeGreaterThan(rate * 0.9);
    expect(measured).toBeLessThan(rate * 1.1);
  });

  it('holds the cap across a range of rates and chunk sizes', async () => {
    for (const rate of [64 * 1024, 512 * 1024, 4 * MB]) {
      for (const chunk of [4096, 256 * 1024]) {
        const clock = new VirtualClock();
        const bucket = new TokenBucket(rate, clock);
        // Whole chunks only: measuring a nominal total against the time taken to move a
        // rounded-up one would understate the throughput rather than test it.
        const chunkCount = Math.ceil((10 * rate) / chunk);
        const total = chunkCount * chunk;

        for (let i = 0; i < chunkCount; i += 1) {
          await bucket.consume(chunk);
        }

        const measured = total / ((clock.now() || 1) / 1000);
        expect(measured).toBeGreaterThan(rate * 0.9);
        expect(measured).toBeLessThan(rate * 1.1);
      }
    }
  });

  it('passes a chunk larger than its whole capacity instead of deadlocking', async () => {
    const clock = new VirtualClock();
    // At 100 KiB/s the bucket holds a tenth of that; a 256 KiB chunk dwarfs it.
    const bucket = new TokenBucket(100 * 1024, clock);

    await bucket.consume(256 * 1024);

    // Roughly 2.56 seconds of bandwidth, less the initial full bucket.
    expect(clock.now()).toBeGreaterThan(2_000);
    expect(clock.now()).toBeLessThan(3_000);
  });

  it('is free and instant when unlimited', async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket(null, clock);

    await bucket.consume(500 * MB);

    expect(bucket.unlimited).toBe(true);
    expect(clock.now()).toBe(0);
  });

  it('treats zero and negative rates as unlimited', () => {
    expect(new TokenBucket(0, new VirtualClock()).unlimited).toBe(true);
    expect(new TokenBucket(-5, new VirtualClock()).unlimited).toBe(true);
  });

  it('ignores an empty or negative consume', async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket(1024, clock);

    await bucket.consume(0);
    await bucket.consume(-10);

    expect(clock.now()).toBe(0);
  });

  it('refills at ten times a second', () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket(REFILL_HZ * 1000, clock);

    // Capacity is one refill interval's worth: a tenth of the per-second rate.
    expect(bucket.capacity).toBe(1000);
  });

  it('does not accumulate credit while idle beyond one interval', async () => {
    const clock = new VirtualClock();
    const rate = 1 * MB;
    const bucket = new TokenBucket(rate, clock);

    // Idle for a minute: an unbounded bucket would now allow a 60 MB burst.
    clock.advance(60_000);
    await bucket.consume(1 * MB);

    // It still took most of a second, because only a tenth of a second was banked.
    expect(clock.now() - 60_000).toBeGreaterThan(800);
  });
});

describe('changing the rate mid-transfer', () => {
  it('slows a transfer that is already running', async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket(10 * MB, clock);

    await bucket.consume(1 * MB);
    const fastElapsed = clock.now();

    bucket.setRate(1 * MB);
    const beforeSlow = clock.now();
    await bucket.consume(1 * MB);
    const slowElapsed = clock.now() - beforeSlow;

    // The same megabyte now costs roughly ten times as long.
    expect(slowElapsed).toBeGreaterThan(fastElapsed * 5);
  });

  it('speeds one up again without restarting it', async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket(1 * MB, clock);

    await bucket.consume(512 * 1024);
    bucket.setRate(20 * MB);
    const beforeFast = clock.now();
    await bucket.consume(1 * MB);

    expect(clock.now() - beforeFast).toBeLessThan(200);
  });

  it('does not hand out a burst that the lower rate never earned', async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket(100 * MB, clock);

    // The bucket is full at the high rate; dropping the rate must clamp it, not keep it.
    bucket.setRate(100 * 1024);

    expect(bucket.capacity).toBe((100 * 1024) / REFILL_HZ);
    await bucket.consume(100 * 1024);
    expect(clock.now()).toBeGreaterThan(800);
  });

  it('can be lifted to unlimited', async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket(1024, clock);

    bucket.setRate(null);
    await bucket.consume(10 * MB);

    expect(bucket.unlimited).toBe(true);
    expect(clock.now()).toBe(0);
  });

  it('uses the system clock when none is injected', async () => {
    const bucket = new TokenBucket(null);

    // The unlimited path takes no time, so this is safe to await against real timers.
    await expect(bucket.consume(1024)).resolves.toBeUndefined();
  });

  it('reports the rate it is enforcing', () => {
    const bucket = new TokenBucket(2048, new VirtualClock());

    expect(bucket.bytesPerSecond).toBe(2048);
    bucket.setRate(4096);
    expect(bucket.bytesPerSecond).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

describe('ThrottleStream', () => {
  it('passes every byte through unchanged', async () => {
    const chunks = [Buffer.from('BEGIN '), Buffer.from('PGM '), Buffer.from('TEST')];
    const bucket = new TokenBucket(null, new VirtualClock());
    const received: Buffer[] = [];

    await pipeline(Readable.from(chunks), new ThrottleStream(bucket), async (source) => {
      for await (const chunk of source) {
        received.push(chunk as Buffer);
      }
    });

    expect(Buffer.concat(received).toString()).toBe('BEGIN PGM TEST');
  });

  it('actually limits throughput with real timers', async () => {
    // 256 KiB at 512 KiB/s should take about half a second. The tolerance is wide
    // because this measures real timers; the precise figure is asserted on the clock.
    const bucket = new TokenBucket(512 * 1024, systemClock);
    const payload = Buffer.alloc(256 * 1024, 0x41);

    const startedAt = Date.now();
    await pipeline(Readable.from([payload]), new ThrottleStream(bucket), async (source) => {
      for await (const _chunk of source) {
        // drain
      }
    });

    expect(Date.now() - startedAt).toBeGreaterThan(250);
  }, 20_000);

  it('accepts string chunks as well as buffers', async () => {
    const bucket = new TokenBucket(null, new VirtualClock());
    const received: Buffer[] = [];

    await pipeline(
      Readable.from(['one', 'two'], { objectMode: true }),
      new ThrottleStream(bucket),
      async (source) => {
        for await (const chunk of source) {
          received.push(chunk as Buffer);
        }
      },
    );

    expect(Buffer.concat(received).toString()).toBe('onetwo');
  });

  it('wraps a non-Error rejection so the stream still reports something useful', async () => {
    const bucket = new TokenBucket(1024, new VirtualClock());
    jest.spyOn(bucket, 'consume').mockRejectedValue('a bare string');

    await expect(
      pipeline(Readable.from([Buffer.from('x')]), new ThrottleStream(bucket), async (source) => {
        for await (const _chunk of source) {
          // drain
        }
      }),
    ).rejects.toThrow('a bare string');
  });

  it('surfaces a bucket failure as a stream error rather than hanging', async () => {
    const bucket = new TokenBucket(1024, new VirtualClock());
    jest.spyOn(bucket, 'consume').mockRejectedValue(new Error('bucket exploded'));

    await expect(
      pipeline(Readable.from([Buffer.from('x')]), new ThrottleStream(bucket), async (source) => {
        for await (const _chunk of source) {
          // drain
        }
      }),
    ).rejects.toThrow('bucket exploded');
  });
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

describe('TransferQueue', () => {
  const deferred = (): {
    promise: Promise<void>;
    resolve: () => void;
  } => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('runs no more than the configured number at once', async () => {
    const queue = new TransferQueue({ concurrency: 2 });
    let running = 0;
    let peak = 0;
    const gate = deferred();

    const tasks = Array.from({ length: 6 }, (_, i) =>
      queue.add(i, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
        return i;
      }),
    );

    expect(queue.stats.running).toBe(2);
    gate.resolve();
    await Promise.all(tasks);

    expect(peak).toBe(2);
    expect(queue.stats.completed).toBe(6);
  });

  it('runs the smallest queued file first (R13)', async () => {
    const queue = new TransferQueue({ concurrency: 1, agingBytesPerSecond: 0 });
    const order: string[] = [];
    const gate = deferred();

    // The first task occupies the single slot while the rest queue up behind it.
    const blocker = queue.add(0, async () => {
      await gate.promise;
      order.push('blocker');
    });
    const big = queue.add(100 * MB, () => {
      order.push('big');
      return Promise.resolve();
    });
    const small = queue.add(4096, () => {
      order.push('small');
      return Promise.resolve();
    });
    const medium = queue.add(5 * MB, () => {
      order.push('medium');
      return Promise.resolve();
    });

    gate.resolve();
    await Promise.all([blocker, big, small, medium]);

    expect(order).toEqual(['blocker', 'small', 'medium', 'big']);
  });

  it('does not let a large file starve small ones', async () => {
    const queue = new TransferQueue({ concurrency: 1, agingBytesPerSecond: 0 });
    const order: number[] = [];
    const gate = deferred();

    const blocker = queue.add(0, () => gate.promise);
    const large = queue.add(500 * MB, () => {
      order.push(500);
      return Promise.resolve();
    });
    const smalls = [1, 2, 3].map((n) =>
      queue.add(n * 1024, () => {
        order.push(n);
        return Promise.resolve();
      }),
    );

    gate.resolve();
    await Promise.all([blocker, large, ...smalls]);

    // Every small file went before the large one.
    expect(order).toEqual([1, 2, 3, 500]);
  });

  it('does not let small files starve a large one forever', async () => {
    const clock = new VirtualClock();
    const queue = new TransferQueue({
      concurrency: 1,
      clock,
      agingBytesPerSecond: 10 * MB,
    });
    const order: string[] = [];
    const gate = deferred();

    const blocker = queue.add(0, () => gate.promise);
    const large = queue.add(50 * MB, () => {
      order.push('large');
      return Promise.resolve();
    });

    // The large file waits ten seconds, earning 100 MB of credit — more than its size.
    clock.advance(10_000);
    const small = queue.add(1024, () => {
      order.push('small');
      return Promise.resolve();
    });

    gate.resolve();
    await Promise.all([blocker, large, small]);

    expect(order).toEqual(['large', 'small']);
  });

  it('breaks ties by arrival order', async () => {
    const queue = new TransferQueue({ concurrency: 1, agingBytesPerSecond: 0 });
    const order: number[] = [];
    const gate = deferred();

    const blocker = queue.add(0, () => gate.promise);
    const equal = [1, 2, 3, 4].map((n) =>
      queue.add(4096, () => {
        order.push(n);
        return Promise.resolve();
      }),
    );

    gate.resolve();
    await Promise.all([blocker, ...equal]);

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('resolves with each task result', async () => {
    const queue = new TransferQueue({ concurrency: 3 });

    const results = await Promise.all([
      queue.add(1, () => Promise.resolve('a')),
      queue.add(2, () => Promise.resolve('b')),
    ]);

    expect(results).toEqual(['a', 'b']);
  });

  it('reports a failing task to its own caller and keeps going', async () => {
    const queue = new TransferQueue({ concurrency: 1 });

    const failing = queue.add(1, () => Promise.reject(new Error('one bad file')));
    const succeeding = queue.add(2, () => Promise.resolve('fine'));

    await expect(failing).rejects.toThrow('one bad file');
    await expect(succeeding).resolves.toBe('fine');
    expect(queue.stats).toMatchObject({ completed: 1, failed: 1, queued: 0, running: 0 });
  });

  it('starts more work as soon as concurrency is raised', async () => {
    const queue = new TransferQueue({ concurrency: 1 });
    const gate = deferred();
    const tasks = Array.from({ length: 4 }, (_, i) => queue.add(i, () => gate.promise));

    expect(queue.stats.running).toBe(1);
    queue.setConcurrency(4);
    expect(queue.stats.running).toBe(4);

    gate.resolve();
    await Promise.all(tasks);
  });

  it('lets running work finish when concurrency is lowered', async () => {
    const queue = new TransferQueue({ concurrency: 4 });
    const gate = deferred();
    const tasks = Array.from({ length: 4 }, (_, i) => queue.add(i, () => gate.promise));

    queue.setConcurrency(1);

    // Nothing is cancelled: a transfer cannot be interrupted without leaving debris.
    expect(queue.stats.running).toBe(4);
    expect(queue.stats.concurrency).toBe(1);
    gate.resolve();
    await Promise.all(tasks);
  });

  it('never drops below a concurrency of one', () => {
    const queue = new TransferQueue({ concurrency: 0 });

    expect(queue.stats.concurrency).toBe(1);
    queue.setConcurrency(-4);
    expect(queue.stats.concurrency).toBe(1);
  });

  it('reports what it is doing', async () => {
    const queue = new TransferQueue({ concurrency: 1 });
    const gate = deferred();
    const tasks = [queue.add(1, () => gate.promise), queue.add(2, () => gate.promise)];

    expect(queue.stats).toMatchObject({ running: 1, queued: 1, completed: 0 });
    gate.resolve();
    await Promise.all(tasks);
    expect(queue.stats).toMatchObject({ running: 0, queued: 0, completed: 2 });
  });

  it('is idle and harmless when nothing is queued', () => {
    expect(new TransferQueue().stats).toEqual({
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      concurrency: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// Policy and link speed
// ---------------------------------------------------------------------------

describe('concurrencyFor', () => {
  it('serialises once a bandwidth limit is in force', () => {
    expect(concurrencyFor(1024)).toBe(1);
  });

  it('uses the full width when there is no limit', () => {
    expect(concurrencyFor(null)).toBe(4);
    expect(concurrencyFor(0)).toBe(4);
    expect(concurrencyFor(null, 8)).toBe(8);
  });
});

describe('kbpsToBytesPerSecond', () => {
  it('converts kbit/s to bytes per second', () => {
    expect(kbpsToBytesPerSecond(8)).toBe(1000);
    expect(kbpsToBytesPerSecond(1_000)).toBe(125_000);
  });

  it('treats absent or non-positive limits as unlimited', () => {
    expect(kbpsToBytesPerSecond(null)).toBeNull();
    expect(kbpsToBytesPerSecond(0)).toBeNull();
    expect(kbpsToBytesPerSecond(-1)).toBeNull();
  });
});

describe('readLinkSpeedMbps', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tnc-sysfs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const iface = (name: string, speed: string): void => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'speed'), speed);
  };

  it('reads a negotiated speed', async () => {
    iface('eth0', '1000\n');

    expect(await readLinkSpeedMbps('eth0', root)).toBe(1000);
  });

  it('reports nothing for a down interface, which the kernel writes as -1', async () => {
    iface('eth1', '-1\n');

    expect(await readLinkSpeedMbps('eth1', root)).toBeNull();
  });

  it('reports nothing when the interface does not exist', async () => {
    expect(await readLinkSpeedMbps('nope', root)).toBeNull();
  });

  it('reports nothing for an unparseable value', async () => {
    iface('eth2', 'unknown');

    expect(await readLinkSpeedMbps('eth2', root)).toBeNull();
  });

  it('defaults to the real sysfs path and reports nothing for an absent interface', async () => {
    expect(await readLinkSpeedMbps('tnc-no-such-interface')).toBeNull();
  });

  it('notices a link that negotiated below its rating', async () => {
    iface('eth3', '10');

    // The whole point of surfacing this: a 10 Mbit negotiation explains a slow sync.
    expect(await readLinkSpeedMbps('eth3', root)).toBe(10);
  });
});
