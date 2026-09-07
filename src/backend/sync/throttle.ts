import { readFile } from 'node:fs/promises';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Bandwidth throttling and the transfer queue (T20) — IMPLEMENTATION_PLAN §3.3.
 *
 * Two separate jobs that are easy to confuse:
 *
 * - the **token bucket** limits how fast bytes move, so the bridge cannot saturate a
 *   shop-floor link that a machine is also using;
 * - the **queue** limits how many transfers run at once and decides which goes next.
 *
 * ## Why a limit implies concurrency 1
 *
 * A bandwidth cap shared between four concurrent transfers still totals the cap, so the
 * *link* is protected either way. What is not protected is latency: four large files
 * sharing 1 Mbit each take four times as long to finish as one file at 4 Mbit, and the
 * operator waiting for the first one cannot tell the difference between "slow" and
 * "stuck". So when a limit is configured the queue serialises, and files complete in
 * order instead of all crawling together.
 *
 * ## Small files first, but not forever
 *
 * R13: a 200 MB video in the share must not hold up the 4 KB program someone is waiting
 * for at the machine, so the queue is ordered by size. Left there, that rule starves the
 * large file permanently on a busy share — the queue would always have something smaller.
 * So a waiting task earns priority over time and eventually outranks the small work. The
 * ordering is a preference, not a caste system.
 */

/** The plan's refill rate: ten times a second. */
export const REFILL_HZ = 10;
const REFILL_INTERVAL_MS = 1000 / REFILL_HZ;

/** Injected so a 60-second throughput assertion does not take 60 seconds. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/**
 * A token bucket over a byte stream.
 *
 * `null` or a non-positive rate means unlimited, and is a genuinely free path: no timers,
 * no bookkeeping, no accumulated floating-point drift on a bridge that mostly runs
 * without a cap.
 *
 * A consume larger than the bucket's whole capacity is drained across several refills
 * rather than rejected. Without that, any chunk bigger than a tenth of a second's worth
 * of bandwidth would deadlock the stream — which at 1 Mbit/s is every chunk.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private rate: number;

  constructor(
    bytesPerSecond: number | null,
    private readonly clock: Clock = systemClock,
  ) {
    this.rate = bytesPerSecond === null || bytesPerSecond <= 0 ? 0 : bytesPerSecond;
    this.tokens = this.capacity;
    this.lastRefillAt = clock.now();
  }

  /** One refill interval's worth of bytes: the burst the bucket will ever allow. */
  get capacity(): number {
    return this.rate / REFILL_HZ;
  }

  get bytesPerSecond(): number {
    return this.rate;
  }

  get unlimited(): boolean {
    return this.rate === 0;
  }

  /**
   * Changes the rate, taking effect on transfers already in flight.
   *
   * A schedule that lowers the cap during production hours must slow the copy that is
   * already running, not merely the next one — the next one may be an hour away. In-flight
   * tokens are clamped rather than discarded, so lowering the rate cannot hand a stream a
   * burst it was never entitled to.
   */
  setRate(bytesPerSecond: number | null): void {
    this.refill();
    this.rate = bytesPerSecond === null || bytesPerSecond <= 0 ? 0 : bytesPerSecond;
    this.tokens = Math.min(this.tokens, this.capacity);
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.lastRefillAt);
    this.lastRefillAt = now;
    if (this.rate > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.rate);
    }
  }

  /** Blocks until `bytes` have been paid for. Returns immediately when unlimited. */
  async consume(bytes: number): Promise<void> {
    if (this.rate === 0 || bytes <= 0) {
      return;
    }

    let outstanding = bytes;
    while (outstanding > 0) {
      this.refill();
      const taken = Math.min(this.tokens, outstanding);
      this.tokens -= taken;
      outstanding -= taken;

      if (outstanding > 0) {
        // Wait only as long as the outstanding bytes actually need, but never longer
        // than one refill interval, so a rate change is picked up promptly.
        const needed = (outstanding / this.rate) * 1000;
        await this.clock.sleep(Math.min(REFILL_INTERVAL_MS, Math.max(1, needed)));
      }
    }
  }
}

/**
 * A `Transform` that passes bytes through at no more than the bucket's rate.
 *
 * It throttles on the way *through* rather than by pausing the source, so the limit
 * applies to a copy regardless of how the reader is producing data.
 */
export class ThrottleStream extends Transform {
  constructor(private readonly bucket: TokenBucket) {
    super();
  }

