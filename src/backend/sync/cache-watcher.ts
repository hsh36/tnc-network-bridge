import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, type Stats } from 'node:fs';
import { relative, sep } from 'node:path';
import chokidar, { type FSWatcher, type WatchOptions } from 'chokidar';
import picomatch from 'picomatch';
import type { EchoGuard } from './echo-guard';

/**
 * The local cache watcher (T17).
 *
 * The server side of the bridge is polled (T15) because nothing tells us when another SMB
 * client changes a file. The local side is the opposite: every change to the cache comes
 * through this machine's own kernel, so inotify sees it immediately and polling it would
 * be pure waste. That asymmetry is the reason these are two modules and not one.
 *
 * ## The half-written file problem
 *
 * A TNC does not write a program atomically. It opens the file, streams it over SMB 1.0
 * at whatever rate the machine's controller manages, and closes it — and inotify reports
 * every one of those writes. Syncing on the first event would push a truncated program to
 * the server, and a truncated NC program is not a corrupt file, it is a machine that
 * stops mid-cut or, worse, does not.
 *
 * So nothing is emitted until the file has held the same size and mtime for 750 ms
 * (`awaitWriteFinish`). This is the single most important setting in the module: it
 * trades three quarters of a second of latency for never handing the server a partial
 * program. On top of it sits a shorter per-path debounce, which coalesces the burst of
 * events a single save still produces into one.
 *
 * ## Why renames are detected rather than reported as delete + create
 *
 * inotify reports a rename as `unlink` on the old path and `add` on the new one. Treated
 * literally, that syncs a delete and then a full re-upload of a file whose bytes never
 * changed — over a link the throttle is deliberately keeping narrow. Correlating the two
 * by inode inside a short window turns it back into what it was, which the transfer
 * executor can satisfy with a server-side `rename()` and no bytes on the wire at all.
 *
 * ## Why the watcher can degrade
 *
 * inotify has a per-user watch limit (`fs.inotify.max_user_watches`), and a share with
 * tens of thousands of directories can exhaust it. The kernel's answer is `ENOSPC`, which
 * is a genuinely terrible name for "too many watches" and has cost every project that
 * hits it an afternoon. So it is caught explicitly, reported with the exact command that
 * fixes it, and answered by falling back to polling — slower and hungrier, but running.
 * A bridge that silently stopped noticing local changes would be far worse.
 */

/** §T17: how long a file must be quiet before it is considered fully written. */
export const DEFAULT_STABILITY_THRESHOLD_MS = 750;

/** How often chokidar re-stats a file it is waiting to settle. */
export const DEFAULT_STABILITY_POLL_MS = 100;

/** Per-path coalescing applied after stability, for the burst a single save still makes. */
export const DEFAULT_DEBOUNCE_MS = 200;

/**
 * How long an unlink waits for a matching add before it is believed to be a deletion.
 *
 * Necessarily longer than the stability threshold: the `add` half of a rename is itself
 * held back by `awaitWriteFinish`, so a shorter window would time out before the event it
 * exists to wait for could possibly arrive.
 */
export const DEFAULT_RENAME_WINDOW_MS = DEFAULT_STABILITY_THRESHOLD_MS + 750;

/** How often the root is checked for having been deleted underneath us. */
export const DEFAULT_ROOT_CHECK_MS = 1_000;

/** Polling interval used only after inotify has refused to give us more watches. */
export const DEGRADED_POLL_INTERVAL_MS = 2_000;

/**
 * What an operator has to do about `ENOSPC`, in the message itself.
 *
 * The remediation belongs here rather than in the docs because this error reaches the
 * user as a red banner at the moment their files stopped syncing, and at that moment
 * "see the documentation" is not an acceptable answer.
 */
export const INOTIFY_LIMIT_REMEDIATION =
  'The inotify watch limit has been reached (ENOSPC): the kernel refused to watch any ' +
  'more directories. Raise the limit with `sudo sysctl -w fs.inotify.max_user_watches=524288` ' +
  'and make it permanent by adding `fs.inotify.max_user_watches=524288` to ' +
  '/etc/sysctl.d/99-tnc-bridge.conf. The watcher has fallen back to polling, which still ' +
  'detects changes but uses more CPU and reports them more slowly.';

export type WatchEventType =
  | 'added'
  | 'changed'
  | 'removed'
  | 'renamed'
  | 'dir-added'
  | 'dir-removed';

