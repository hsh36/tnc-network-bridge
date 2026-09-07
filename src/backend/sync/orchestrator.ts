import { EventEmitter } from 'node:events';
import { type ShareStatus } from '../../shared/schemas/share';
import { type FileState, type FileSide } from '../../shared/schemas/file-index';
import {
  DEFAULT_DIFF_CONFIG,
  decide,
  type DiffConfig,
  type Side,
  type Verdict,
  type VersionCapture,
} from './diff-engine';
import { EchoGuard } from './echo-guard';
import { TransferQueue, type Clock, systemClock } from './throttle';

/**
 * The sync orchestrator (T22).
 *
 * Everything else in this directory is a pure function or a single mechanism. This is the
 * part that has to be *correct under partial failure*, which is a different discipline:
 * it must assume that any file can fail, any share can vanish, and the process can be
 * killed between any two statements.
 *
 * Three rules follow from that, and they are the whole design:
 *
 * 1. **One failing file does not stop the share.** Each path is reconciled independently
 *    and its failure is recorded against that path, not thrown upwards. A single
 *    permission error on one program must not stop the other four hundred.
 * 2. **One failing share does not stop the bridge.** A share owns its own state machine
 *    and its own circuit breaker. Nothing here reaches across shares.
 * 3. **The base state is committed only after the transfer succeeded.** Committing first
 *    would mean a crash mid-transfer leaves the index claiming two sides agree when they
 *    do not — and the next scan would see no difference and never repair it. Committing
 *    last means a crash costs a redundant copy, which is the recoverable error.
 *
 * ## The circuit breaker
 *
 * Ten consecutive failures is no longer a set of unlucky files; it is a share that is
 * broken — unmounted, credentials expired, disk gone. Continuing to try every file in
 * turn produces hundreds of identical log lines and hammers a server that is already
 * unhappy. So the breaker opens for five minutes, then allows exactly one probe. The
 * probe's outcome decides: success closes it, failure re-opens it for another five.
 *
 * ## What "restart safe" means here
 *
 * The orchestrator holds no durable state of its own. Everything that must survive a
 * restart lives in the {@link BaseStore}, which is written after each file completes. A
 * new orchestrator over the same store resumes exactly where the old one stopped, which
 * is why the store is a port and not an internal field.
 */

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** What one path looked like the last time both sides were known to agree. */
export interface FileRecord {
  readonly base: Side;
  readonly state: FileState;
  readonly retryCount: number;
  /** Epoch ms before which this path should not be retried. */
  readonly nextRetryAt: number | null;
  readonly lastError: string | null;
}

/**
 * Durable per-path state.
 *
 * Synchronous on purpose: the real implementation is `better-sqlite3`, which is
 * synchronous, and pretending otherwise would add an await to every call site to model a
 * concurrency that does not exist.
 */
export interface BaseStore {
  get(relPath: string): FileRecord | null;
  set(relPath: string, record: FileRecord): void;
  delete(relPath: string): void;
  paths(): readonly string[];
}

/** An in-memory store. The default, and what the tests drive. */
export class MemoryBaseStore implements BaseStore {
  private readonly records = new Map<string, FileRecord>();

  get(relPath: string): FileRecord | null {
    return this.records.get(relPath) ?? null;
  }

  set(relPath: string, record: FileRecord): void {
    this.records.set(relPath, record);
  }

  delete(relPath: string): void {
    this.records.delete(relPath);
  }

  paths(): readonly string[] {
    return [...this.records.keys()];
  }
}

/**
 * Everything the orchestrator needs the outside world to do.
 *
 * Narrow on purpose: the orchestrator is the piece most worth testing exhaustively and
 * least suited to a live Samba server, so every effect it can have goes through here.
 */
export interface SyncPorts {
  /** Every relative path present on either side, from the scanner. */
  listPaths(): Promise<readonly string[]>;
  statLocal(relPath: string): Promise<Side>;
  statRemote(relPath: string): Promise<Side>;
  push(relPath: string): Promise<void>;
  pull(relPath: string): Promise<void>;
  deleteLocal(relPath: string): Promise<void>;
  deleteRemote(relPath: string): Promise<void>;
  /** Write the losing or about-to-be-overwritten side to the version store. */
  captureVersion(relPath: string, capture: VersionCapture): Promise<void>;
  isServerOnline(): Promise<boolean>;
  /** Whether a TNC currently holds the file open. */
  isLocked?(relPath: string): boolean;
  /** Whether the path matches an exclude pattern. */
  isExcluded?(relPath: string): boolean;
  /** Another indexed path differing only by case. */
  hasCaseCollision?(relPath: string): boolean;
}

