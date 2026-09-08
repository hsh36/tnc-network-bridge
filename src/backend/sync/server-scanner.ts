import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { type FileSide } from '../../shared/schemas/file-index';
import { type Clock, systemClock } from './throttle';

/**
 * The file index and server scanner (T15).
 *
 * ## Why a scanner exists at all when there is also a watcher
 *
 * The local cache is watched with inotify (T17), which is immediate and cheap. The server
 * side cannot be: it is a CIFS mount, and inotify does not see changes made by *other*
 * SMB clients — the CAD workstation that just dropped a new program into the share never
 * touches this Pi's kernel. Polling the mount is therefore not a fallback, it is the only
 * mechanism that can observe the other half of a bidirectional sync (risk R4). Everything
 * awkward about this module follows from that one fact.
 *
 * ## The three things the scan has to get right
 *
 * 1. **It must not block the API.** The walk runs in a worker thread, because `readdir`
 *    on a dead CIFS mount blocks in uninterruptible kernel I/O rather than failing, and
 *    on the main thread that would take the whole bridge down with the file server
 *    (risk R3). A worker can additionally be *terminated* when it stalls, which no
 *    main-thread call can be.
 *
 * 2. **A deletion must be distinguishable from a failed scan.** Both look identical from
 *    the outside: paths that were there last time are not there now. The distinction is
 *    the generation counter — each scan stamps every path it observes with its own
 *    number, and only a scan that *completed* is allowed to reap the paths that were not
 *    stamped. A partial walk reaps nothing. Getting this backwards would let one
 *    transient mount error propagate as the deletion of every program on the machine.
 *
 * 3. **It must be cheap when nothing is happening.** A share nobody is touching gets
 *    scanned every two minutes; a share in active use gets scanned every five seconds.
 *    The interval walks between the two based on what the last scans actually found, so
 *    the machine is not paying for a five-second poll of a quiet share all night.
 *
 * ## Case-insensitivity
 *
 * SMB treats `PART1.H` and `part1.h` as one file; ext4 treats them as two. So the index
 * additionally keys every path by its lowercase form, and a bucket holding more than one
 * spelling is a case collision — which the diff engine turns into a `SKIP` rather than
 * letting two files quietly overwrite each other through the bridge.
 */

// ---------------------------------------------------------------------------
// The shapes that cross the worker boundary
// ---------------------------------------------------------------------------

/** One filesystem entry as the walk observed it. */
export interface ScanEntry {
  /** POSIX-shaped path relative to the scan root, on every platform. */
  readonly relPath: string;
  readonly isDir: boolean;
  /** Always 0 for directories. */
  readonly size: number;
  /** Epoch milliseconds, floored. Always 0 for directories. */
  readonly mtimeMs: number;
}

export interface WalkRequest {
  readonly root: string;
  readonly excludes?: readonly string[];
  readonly chunkSize?: number;
  /** A hard ceiling, so a mount pointed at the wrong directory cannot scan forever. */
  readonly maxEntries?: number;
}

export interface WalkStats {
  readonly files: number;
  readonly directories: number;
  /** Entries skipped as unreadable, vanished, symlinks or non-regular files. */
  readonly skipped: number;
  readonly excluded: number;
  readonly truncated: boolean;
  readonly durationMs: number;
  /** `0` on the main thread; the worker's own id otherwise. The isolation proof. */
  readonly threadId: number;
}

/**
 * How a scan gets its entries.
 *
 * A port, so the scheduling, diffing and generation logic can be tested without spawning
 * a thread per assertion — and so a future scanner backed by something other than a
 * filesystem walk (SMB change notifications, say) can be dropped in without touching any
 * of it.
 */
export interface ScanWalker {
  walk(request: WalkRequest, onChunk: (entries: readonly ScanEntry[]) => void): Promise<WalkStats>;
  close(): Promise<void>;
}

interface WorkerModule {
  walk(request: WalkRequest, onChunk: (entries: readonly ScanEntry[]) => void): Promise<WalkStats>;
}

/**
 * Resolves `scan-worker.cjs` next to this module.
 *
 * `__dirname` is `src/backend/sync` under Jest and `tsx`, and `dist/backend/sync` in
 * production, where `scripts/copy-assets.mjs` has placed the same file. One path
 * expression covers all three.
 */
export const scanWorkerPath = (): string => join(__dirname, 'scan-worker.cjs');

// ---------------------------------------------------------------------------
// Walkers
// ---------------------------------------------------------------------------