export interface WatchEvent {
  readonly type: WatchEventType;
  /** POSIX-shaped path relative to the watch root. */
  readonly relPath: string;
  /** The previous path — only for a rename. */
  readonly from: string | null;
  /** Size in bytes; 0 for directories and removals. */
  readonly size: number;
  /** Epoch milliseconds, floored; 0 for directories and removals. */
  readonly mtimeMs: number;
}

/** Enough of a file to recognise it again after it has moved. */
interface Identity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly dev: number;
}

export type WatcherFactory = (root: string, options: WatchOptions) => FSWatcher;

export interface CacheWatcherOptions {
  readonly shareId: number;
  /** Absolute path to the local cache directory for this share. */
  readonly root: string;
  /** Glob patterns, matched by chokidar's anymatch against the relative path. */
  readonly excludes?: readonly string[];
  readonly stabilityThresholdMs?: number;
  readonly debounceMs?: number;
  readonly renameWindowMs?: number;
  readonly rootCheckMs?: number;
  /** Consulted before every content event, so the bridge never syncs its own writes. */
  readonly echoGuard?: EchoGuard;
  /** Recreate the root if it disappears. The bridge owns this directory. */
  readonly recreateRoot?: boolean;
  /** Injected by tests that need to drive a watcher which cannot be produced for real. */
  readonly watcherFactory?: WatcherFactory;
}

export interface WatchFailure {
  readonly shareId: number;
  readonly error: string;
  readonly code: string;
}

export interface DegradedEvent {
  readonly shareId: number;
  readonly reason: 'inotify_limit';
  readonly message: string;
}

/**
 * Watches one share's local cache directory.
 *
 * Events: `file` ({@link WatchEvent}), `watch-error` ({@link WatchFailure}), `degraded`
 * ({@link DegradedEvent}), `root-missing`, `root-restored`, and `rescan-required` when
 * the event stream has a gap only a full scan can close.
 *
 * As in the scanner, the failure event is `watch-error` and not `error`: Node turns an
 * unlistened `error` event into a process-killing throw, and a watcher that took the
 * bridge down because nobody was listening when a directory vanished would be a worse
 * bug than the one it was reporting.
 */
export class CacheWatcher extends EventEmitter {
  readonly shareId: number;
  readonly root: string;

  private readonly excludes: readonly string[];
  private readonly stabilityThresholdMs: number;
  private readonly debounceMs: number;
  private readonly renameWindowMs: number;
  private readonly rootCheckMs: number;
  private readonly guard: EchoGuard | null;
  private readonly recreateRoot: boolean;
  private readonly createWatcher: WatcherFactory;
  /** Chokidar's `ignored` predicate, over the relative path. Never excludes the root. */
  private readonly isExcluded: (path: string) => boolean;

  private watcher: FSWatcher | null = null;
  private rootTimer: NodeJS.Timeout | null = null;
  private started = false;
  private degraded = false;
  private rootMissing = false;
  /** True during the initial indexing pass, when events populate `known` but are not emitted. */
  private priming = false;

  /** What each known path looked like when it was last seen. The rename key. */
  private readonly known = new Map<string, Identity>();
  private readonly debounces = new Map<string, NodeJS.Timeout>();
  private readonly pendingUnlinks = new Map<string, { identity: Identity; timer: NodeJS.Timeout }>();