export interface OrchestratorOptions {
  readonly shareId: number;
  readonly ports: SyncPorts;
  readonly store?: BaseStore;
  readonly diffConfig?: Partial<Omit<DiffConfig, 'relPath'>>;
  readonly echoGuard?: EchoGuard;
  readonly queue?: TransferQueue;
  readonly clock?: Clock;
  /** Consecutive failures that open the breaker. */
  readonly breakerThreshold?: number;
  /** How long the breaker stays open before it allows a probe. */
  readonly breakerCooldownMs?: number;
  /** Per-path backoff, indexed by retry count. */
  readonly retryDelaysMs?: readonly number[];
}

export interface SyncOutcome {
  readonly relPath: string;
  readonly verdict: Verdict;
  readonly applied: boolean;
  readonly error: string | null;
}

export interface CycleResult {
  readonly scanned: number;
  readonly applied: number;
  readonly failed: number;
  readonly deferred: number;
  readonly skipped: number;
  readonly outcomes: readonly SyncOutcome[];
  readonly haltedByBreaker: boolean;
}

const DEFAULT_BREAKER_THRESHOLD = 10;
const DEFAULT_BREAKER_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 25_000, 125_000] as const;

/** Verdicts that need no work: they are already the desired state. */
const INERT = new Set(['NOOP', 'EXCLUDE', 'SKIP', 'ERROR', 'DEFER']);

type BreakerState = 'closed' | 'open' | 'half_open';

export class SyncOrchestrator extends EventEmitter {
  readonly shareId: number;

  private readonly ports: SyncPorts;
  private readonly store: BaseStore;
  private readonly diffDefaults: Omit<DiffConfig, 'relPath'>;
  private readonly guard: EchoGuard;
  private readonly queue: TransferQueue;
  private readonly clock: Clock;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly retryDelaysMs: readonly number[];

  private status: ShareStatus = 'idle';
  private paused = false;
  private consecutiveFailures = 0;
  private breaker: BreakerState = 'closed';
  private breakerOpenedAt = 0;
  private running = false;
  /** Whether the single attempt a half-open breaker allows has been spent this cycle. */
  private probeUsed = false;