  /**
   * `chunk` is always a `Buffer`: a `Transform` decodes string writes for us unless
   * `decodeStrings: false` is set, which this stream does not set. Accepting a string
   * here too would be a branch no input can reach.
   */
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bucket.consume(chunk.length).then(
      () => {
        callback(null, chunk);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** Concurrency the plan prescribes: 4 normally, 1 once a bandwidth limit is in force. */
export function concurrencyFor(bandwidthLimitBytesPerSecond: number | null, base = 4): number {
  return bandwidthLimitBytesPerSecond !== null && bandwidthLimitBytesPerSecond > 0 ? 1 : base;
}

export interface QueueOptions {
  readonly concurrency?: number;
  readonly clock?: Clock;
  /**
   * How much a task's effective size shrinks per second spent waiting.
   *
   * This is what stops "small files first" from becoming "large files never". Zero
   * disables aging and restores strict size order.
   */
  readonly agingBytesPerSecond?: number;
}

export interface QueueStats {
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly concurrency: number;
}

interface Waiting<T> {
  readonly size: number;
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly run: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const DEFAULT_AGING_BYTES_PER_SECOND = 1024 * 1024;

/**
 * A size-ordered, concurrency-limited work queue.
 *
 * Ordering is by effective size — the file's size less what it has earned by waiting — so
 * a small program jumps ahead of a large one, and a large one that has waited long enough
 * stops being jumped.
 */
export class TransferQueue {
  private readonly waiting: Waiting<never>[] = [];
  private readonly clock: Clock;
  private readonly agingBytesPerSecond: number;
  private limit: number;
  private active = 0;
  private sequence = 0;
  private completed = 0;
  private failed = 0;

  constructor(options: QueueOptions = {}) {
    this.limit = Math.max(1, options.concurrency ?? 4);
    this.clock = options.clock ?? systemClock;
    this.agingBytesPerSecond = options.agingBytesPerSecond ?? DEFAULT_AGING_BYTES_PER_SECOND;
  }

  get stats(): QueueStats {
    return {
      queued: this.waiting.length,
      running: this.active,
      completed: this.completed,
      failed: this.failed,
      concurrency: this.limit,
    };
  }

  /**
   * Changes how many transfers may run at once.
   *
   * Raising it starts more work immediately. Lowering it never cancels anything already
   * running — a transfer is not interruptible without leaving debris, so the new limit
   * takes hold as the current work drains.
   */
  setConcurrency(value: number): void {
    this.limit = Math.max(1, value);
    this.pump();
  }

  /** Queues work, resolving with its result. `size` decides its place in the queue. */
  add<T>(size: number, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting<T> = {
        size,
        enqueuedAt: this.clock.now(),
        sequence: this.sequence++,
        run,
        resolve,
        reject,
      };
      this.waiting.push(entry as unknown as Waiting<never>);
      this.pump();
    });
  }

  /** Size less the credit earned by waiting. Lower goes first. */
  private effectiveSize(entry: Waiting<never>, now: number): number {
    const waitedSeconds = Math.max(0, now - entry.enqueuedAt) / 1000;
    return entry.size - waitedSeconds * this.agingBytesPerSecond;
  }

  private takeNext(): Waiting<never> | undefined {
    if (this.waiting.length === 0) {
      return undefined;
    }
    const now = this.clock.now();
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    // `entries()` rather than an index loop: it yields defined elements, so there is no
    // cast to write and no impossible "undefined element" branch to leave untested.
    for (const [index, candidate] of this.waiting.entries()) {
      const score = this.effectiveSize(candidate, now);
      // Strictly less-than, so ties break by arrival and equal-sized files keep a
      // predictable order.
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    return this.waiting.splice(bestIndex, 1)[0];
  }

  private pump(): void {
    while (this.active < this.limit) {
      const next = this.takeNext();
      if (next === undefined) {
        return;
      }

      this.active += 1;
      void (async () => {
        try {
          next.resolve(await next.run());
          this.completed += 1;
        } catch (error) {
          this.failed += 1;
          next.reject(error);
        } finally {
          this.active -= 1;
          this.pump();
        }
      })();
    }
  }
}

// ---------------------------------------------------------------------------
// Link speed
// ---------------------------------------------------------------------------

/**
 * Reads an interface's negotiated speed in Mbit/s.
 *
 * Context for the operator rather than an input to the throttle: a 100 Mbit link that
 * negotiated at 10 explains a slow sync far better than any throughput graph. Returns
 * `null` when the file is absent, unreadable, or holds `-1` — which is what the kernel
 * reports for a down interface, and is not a speed.
 */
export async function readLinkSpeedMbps(
  iface: string,
  sysfsRoot = '/sys/class/net',
): Promise<number | null> {
  try {
    const raw = await readFile(`${sysfsRoot}/${iface}/speed`, 'utf8');
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Convenience: the plan configures kbit/s, the bucket counts bytes. */
export function kbpsToBytesPerSecond(kbps: number | null): number | null {
  if (kbps === null || kbps <= 0) {
    return null;
  }
  return (kbps * 1000) / 8;
}