  constructor(options: CacheWatcherOptions) {
    super();
    this.shareId = options.shareId;
    this.root = options.root;
    this.excludes = options.excludes ?? [];
    this.stabilityThresholdMs = options.stabilityThresholdMs ?? DEFAULT_STABILITY_THRESHOLD_MS;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.renameWindowMs = options.renameWindowMs ?? DEFAULT_RENAME_WINDOW_MS;
    this.rootCheckMs = options.rootCheckMs ?? DEFAULT_ROOT_CHECK_MS;
    this.guard = options.echoGuard ?? null;
    this.recreateRoot = options.recreateRoot ?? true;
    this.createWatcher =
      options.watcherFactory ?? ((root, watchOptions) => chokidar.watch(root, watchOptions));

    const match =
      this.excludes.length > 0
        ? picomatch([...this.excludes], { dot: true, nocase: true })
        : () => false;
    this.isExcluded = (path: string): boolean => {
      const relPath = this.toRelative(path);
      // Excluding the root would exclude the entire share, which no pattern should ever
      // be able to do by accident.
      return relPath !== '' && match(relPath);
    };
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  get isWatching(): boolean {
    return this.watcher !== null;
  }

  /** Paths currently held in the rename window, waiting to be believed. */
  get pendingRemovals(): readonly string[] {
    return [...this.pendingUnlinks.keys()];
  }

  /**
   * Starts watching and resolves once the initial directory tree has been indexed.
   *
   * The initial contents are indexed but not emitted: the scanner has already inventoried
   * both sides, and replaying every existing file as an `added` event at startup would
   * queue a full resync of the share every time the service restarts.
   *
   * Note that this indexing is a real pass over the tree (`ignoreInitial: false` with
   * emission suppressed), not simply asking chokidar to stay quiet. Suppressing the events
   * at the source would leave `known` empty, and `known` is what the rename correlation
   * matches against — so the first rename of any file that predates the process would find
   * no pending identity to match and degrade into a delete plus a full re-upload. Since
   * every file predates the process immediately after a restart, that is the common case,
   * not the corner case. The cost is one `stabilityThreshold` of extra startup latency.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    if (this.recreateRoot && !existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
    }

    await this.openWatcher(false, true);
    this.startRootWatchdog();
  }

  /** Stops watching and releases every timer. Safe to call twice. */
  async stop(): Promise<void> {
    this.started = false;

    if (this.rootTimer !== null) {
      clearInterval(this.rootTimer);
      this.rootTimer = null;
    }
    for (const timer of this.debounces.values()) {
      clearTimeout(timer);
    }
    this.debounces.clear();
    for (const pending of this.pendingUnlinks.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingUnlinks.clear();

    await this.closeWatcher();
  }

  // -- Watcher lifecycle ----------------------------------------------------

  private async openWatcher(ignoreInitial: boolean, prime = false): Promise<void> {
    this.priming = prime;
    const options: WatchOptions = {
      // Native inotify. Polling a cache of tens of thousands of files would burn a core
      // of a four-core Pi to learn what the kernel will tell us for free.
      usePolling: this.degraded,
      ...(this.degraded ? { interval: DEGRADED_POLL_INTERVAL_MS } : {}),
      ignoreInitial,
      // Stats on every event, because the rename correlation is built on inode identity
      // and cannot ask for them after the file has already moved.
      alwaysStat: true,
      awaitWriteFinish: {
        stabilityThreshold: this.stabilityThresholdMs,
        pollInterval: DEFAULT_STABILITY_POLL_MS,
      },
      // A predicate over the *relative* path, not chokidar's default matching against
      // the absolute one. Otherwise `*.tmp` would silently never match, because the
      // string it is tested against begins `/srv/tnc-cache/...`, and the exclude list
      // would mean two different things in the scanner and here.
      ignored: this.isExcluded,
      // A cache directory is not a place for symlinks, and following one out of the
      // cache would put the sync engine to work on files outside the share entirely.
      followSymlinks: false,
    };

    const watcher = this.createWatcher(this.root, options);
    this.watcher = watcher;

    watcher.on('add', (path: string, stats?: Stats) => {
      this.onAdd(path, stats);
    });
    watcher.on('change', (path: string, stats?: Stats) => {
      this.onChange(path, stats);
    });
    watcher.on('unlink', (path: string) => {
      this.onUnlink(path);
    });
    watcher.on('addDir', (path: string) => {
      this.onDir(path, 'dir-added');
    });
    watcher.on('unlinkDir', (path: string) => {
      this.onDir(path, 'dir-removed');
    });
    watcher.on('error', (error: unknown) => {
      this.onWatchError(error);
    });

    await new Promise<void>((resolve) => {
      watcher.on('ready', () => {
        // Everything chokidar found during the initial walk is now in `known`; from here
        // on, events are real changes and are emitted.
        this.priming = false;
        resolve();
      });
    });
  }

  private async closeWatcher(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher !== null) {
      watcher.removeAllListeners();
      await watcher.close();
    }
  }

  /**
   * Handles a watcher-level error.
   *
   * `ENOSPC` is the only one with a specific answer, and it gets one. Everything else is
   * reported and survived — a watcher that threw on an unreadable subdirectory would stop
   * watching the other forty thousand files that are perfectly fine.
   */
  private onWatchError(error: unknown): void {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';

    if (code === 'ENOSPC' && !this.degraded) {
      this.degradeToPolling();
      return;
    }

    this.emit('watch-error', {
      shareId: this.shareId,
      error: error instanceof Error ? error.message : String(error),
      code,
    } satisfies WatchFailure);
  }

  /** Reopens the watcher in polling mode after inotify refused to grant more watches. */
  private degradeToPolling(): void {
    this.degraded = true;
    this.emit('degraded', {
      shareId: this.shareId,
      reason: 'inotify_limit',
      message: INOTIFY_LIMIT_REMEDIATION,
    } satisfies DegradedEvent);

    void this.restart(true).then(
      () => {
        // Polling starts from scratch, so anything that changed while the watcher was
        // being replaced was missed. Only a scan can close that gap honestly.
        this.emit('rescan-required', { shareId: this.shareId, reason: 'degraded' });
      },
      (error: unknown) => {
        this.onWatchError(error);
      },
    );
  }

  private async restart(ignoreInitial: boolean): Promise<void> {
    await this.closeWatcher();
    if (!this.started) {
      return;
    }
    await this.openWatcher(ignoreInitial);
  }

  /**
   * Notices that the watch root has been deleted, and recovers when it comes back.
   *
   * inotify watches an inode, not a name. Delete the directory and the watch dies with
   * it; recreate the directory and the watch does *not* come back, because the new
   * directory is a different inode that nothing is watching. The watcher would sit there
   * looking healthy and reporting nothing forever, which is the worst failure mode
   * available to it — so the root's existence is checked on a timer, and its return
   * triggers a genuine restart.
   */
  private startRootWatchdog(): void {
    this.rootTimer = setInterval(() => {
      this.checkRoot();
    }, this.rootCheckMs);
    this.rootTimer.unref();
  }

  private checkRoot(): void {
    if (!existsSync(this.root)) {
      if (!this.rootMissing) {
        this.rootMissing = true;
        this.emit('root-missing', { shareId: this.shareId, root: this.root });
      }
      if (this.recreateRoot) {
        try {
          mkdirSync(this.root, { recursive: true });
        } catch (error) {
          this.onWatchError(error);
        }
      }
      return;
    }

    if (!this.rootMissing) {
      return;
    }
    this.rootMissing = false;

    // `ignoreInitial: false` so whatever is in the recreated directory is announced.
    // Contents identical to what was already known are filtered out downstream, so a
    // directory that came back unchanged produces no events at all.
    void this.restart(false).then(
      () => {
        this.emit('root-restored', { shareId: this.shareId, root: this.root });
        this.emit('rescan-required', { shareId: this.shareId, reason: 'root_restored' });
      },
      (error: unknown) => {
        this.onWatchError(error);
      },
    );
  }

  // -- Event handling -------------------------------------------------------

  private onAdd(path: string, stats?: Stats): void {
    const relPath = this.toRelative(path);
    const identity = identityOf(stats);
    if (identity === null) {
      return;
    }

    if (this.priming) {
      // Index only. This is the pre-existing tree, not a change to it.
      this.known.set(relPath, identity);
      return;
    }

    const renamedFrom = this.matchPendingRename(identity);
    if (renamedFrom !== null) {
      this.known.delete(renamedFrom);
      this.known.set(relPath, identity);
      this.cancelDebounce(relPath);
      // Emitted immediately rather than debounced: the rename is already the *result* of
      // waiting out a window, and delaying it again would only widen the gap in which a
      // scan could see the file at neither path.
      this.emitEvent({
        type: 'renamed',
        relPath,
        from: renamedFrom,
        size: identity.size,
        mtimeMs: identity.mtimeMs,
      });
      return;
    }

    const previous = this.known.get(relPath);
    this.known.set(relPath, identity);

    if (previous !== undefined && sameContent(previous, identity)) {
      // A re-announcement after a restart, not a change. Silence is correct.
      return;
    }

    this.schedule(relPath, {
      type: previous === undefined ? 'added' : 'changed',
      relPath,
      from: null,
      size: identity.size,
      mtimeMs: identity.mtimeMs,
    });
  }

  private onChange(path: string, stats?: Stats): void {
    const relPath = this.toRelative(path);
    const identity = identityOf(stats);
    if (identity === null) {
      return;
    }

    const previous = this.known.get(relPath);
    if (previous !== undefined && sameContent(previous, identity)) {
      return;
    }
    this.known.set(relPath, identity);

    this.schedule(relPath, {
      type: 'changed',
      relPath,
      from: null,
      size: identity.size,
      mtimeMs: identity.mtimeMs,
    });
  }

  /**
   * Holds a deletion open for the rename window.
   *
   * Every rename begins as an unlink, and there is no way to tell the two apart at this
   * moment — only the arrival, or not, of a matching `add` decides it. Emitting the
   * deletion straight away would mean every rename briefly instructs the other side to
   * delete a file that still exists.
   */
  private onUnlink(path: string): void {
    const relPath = this.toRelative(path);
    const identity = this.known.get(relPath);
    this.known.delete(relPath);
    this.cancelDebounce(relPath);

    if (identity === undefined) {
      // Never seen it, so there is nothing to correlate and nothing to delay.
      this.emitEvent({ type: 'removed', relPath, from: null, size: 0, mtimeMs: 0 });
      return;
    }

    const existing = this.pendingUnlinks.get(relPath);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.pendingUnlinks.delete(relPath);
      this.emitEvent({ type: 'removed', relPath, from: null, size: 0, mtimeMs: 0 });
    }, this.renameWindowMs);
    timer.unref();

