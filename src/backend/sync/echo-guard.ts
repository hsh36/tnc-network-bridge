/**
 * The echo guard (T21) — IMPLEMENTATION_PLAN §3.2, risk R5.
 *
 * A bidirectional sync watches the directories it writes to. Every write it makes
 * therefore produces a filesystem event that looks exactly like a user's edit, which the
 * engine dutifully syncs back, producing another event. That is the classic failure mode
 * of this kind of product: it does not crash, it does not log an error, it simply copies
 * one file back and forth until the disk, the link, or the operator's patience gives out.
 *
 * Two independent defences, because the first one is not sufficient on its own:
 *
 * 1. **Expectation matching.** Before writing, the engine declares what it is about to
 *    produce — `(path, size, mtime)`. An event matching a live expectation is our own
 *    echo and is dropped. This is precise and cheap and handles the ordinary case.
 *
 * 2. **A rate limit.** More than ten syncs of one path in a minute is not work, it is a
 *    loop, whatever the cause. The path is quarantined and an alert is raised. This
 *    catches the loops expectation matching cannot: a third party rewriting the file, two
 *    bridges pointed at one share, a clock that moves backwards, or a bug in defence 1.
 *
 * The second defence exists precisely because the first is an optimisation of judgement
 * and the second is a hard bound. A guard with only the first is one missed edge case
 * away from the failure it was built to prevent.
 */

/** How long an expectation stays live. §3.2 specifies ten seconds. */
export const DEFAULT_TTL_MS = 10_000;

/** §3.2: more than ten syncs of one path in a minute is a loop. */
export const DEFAULT_MAX_SYNCS_PER_WINDOW = 10;
export const DEFAULT_WINDOW_MS = 60_000;

/**
 * Filesystems disagree about mtime resolution — ext4 keeps nanoseconds, FAT rounds to two
 * seconds, and SMB reports its own thing — so an exact match would miss our own writes on
 * the very mounts this bridge exists to join.
 */
export const DEFAULT_MTIME_TOLERANCE_MS = 1_000;

export interface EchoGuardOptions {
  readonly ttlMs?: number;
  readonly mtimeToleranceMs?: number;
  readonly maxSyncsPerWindow?: number;
  readonly windowMs?: number;
  /** Injected so a "loop trips within 60 seconds" test need not take a minute. */
  readonly now?: () => number;
  /**
   * Paths tracked for rate limiting before the least recently seen is forgotten.
   *
   * A bound matters: a share with a hundred thousand files must not grow a hundred
   * thousand permanent timestamp arrays in a process meant to run for months.
   */
  readonly maxTrackedPaths?: number;
  /** Called once when a path is quarantined, for the alert the operator actually sees. */
  readonly onQuarantine?: (event: QuarantineEvent) => void;
}

export interface ExpectedWrite {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ObservedEvent {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface QuarantineEvent {
  readonly path: string;
  readonly syncsInWindow: number;
  readonly windowMs: number;
  readonly at: number;
}

export interface EchoGuardStats {
  readonly liveExpectations: number;
  readonly dropped: number;
  readonly passed: number;
  readonly trackedPaths: number;
  readonly quarantined: number;
}

interface Expectation {
  readonly size: number;
  readonly mtimeMs: number;
  readonly expiresAt: number;
}

export class EchoGuard {
  private readonly expectations = new Map<string, Expectation[]>();
  private readonly syncTimes = new Map<string, number[]>();
  private readonly quarantined = new Map<string, QuarantineEvent>();

  private readonly ttlMs: number;
  private readonly mtimeToleranceMs: number;
  private readonly maxSyncsPerWindow: number;
  private readonly windowMs: number;
  private readonly maxTrackedPaths: number;
  private readonly now: () => number;
  private readonly onQuarantine: ((event: QuarantineEvent) => void) | undefined;

  private dropped = 0;
  private passed = 0;

  constructor(options: EchoGuardOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.mtimeToleranceMs = options.mtimeToleranceMs ?? DEFAULT_MTIME_TOLERANCE_MS;
    this.maxSyncsPerWindow = options.maxSyncsPerWindow ?? DEFAULT_MAX_SYNCS_PER_WINDOW;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxTrackedPaths = options.maxTrackedPaths ?? 10_000;
    this.now = options.now ?? Date.now;
    this.onQuarantine = options.onQuarantine;
  }