/**
 * Runs the walk on the calling thread.
 *
 * For tests, and for the one production case where a worker is the wrong tool: the local
 * cache is a local disk, where a stall is not a realistic failure and a thread per scan
 * is pure overhead.
 */
export class InlineScanWalker implements ScanWalker {
  private readonly module: WorkerModule;

  constructor(modulePath: string = scanWorkerPath()) {
    // `createRequire` rather than a bare `require`: this file is compiled to CommonJS
    // today, but the resolution must not silently break if that ever changes.
    const load = createRequire(__filename);
    this.module = load(modulePath) as WorkerModule;
  }

  walk(request: WalkRequest, onChunk: (entries: readonly ScanEntry[]) => void): Promise<WalkStats> {
    return this.module.walk(request, onChunk);
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

export class WalkTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the scan walk did not finish within ${timeoutMs} ms and was terminated`);
    this.name = 'WalkTimeoutError';
  }
}

/**
 * Runs each walk in its own short-lived worker thread.
 *
 * A thread per scan rather than a pooled one, deliberately. Scans are seconds apart and a
 * thread costs single-digit milliseconds to start, so the pool would save nothing
 * measurable — while costing the two properties that matter here: a fresh thread carries
 * no state from the previous scan (which is what keeps memory flat over a hundred
 * consecutive scans), and a thread with exactly one job can be terminated on timeout
 * without any question of what else was running on it.
 */
export class WorkerScanWalker implements ScanWalker {
  private active: Worker | null = null;
  private closed = false;

  constructor(
    private readonly modulePath: string = scanWorkerPath(),
    /** How long a walk may take before the thread is killed. Default 5 minutes. */
    private readonly timeoutMs: number = 5 * 60_000,
  ) {}

  walk(request: WalkRequest, onChunk: (entries: readonly ScanEntry[]) => void): Promise<WalkStats> {
    if (this.closed) {
      return Promise.reject(new Error('this walker has been closed'));
    }

    return new Promise<WalkStats>((resolve, reject) => {
      const worker = new Worker(this.modulePath, { workerData: request });
      this.active = worker;

      let settled = false;
      const timer = setTimeout(() => {
        finish(() => {
          reject(new WalkTimeoutError(this.timeoutMs));
        });
      }, this.timeoutMs);
      // A scan must never be the reason the process stays alive at shutdown.
      timer.unref();

      const finish = (settle: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.active = null;
        // `terminate()` on an already-exited worker is a no-op, so this is safe on
        // every path and guarantees no thread outlives its promise.
        void worker.terminate();
        settle();
      };

      worker.on('message', (message: WorkerMessage) => {
        switch (message.type) {
          case 'chunk':
            // Chunks are delivered as they arrive rather than accumulated here: the
            // whole point of chunking is that neither thread holds the entire tree.
            onChunk(message.entries);
            break;
          case 'done':
            finish(() => {
              resolve(message.stats);
            });
            break;
          case 'error':
            finish(() => {
              const error = new Error(message.message);
              if (message.code !== '') {
                (error as NodeJS.ErrnoException).code = message.code;
              }
              reject(error);
            });
            break;
        }
      });

      worker.on('error', (error) => {
        finish(() => {
          reject(error);
        });
      });

      worker.on('exit', (code) => {
        // Only meaningful if it fires *before* a result: a worker that exits without
        // reporting anything has crashed, and silently resolving would look to the
        // generation reaper like a completed scan that found an empty share.
        finish(() => {
          reject(new Error(`the scan worker exited unexpectedly with code ${code}`));
        });
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.active;
    this.active = null;
    if (worker !== null) {
      await worker.terminate();
    }
  }
}

type WorkerMessage =
  | { readonly type: 'chunk'; readonly entries: readonly ScanEntry[] }
  | { readonly type: 'done'; readonly stats: WalkStats }
  | { readonly type: 'error'; readonly message: string; readonly code: string };

// ---------------------------------------------------------------------------
// The file index
// ---------------------------------------------------------------------------

export interface IndexedEntry {
  readonly relPath: string;
  readonly isDir: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  /** The scan generation that last observed this path. */
  readonly generation: number;
}

export type ChangeType = 'added' | 'modified' | 'removed';

export interface ScanChange {
  readonly type: ChangeType;
  readonly relPath: string;
  readonly isDir: boolean;
  /** The observed side after the change; `null` for a removal. */
  readonly side: FileSide | null;
  /** What the index held before, for a modification or removal. */
  readonly previous: FileSide | null;
}

/**
 * The in-memory index of one side of one share.
 *
 * Deliberately not the SQLite table. The scan compares against this on every pass, at
 * ten thousand paths a time; going to the database for each would turn a two-second scan
 * into a minute of query overhead for data that is, by definition, a cache of what the
 * filesystem says. The durable `file_index` row is written by the orchestrator when a
 * path's *sync state* changes, which is a far rarer event than observing that a path
 * still exists.
 */
export class FileIndex {
  private readonly entries = new Map<string, IndexedEntry>();
  /** Lowercased path → every real spelling seen under it. */
  private readonly ciBuckets = new Map<string, Set<string>>();
  private currentGeneration = 0;

  get generation(): number {
    return this.currentGeneration;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Opens a new generation and returns its number. */
  beginScan(): number {
    this.currentGeneration += 1;
    return this.currentGeneration;
  }

  get(relPath: string): IndexedEntry | null {
    return this.entries.get(relPath) ?? null;
  }

  paths(): readonly string[] {
    return [...this.entries.keys()];
  }

  /**
   * Records one observed entry, returning the change it represents.
   *
   * Comparison is exact on `(size, mtimeMs)`. No tolerance is wanted here — unlike the
   * diff engine, which compares *two different filesystems* and must forgive their
   * differing mtime resolutions, this compares one filesystem against itself one scan
   * ago, where any difference at all is a real difference.
   */
  observe(entry: ScanEntry, generation: number): ScanChange | null {
    const existing = this.entries.get(entry.relPath);

    this.entries.set(entry.relPath, {
      relPath: entry.relPath,
      isDir: entry.isDir,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      generation,
    });

    if (existing === undefined) {
      const bucketKey = entry.relPath.toLowerCase();
      const bucket = this.ciBuckets.get(bucketKey);
      if (bucket === undefined) {
        this.ciBuckets.set(bucketKey, new Set([entry.relPath]));
      } else {
        bucket.add(entry.relPath);
      }

      return {
        type: 'added',
        relPath: entry.relPath,
        isDir: entry.isDir,
        side: sideOf(entry),
        previous: null,
      };
    }

    // A directory that has become a file (or the reverse) is a change of kind, not of
    // content, and the two sides of the bridge must both be told about it.
    const changed =
      existing.size !== entry.size ||
      existing.mtimeMs !== entry.mtimeMs ||
      existing.isDir !== entry.isDir;

    if (!changed) {
      return null;
    }

    return {
      type: 'modified',
      relPath: entry.relPath,
      isDir: entry.isDir,
      side: sideOf(entry),
      previous: sideOf(existing),
    };
  }

  /**
   * Removes every path not stamped with `generation` and reports them as deletions.
   *
   * Only ever called after a walk that completed. This is the single most destructive
   * operation in the sync engine — it is what turns "I did not see that file" into "that
   * file was deleted, delete it on the other side too" — so the caller's obligation to
   * have a *successful* walk behind it is not a detail, it is the safety property.
   */
  reap(generation: number): readonly ScanChange[] {
    const removed: ScanChange[] = [];

    for (const [relPath, entry] of this.entries) {
      if (entry.generation === generation) {
        continue;
      }
      this.entries.delete(relPath);
      this.forgetCase(relPath);
      removed.push({
        type: 'removed',
        relPath,
        isDir: entry.isDir,
        side: null,
        previous: sideOf(entry),
      });
    }

    return removed;
  }

  /** Whether another indexed path differs from this one only by case. */
  hasCaseCollision(relPath: string): boolean {
    const bucket = this.ciBuckets.get(relPath.toLowerCase());
    return bucket !== undefined && bucket.size > 1;
  }

  /** Every set of paths that differ only by case. */
  caseCollisions(): readonly (readonly string[])[] {
    const collisions: string[][] = [];
    for (const bucket of this.ciBuckets.values()) {
      if (bucket.size > 1) {
        collisions.push([...bucket]);
      }
    }
    return collisions;
  }

  clear(): void {
    this.entries.clear();
    this.ciBuckets.clear();
  }

  private forgetCase(relPath: string): void {
    const key = relPath.toLowerCase();
    const bucket = this.ciBuckets.get(key);
    if (bucket === undefined) {
      return;
    }
    bucket.delete(relPath);
    if (bucket.size === 0) {
      this.ciBuckets.delete(key);
    }
  }
}

const sideOf = (entry: ScanEntry | IndexedEntry): FileSide => ({
  size: entry.size,
  mtime: entry.mtimeMs,
  // The scanner never hashes: that costs a full read of every file on the share, on
  // every pass. T16 hashes lazily, and only when `(size, mtime)` was not conclusive.
  hash: null,
});

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/** §T15: the adaptive interval's bounds. */
export const MIN_SCAN_INTERVAL_MS = 5_000;
export const MAX_SCAN_INTERVAL_MS = 120_000;

/** How fast a quiet share backs off. 2× reaches the ceiling in five idle scans. */
export const BACKOFF_FACTOR = 2;

export const DEFAULT_MAX_ENTRIES = 500_000;

export interface ServerScannerOptions {
  readonly shareId: number;
  /** Absolute path to the scan root — the CIFS mount point for a server-side scan. */
  readonly root: string;
  readonly excludes?: readonly string[];
  readonly walker?: ScanWalker;
  readonly clock?: Clock;
  readonly minIntervalMs?: number;
  readonly maxIntervalMs?: number;
  readonly chunkSize?: number;
  readonly maxEntries?: number;
  /** Reuse an existing index — a restart that has already loaded `file_index`. */
  readonly index?: FileIndex;
}

export interface ScanResult {
  readonly shareId: number;
  readonly generation: number;
  readonly changes: readonly ScanChange[];
  readonly stats: WalkStats;
  /** Paths held in the index after this scan. */
  readonly indexed: number;
  /** The interval chosen for the next scan, in milliseconds. */
  readonly nextIntervalMs: number;
  /** Epoch milliseconds at which this scan began. */
  readonly startedAt: number;
}

export interface ScanFailure {
  readonly shareId: number;
  readonly generation: number;
  readonly error: string;
  readonly startedAt: number;
}

/**
 * Polls one directory tree and reports what changed since the last pass.
 *
 * Events: `scan` ({@link ScanResult}), `change` ({@link ScanChange}, one per change),
 * `scan-error` ({@link ScanFailure}), and `interval` when the adaptive period moves.
 *
 * The failure event is deliberately *not* called `error`. Node treats an `error` event
 * with no listener as a fatal, process-terminating throw — so a scanner firing on a timer
 * in the background would take the whole bridge down the first time a mount hiccuped
 * while nobody happened to be listening. That is precisely the failure this module was
 * built to contain, and it would be perverse to reintroduce it through the event name.
 */
export class ServerScanner extends EventEmitter {
  readonly shareId: number;
  readonly index: FileIndex;

  private readonly root: string;
  private readonly excludes: readonly string[];
  private readonly walker: ScanWalker;
  private readonly clock: Clock;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly chunkSize: number | undefined;
  private readonly maxEntries: number;

  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  /** The scan a timer started and has not finished, so `stop()` can wait for it. */
  private inFlight: Promise<unknown> | null = null;
  /** Consecutive completed scans that found nothing. Drives the back-off. */
  private quietScans = 0;

  constructor(options: ServerScannerOptions) {
    super();
    this.shareId = options.shareId;
    this.root = options.root;
    this.excludes = options.excludes ?? [];
    this.walker = options.walker ?? new WorkerScanWalker();
    this.clock = options.clock ?? systemClock;
    this.minIntervalMs = options.minIntervalMs ?? MIN_SCAN_INTERVAL_MS;
    this.maxIntervalMs = options.maxIntervalMs ?? MAX_SCAN_INTERVAL_MS;
    this.chunkSize = options.chunkSize;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.index = options.index ?? new FileIndex();
    this.intervalMs = this.minIntervalMs;
  }

  /** The interval the next scheduled scan will wait, in milliseconds. */
  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  get isScanning(): boolean {
    return this.running;
  }

  /**
   * Runs one scan.
   *
   * Never throws for a walk failure: a share whose mount has gone away is a condition to
   * report, not an exception to propagate into whatever timer happened to fire. The one
   * thing it does throw for is being called while a scan is already in flight, which is
   * a caller bug rather than an environmental one.
   */
  async scanOnce(): Promise<ScanResult | null> {
    if (this.running) {
      throw new Error(`share ${this.shareId} is already scanning`);
    }
    this.running = true;

    const startedAt = this.clock.now();
    const generation = this.index.beginScan();
    const changes: ScanChange[] = [];

    try {
      const request: WalkRequest = {
        root: this.root,
        excludes: this.excludes,
        maxEntries: this.maxEntries,
        ...(this.chunkSize === undefined ? {} : { chunkSize: this.chunkSize }),
      };

      const stats = await this.walker.walk(request, (entries) => {
        for (const entry of entries) {
          const change = this.index.observe(entry, generation);
          if (change !== null) {
            changes.push(change);
          }
        }
      });

      // Only here — after a walk that returned rather than threw — may absence be read
      // as deletion. A truncated walk is *not* a completed one: it stopped early by
      // design, so the paths beyond the ceiling were never looked at.
      if (!stats.truncated) {
        changes.push(...this.index.reap(generation));
      }

      const nextIntervalMs = this.adapt(changes.length);

      const result: ScanResult = {
        shareId: this.shareId,
        generation,
        changes,
        stats,
        indexed: this.index.size,
        nextIntervalMs,
        startedAt,
      };

      for (const change of changes) {
        this.emit('change', change);
      }
      this.emit('scan', result);
      return result;
    } catch (error) {
      // The generation is simply abandoned. Every path keeps the stamp of the last scan
      // that did complete, so the next successful scan compares against a truthful
      // baseline and nothing is reaped on the strength of a walk that failed.
      const failure: ScanFailure = {
        shareId: this.shareId,
        generation,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
      };
      // A failed scan is also a reason to slow down: hammering a mount that is not
      // answering helps nobody, and the watcher still covers the local side meanwhile.
      this.adapt(0);
      this.emit('scan-error', failure);
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Chooses the next interval from what this scan found.
   *
   * Any change at all snaps straight back to the floor — a share someone is working in
   * should feel responsive on the very next pass, not after a gradual ramp. Quiet scans
   * double the wait up to the ceiling. The asymmetry is the point: being slow to notice
   * the first change of a working day is a much worse failure than scanning a dormant
   * share once more than strictly necessary.
   */
  private adapt(changeCount: number): number {
    const previous = this.intervalMs;

    if (changeCount > 0) {
      this.quietScans = 0;
      this.intervalMs = this.minIntervalMs;
    } else {
      this.quietScans += 1;
      this.intervalMs = Math.min(this.maxIntervalMs, this.intervalMs * BACKOFF_FACTOR);
    }

    if (this.intervalMs !== previous) {
      this.emit('interval', {
        shareId: this.shareId,
        intervalMs: this.intervalMs,
        previousIntervalMs: previous,
        quietScans: this.quietScans,
      });
    }
    return this.intervalMs;
  }

  /**
   * Begins scanning on the adaptive interval.
   *
   * Self-rescheduling rather than `setInterval`: the period changes after every scan,
   * and a fixed interval would also let a slow scan overlap the next tick — two walks of
   * the same mount at once being exactly the load a stalling mount does not need.
   */
  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.schedule(0);
  }

  /**
   * Stops scanning and releases the walker. Safe to call twice.
   *
   * Waits for a scan that is already running rather than abandoning it. Cancelling the
   * timer only prevents the *next* scan; a scan already in flight would otherwise go on to
   * emit its `scan` and `change` events after this method had resolved, into an
   * orchestrator entitled to believe that a stopped scanner is finished with it. Worse,
   * closing the walker underneath a live walk would fail that scan for no reason other
   * than that we asked it to stop. So the in-flight scan is awaited first, and only then
   * is the walker released.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // `tick` swallows scan failures, so this settles regardless of how the scan went.
    await this.inFlight;
    await this.walker.close();
  }

  /** Forces the next scheduled scan to happen at the floor interval. */
  resetInterval(): void {
    this.quietScans = 0;
    this.intervalMs = this.minIntervalMs;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    // An unref'd timer: a pending scan must not hold the process open during shutdown.
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped) {
      return;
    }

    const scan = this.scanOnce();
    this.inFlight = scan;
    try {
      await scan;
    } catch {
      /* scanOnce already reported it; a timer callback must never reject */
    } finally {
      this.inFlight = null;
    }

    this.schedule(this.intervalMs);
  }
}

/**
 * A tiny convenience for the orchestrator's `SyncPorts`, which wants two of the index's
 * questions and none of the scanner's machinery.
 */
export const portsFromIndex = (
  index: FileIndex,
): { listPaths(): Promise<readonly string[]>; hasCaseCollision(relPath: string): boolean } => ({
  listPaths: () => Promise.resolve(index.paths()),
  hasCaseCollision: (relPath) => index.hasCaseCollision(relPath),
});