    this.pendingUnlinks.set(relPath, { identity, timer });
  }

  /**
   * Finds an unlink this add could be the other half of.
   *
   * Inode first: on ext4 a rename preserves it, which makes the match exact even for two
   * files with identical contents. The `(size, mtime)` fallback exists for filesystems
   * that do not report a usable inode — every SMB-backed mount, and Windows dev hosts —
   * where it is a heuristic rather than a proof, but a well-founded one over a window of
   * a second and a half.
   */
  private matchPendingRename(identity: Identity): string | null {
    for (const [relPath, pending] of this.pendingUnlinks) {
      if (!sameFile(pending.identity, identity)) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pendingUnlinks.delete(relPath);
      return relPath;
    }
    return null;
  }

  private onDir(path: string, type: 'dir-added' | 'dir-removed'): void {
    const relPath = this.toRelative(path);
    if (relPath === '' || this.priming) {
      // The root itself is not a member of the tree it roots; and during priming the
      // existing directory structure is not news.
      return;
    }
    this.emitEvent({ type, relPath, from: null, size: 0, mtimeMs: 0 });
  }

  /**
   * Coalesces per path.
   *
   * `awaitWriteFinish` has already established that the file stopped changing, so this is
   * not about partial writes — it is about the several events one save still produces
   * (a write, a metadata update, a permissions touch) becoming one unit of sync work.
   */
  private schedule(relPath: string, event: WatchEvent): void {
    this.cancelDebounce(relPath);

    const timer = setTimeout(() => {
      this.debounces.delete(relPath);
      this.emitEvent(event);
    }, this.debounceMs);
    timer.unref();

    this.debounces.set(relPath, timer);
  }

  private cancelDebounce(relPath: string): void {
    const timer = this.debounces.get(relPath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.debounces.delete(relPath);
    }
  }

  /**
   * Emits, unless the echo guard recognises the event as one of our own writes.
   *
   * Only content events are offered to the guard: it matches on `(size, mtime)`, which a
   * removal does not have. Self-inflicted deletions are caught by the guard's rate
   * limiter instead, which is the backstop for exactly this kind of gap.
   */
  private emitEvent(event: WatchEvent): void {
    if (
      this.guard !== null &&
      (event.type === 'added' || event.type === 'changed' || event.type === 'renamed') &&
      this.guard.shouldDrop({ path: event.relPath, size: event.size, mtimeMs: event.mtimeMs })
    ) {
      return;
    }
    this.emit('file', event);
  }

  /** Absolute path → the POSIX-shaped relative path the rest of the engine speaks. */
  private toRelative(path: string): string {
    const rel = relative(this.root, path);
    return sep === '/' ? rel : rel.split(sep).join('/');
  }
}