  /**
   * Declares a write the engine is about to make.
   *
   * Must be called **before** the write, not after: on a fast filesystem the watcher
   * event can arrive before the write call has even returned, and an expectation
   * registered afterwards would arrive too late to match it.
   */
  expect(write: ExpectedWrite): void {
    const list = this.expectations.get(write.path) ?? [];
    list.push({
      size: write.size,
      mtimeMs: write.mtimeMs,
      expiresAt: this.now() + this.ttlMs,
    });
    this.expectations.set(write.path, list);
  }

  /**
   * Whether an observed event is this bridge's own echo and should be discarded.
   *
   * A match does **not** consume the expectation. One write can raise several events —
   * a create and a change, or one per watcher when a scanner is running alongside — and
   * consuming on the first match would let the rest through, which is the loop this
   * exists to prevent. The TTL is what ends an expectation, not a single use.
   */
  shouldDrop(event: ObservedEvent): boolean {
    this.pruneExpired();
    const candidates = this.expectations.get(event.path);

    if (candidates !== undefined) {
      for (const candidate of candidates) {
        if (
          candidate.size === event.size &&
          Math.abs(candidate.mtimeMs - event.mtimeMs) <= this.mtimeToleranceMs
        ) {
          this.dropped += 1;
          return true;
        }
      }
    }

    this.passed += 1;
    return false;
  }

  /**
   * Records that a path was actually synced, and reports whether that tripped the limit.
   *
   * Returns `true` when the path is now quarantined — including when it was already, so
   * a caller that only checks this return value cannot resume syncing a looping path.
   */
  recordSync(path: string): boolean {
    const now = this.now();

    if (this.quarantined.has(path)) {
      return true;
    }

    const times = (this.syncTimes.get(path) ?? []).filter((at) => now - at < this.windowMs);
    times.push(now);

    // Re-insert to move the path to the back: `Map` iterates in insertion order, so the
    // first key is the least recently touched and is the right one to forget.
    this.syncTimes.delete(path);
    this.syncTimes.set(path, times);
    this.evictOldestTracked();

    if (times.length > this.maxSyncsPerWindow) {
      const event: QuarantineEvent = {
        path,
        syncsInWindow: times.length,
        windowMs: this.windowMs,
        at: now,
      };
      this.quarantined.set(path, event);
      // The alert is the point: a quarantined path has stopped syncing, and silently
      // not syncing a program is worse than the loop it replaced.
      this.onQuarantine?.(event);
      return true;
    }

    return false;
  }

  isQuarantined(path: string): boolean {
    return this.quarantined.has(path);
  }

  quarantineFor(path: string): QuarantineEvent | null {
    return this.quarantined.get(path) ?? null;
  }

  listQuarantined(): readonly QuarantineEvent[] {
    return [...this.quarantined.values()];
  }

  /**
   * Lifts a quarantine, forgetting the history that caused it.
   *
   * Deliberately manual. An automatic timed release would re-enter the loop on a schedule
   * and turn a stopped fault into a periodic one, which is harder to diagnose and no less
   * damaging.
   */
  release(path: string): boolean {
    this.syncTimes.delete(path);
    return this.quarantined.delete(path);
  }

  /** Drops expectations that have outlived their TTL. Called automatically. */
  pruneExpired(): void {
    const now = this.now();
    for (const [path, list] of this.expectations) {
      const live = list.filter((entry) => entry.expiresAt > now);
      if (live.length === 0) {
        this.expectations.delete(path);
      } else if (live.length !== list.length) {
        this.expectations.set(path, live);
      }
    }
  }

  get stats(): EchoGuardStats {
    let liveExpectations = 0;
    for (const list of this.expectations.values()) {
      liveExpectations += list.length;
    }
    return {
      liveExpectations,
      dropped: this.dropped,
      passed: this.passed,
      trackedPaths: this.syncTimes.size,
      quarantined: this.quarantined.size,
    };
  }

  /** Forgets everything. For a full resync, where past history says nothing useful. */
  clear(): void {
    this.expectations.clear();
    this.syncTimes.clear();
    this.quarantined.clear();
    this.dropped = 0;
    this.passed = 0;
  }

  private evictOldestTracked(): void {
    while (this.syncTimes.size > this.maxTrackedPaths) {
      const oldest = this.syncTimes.keys().next();
      /* istanbul ignore next -- the loop condition proves the map is non-empty */
      if (oldest.done === true) {
        return;
      }
      this.syncTimes.delete(oldest.value);
    }
  }
}