  constructor(options: OrchestratorOptions) {
    super();
    this.shareId = options.shareId;
    this.ports = options.ports;
    this.store = options.store ?? new MemoryBaseStore();
    this.diffDefaults = { ...DEFAULT_DIFF_CONFIG, ...options.diffConfig };
    this.guard = options.echoGuard ?? new EchoGuard();
    this.queue = options.queue ?? new TransferQueue({ concurrency: 4 });
    this.clock = options.clock ?? systemClock;
    this.breakerThreshold = options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.breakerCooldownMs = options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  get state(): ShareStatus {
    return this.status;
  }

  get breakerState(): BreakerState {
    return this.breaker;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** The guard is exposed so the watcher can ask it whether to drop an event. */
  get echoGuard(): EchoGuard {
    return this.guard;
  }

  pause(): void {
    this.paused = true;
    this.setStatus('paused');
  }

  resume(): void {
    this.paused = false;
    this.setStatus('idle');
  }

  /**
   * Discards all remembered base state.
   *
   * Every path then looks new, which re-derives agreement from what is actually on the
   * two sides rather than from what was once recorded — the only honest way to recover
   * from an index that has drifted.
   */
  fullResync(): void {
    for (const path of this.store.paths()) {
      this.store.delete(path);
    }
    this.guard.clear();
    this.consecutiveFailures = 0;
    this.breaker = 'closed';
    this.emit('resync', { shareId: this.shareId });
  }

  /**
   * Runs one reconciliation pass over every known path.
   *
   * Never throws for a per-file problem. The only thing that stops a cycle early is the
   * circuit breaker, and that is reported rather than raised.
   */
  async runCycle(): Promise<CycleResult> {
    if (this.running) {
      throw new Error(`share ${this.shareId} is already running a cycle`);
    }
    this.running = true;

    try {
      return await this.cycle();
    } finally {
      this.running = false;
    }
  }

  private async cycle(): Promise<CycleResult> {
    const outcomes: SyncOutcome[] = [];

    if (this.paused) {
      this.setStatus('paused');
      return this.summarise(outcomes, false);
    }

    if (!this.tryEnterBreaker()) {
      this.setStatus('error');
      return this.summarise(outcomes, true);
    }

    this.setStatus('scanning');
    const online = await this.ports.isServerOnline();
    if (!online) {
      // Not a failure: an unreachable share is a state, not an error, and counting it
      // towards the breaker would open it for a condition the breaker cannot improve.
      this.setStatus('offline');
    }

    let paths: readonly string[];
    try {
      paths = await this.ports.listPaths();
    } catch (error) {
      this.setStatus('error');
      this.emit('error', { shareId: this.shareId, error: describe(error) });
      return this.summarise(outcomes, false);
    }

    if (online) {
      this.setStatus('syncing');
    }

    const now = this.clock.now();
    const work = paths.map((relPath) =>
      this.queue.add(0, () => this.reconcile(relPath, online, now)),
    );
    const settled = await Promise.all(work);

    for (const outcome of settled) {
      if (outcome !== null) {
        outcomes.push(outcome);
      }
      if (this.breaker === 'open') {
        break;
      }
    }

    // An open breaker outranks the tidy end-of-cycle status: a share that has just given
    // up after ten consecutive failures is in error, and reporting it as idle would hide
    // exactly the condition the breaker exists to make visible.
    if (!this.paused && this.breaker !== 'open') {
      this.setStatus(online ? 'idle' : 'offline');
    }
    return this.summarise(outcomes, this.breaker === 'open');
  }

  /** Reconciles one path. Returns `null` when the path was not due for a retry yet. */
  private async reconcile(
    relPath: string,
    online: boolean,
    now: number,
  ): Promise<SyncOutcome | null> {
    // The breaker is checked here, not only before the cycle, because every path is
    // queued up front: without this, opening the breaker would stop the *next* cycle
    // while the current one carried on failing through the whole share.
    if (this.breaker === 'open') {
      return null;
    }
    if (this.breaker === 'half_open') {
      if (this.probeUsed) {
        return null;
      }
      // Half-open buys exactly one attempt. Letting the rest through would make the
      // probe indistinguishable from simply retrying everything.
      this.probeUsed = true;
    }

    const record = this.store.get(relPath);

    if (record?.nextRetryAt != null && record.nextRetryAt > now) {
      return null;
    }
    if (this.guard.isQuarantined(relPath)) {
      return null;
    }

    let local: Side;
    let remote: Side;
    try {
      [local, remote] = await Promise.all([
        this.ports.statLocal(relPath),
        this.ports.statRemote(relPath),
      ]);
    } catch (error) {
      return this.recordFailure(relPath, record, describe(error), null);
    }

    const verdict = decide({
      local,
      remote,
      base: record?.base ?? null,
      config: {
        ...this.diffDefaults,
        relPath,
        serverOffline: this.diffDefaults.serverOffline || !online,
        locked: this.ports.isLocked?.(relPath) ?? this.diffDefaults.locked,
        excluded: this.ports.isExcluded?.(relPath) ?? this.diffDefaults.excluded,
        caseCollision: this.ports.hasCaseCollision?.(relPath) ?? this.diffDefaults.caseCollision,
      },
    });

    for (const warning of verdict.warnings) {
      this.emit('warning', { shareId: this.shareId, relPath, message: warning });
    }

    if (INERT.has(verdict.action)) {
      this.commitInert(relPath, verdict, record);
      return { relPath, verdict, applied: false, error: null };
    }

    try {
      await this.apply(relPath, verdict, local, remote);
      this.commitSuccess(relPath, verdict, local, remote);
      this.onSuccess();
      this.emit('file', { shareId: this.shareId, relPath, action: verdict.action });
      return { relPath, verdict, applied: true, error: null };
    } catch (error) {
      return this.recordFailure(relPath, record, describe(error), verdict);
    }
  }

  /**
   * Performs the verdict's effect.
   *
   * The version capture happens first, always. If capturing fails the transfer does not
   * run — the entire point of the capture is that it exists before the data it protects
   * is destroyed, so proceeding without it would be worse than not syncing at all.
   */
  private async apply(relPath: string, verdict: Verdict, local: Side, remote: Side): Promise<void> {
    if (verdict.captureVersion !== null) {
      await this.ports.captureVersion(relPath, verdict.captureVersion);
    }

    // Tell the guard what the write will look like before making it: on a fast
    // filesystem the watcher event can arrive before the write call returns.
    switch (verdict.action) {
      case 'PUSH':
        this.expect(relPath, local);
        await this.ports.push(relPath);
        break;
      case 'PULL':
        this.expect(relPath, remote);
        await this.ports.pull(relPath);
        break;
      case 'DELETE_LOCAL':
        await this.ports.deleteLocal(relPath);
        break;
      case 'DELETE_REMOTE':
        await this.ports.deleteRemote(relPath);
        break;
      case 'CONVERGE':
        // Both sides already hold the same bytes; only the base needs updating.
        break;
      case 'NOOP':
      case 'DEFER':
      case 'EXCLUDE':
      case 'SKIP':
      case 'ERROR':
        /* istanbul ignore next -- INERT rejected these before apply() was reached; the
           cases are spelled out so a new action cannot be added without deciding here */
        throw new Error(`cannot apply ${verdict.action} for ${relPath}`);
    }

    this.guard.recordSync(relPath);
  }

  private expect(relPath: string, side: Side): void {
    if (side !== null) {
      this.guard.expect({ path: relPath, size: side.size, mtimeMs: side.mtime });
    }
  }

  /**
   * Records the new agreed base — after the transfer, never before.
   *
   * The surviving side becomes the base: after a push both sides hold the local bytes,
   * after a pull both hold the remote ones. A delete removes the record entirely, since
   * "agreed to be absent" and "never seen" are the same state to the next cycle.
   */
  private commitSuccess(relPath: string, verdict: Verdict, local: Side, remote: Side): void {
    if (verdict.action === 'DELETE_LOCAL' || verdict.action === 'DELETE_REMOTE') {
      this.store.delete(relPath);
      return;
    }

    const survivor: FileSide | null =
      verdict.action === 'PULL' ? remote : verdict.action === 'PUSH' ? local : (local ?? remote);

    this.store.set(relPath, {
      base: survivor,
      state: 'synced',
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
    });
  }

  /** A verdict that needs no transfer still updates the recorded state. */
  private commitInert(relPath: string, verdict: Verdict, record: FileRecord | null): void {
    this.store.set(relPath, {
      base: record?.base ?? null,
      state: verdict.nextState,
      // A deferral is not a failure, so it must not consume the path's retry budget.
      retryCount: record?.retryCount ?? 0,
      nextRetryAt: null,
      lastError: null,
    });
  }

  private recordFailure(
    relPath: string,
    record: FileRecord | null,
    message: string,
    verdict: Verdict | null,
  ): SyncOutcome {
    const retryCount = (record?.retryCount ?? 0) + 1;
    const delay = this.retryDelaysMs[Math.min(retryCount - 1, this.retryDelaysMs.length - 1)] ?? 0;

    this.store.set(relPath, {
      base: record?.base ?? null,
      state: 'error',
      retryCount,
      nextRetryAt: this.clock.now() + delay,
      lastError: message,
    });

    this.onFailure();
    this.emit('file-error', { shareId: this.shareId, relPath, error: message, retryCount });

    return {
      relPath,
      verdict: verdict ?? failedVerdict(relPath, message),
      applied: false,
      error: message,
    };
  }

  // -- The circuit breaker --------------------------------------------------

  /** Whether the cycle may proceed, moving the breaker to half-open when it is due. */
  private tryEnterBreaker(): boolean {
    if (this.breaker === 'closed') {
      return true;
    }
    if (this.breaker === 'half_open') {
      return true;
    }
    if (this.clock.now() - this.breakerOpenedAt >= this.breakerCooldownMs) {
      this.breaker = 'half_open';
      this.probeUsed = false;
      this.emit('breaker', { shareId: this.shareId, state: 'half_open' });
      return true;
    }
    return false;
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.breaker !== 'closed') {
      // The probe worked, so whatever was broken is not any more.
      this.breaker = 'closed';
      this.emit('breaker', { shareId: this.shareId, state: 'closed' });
    }
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;

    if (this.breaker === 'half_open') {
      // The probe failed: back to waiting, without needing another ten failures first.
      this.openBreaker();
      return;
    }
    if (this.consecutiveFailures >= this.breakerThreshold) {
      this.openBreaker();
    }
  }

  private openBreaker(): void {
    this.breaker = 'open';
    this.breakerOpenedAt = this.clock.now();
    this.setStatus('error');
    this.emit('breaker', {
      shareId: this.shareId,
      state: 'open',
      consecutiveFailures: this.consecutiveFailures,
    });
  }

  private setStatus(next: ShareStatus): void {
    if (this.status === next) {
      return;
    }
    const previous = this.status;
    this.status = next;
    this.emit('state', { shareId: this.shareId, status: next, previousStatus: previous });
  }

  private summarise(outcomes: SyncOutcome[], haltedByBreaker: boolean): CycleResult {
    let applied = 0;
    let failed = 0;
    let deferred = 0;
    let skipped = 0;

    for (const outcome of outcomes) {
      if (outcome.error !== null) {
        failed += 1;
      } else if (outcome.applied) {
        applied += 1;
      } else if (outcome.verdict.action === 'DEFER') {
        deferred += 1;
      } else {
        skipped += 1;
      }
    }

    return {
      scanned: outcomes.length,
      applied,
      failed,
      deferred,
      skipped,
      outcomes,
      haltedByBreaker,
    };
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A stand-in verdict for a failure that happened before one could be computed. */
const failedVerdict = (relPath: string, message: string): Verdict => ({
  action: 'ERROR',
  reason: 'in_sync',
  detail: `${relPath}: ${message}`,
  captureVersion: null,
  conflict: null,
  nextState: 'error',
  warnings: [],
});