const identityOf = (stats?: Stats): Identity | null => {
  if (stats === undefined) {
    return null;
  }
  return {
    size: stats.size,
    mtimeMs: Math.floor(stats.mtimeMs),
    ino: Number(stats.ino),
    dev: Number(stats.dev),
  };
};

/**
 * Whether two sightings are the same file *object* — the question a rename asks.
 *
 * A usable inode settles it outright. Without one, identical size and mtime is the best
 * available evidence — and within the second-and-a-half rename window, two distinct files
 * agreeing on both is not a case worth trading a working rename optimisation for.
 */
const sameFile = (a: Identity, b: Identity): boolean => {
  if (a.ino !== 0 && b.ino !== 0 && a.dev === b.dev) {
    return a.ino === b.ino;
  }
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
};

/**
 * Whether a file's *content* is unchanged between two sightings — the question an edit asks.
 *
 * Emphatically not {@link sameFile}. A write in place keeps the inode: a program the TNC
 * opened, edited and saved is the very same inode it was before, so answering this question
 * with an inode comparison would classify every edit the bridge exists to propagate as
 * "nothing happened". Size and mtime are the metadata proxy for content here, the same one
 * rsync trusts by default — and unlike the rename case, being wrong costs a redundant
 * transfer rather than a silently dropped change.
 */
const sameContent = (a: Identity, b: Identity): boolean =>
  a.size === b.size && a.mtimeMs === b.mtimeMs;
