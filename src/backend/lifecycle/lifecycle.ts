/**
 * Ordered startup and shutdown.
 *
 * Subsystems have a strict dependency order — the logger cannot write to SQLite before
 * the database is open, and the database cannot be opened before config says where it
 * lives. Getting that order right once, in one place, is the difference between a clean
 * `systemctl restart` and a service that leaves a locked WAL and a mounted CIFS share
 * behind every time it stops.
 *
 * Two rules make this reliable:
 *
 *  1. **Stop in reverse.** Whatever started last is torn down first, so nothing is ever
 *     asked to shut down after something it depends on has gone.
 *  2. **A failed start unwinds.** If subsystem four fails, one through three are stopped
 *     before the error propagates. Without this, a failed startup leaks exactly the
 *     handles — open databases, bound sockets, live timers — that make the next start
 *     fail too, turning one bad config into a restart loop that never recovers.
 */

export type LifecycleState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface Stage {
  readonly name: string;
  start(): void | Promise<void>;
  /** Omitted for stages that hold nothing — pure wiring, computed values. */
  stop?(): void | Promise<void>;
  /**
   * How long this stage's `stop` may take before shutdown moves on without it.
   * A CIFS unmount against a dead server can hang indefinitely; the rest of the
   * shutdown must not be held hostage to it.
   */
  readonly stopTimeoutMs?: number;
}

export interface LifecycleLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: LifecycleLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface LifecycleOptions {
  readonly logger?: LifecycleLogger;
  /** Default budget for a stage's `stop`. */
  readonly stopTimeoutMs?: number;
}

export class StageStartError extends Error {
  constructor(
    readonly stage: string,
    override readonly cause: unknown,
  ) {
    super(`stage "${stage}" failed to start: ${describeError(cause)}`);
    this.name = 'StageStartError';
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves to `false` if the promise did not settle within the budget. */
export async function withTimeout(
  work: Promise<void>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(false);
    }, timeoutMs);
    // A pending shutdown timer must not itself keep the process alive.
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface StopReport {
  readonly stage: string;
  readonly outcome: 'stopped' | 'timeout' | 'error';
  readonly error?: string;
}

const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export class Lifecycle {
  private readonly stages: Stage[] = [];
  private readonly started: Stage[] = [];
  private readonly logger: LifecycleLogger;
  private readonly defaultStopTimeoutMs: number;
  private stateValue: LifecycleState = 'idle';
  private stopPromise: Promise<StopReport[]> | undefined;

  constructor(options: LifecycleOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.defaultStopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  get state(): LifecycleState {
    return this.stateValue;
  }

  /** Names of the stages that are currently up, in start order. */
  get running(): readonly string[] {
    return this.started.map((stage) => stage.name);
  }

  register(stage: Stage): this {
    if (this.stateValue !== 'idle') {
      throw new Error(`cannot register "${stage.name}" once the lifecycle has started`);
    }
    if (this.stages.some((existing) => existing.name === stage.name)) {
      throw new Error(`a stage named "${stage.name}" is already registered`);
    }
    this.stages.push(stage);
    return this;
  }

  async start(): Promise<void> {
    if (this.stateValue !== 'idle') {
      throw new Error(`start() called while the lifecycle is "${this.stateValue}"`);
    }
    this.stateValue = 'starting';

    for (const stage of this.stages) {
      try {
        await stage.start();
        this.started.push(stage);
        this.logger.info('subsystem started', { stage: stage.name });
      } catch (error) {
        this.logger.error('subsystem failed to start', {
          stage: stage.name,
          error: describeError(error),
        });
        // Unwind before surfacing, so a failed start leaks nothing into the next one.
        await this.stopStarted('failed start');
        this.stateValue = 'failed';
        throw new StageStartError(stage.name, error);
      }
    }

    this.stateValue = 'running';
  }

  /**
   * Idempotent by design. SIGTERM and SIGINT can arrive together, and systemd may send
   * a second SIGTERM if the first appears not to have taken; each must join the
   * shutdown already in progress rather than starting a competing one that closes the
   * database twice.
   */
  async stop(reason = 'shutdown'): Promise<StopReport[]> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    if (this.stateValue === 'idle' || this.stateValue === 'stopped') {
      this.stateValue = 'stopped';
      return [];
    }
    this.stopPromise = this.stopStarted(reason).then((reports) => {
      this.stateValue = 'stopped';
      return reports;
    });
    return this.stopPromise;
  }

  private async stopStarted(reason: string): Promise<StopReport[]> {
    if (this.stateValue !== 'failed') {
      this.stateValue = 'stopping';
    }
    this.logger.info('shutting down', { reason, stages: this.started.length });

    const reports: StopReport[] = [];
    // Reverse order: nothing is torn down before its dependants.
    for (const stage of [...this.started].reverse()) {
      if (stage.stop === undefined) {
        reports.push({ stage: stage.name, outcome: 'stopped' });
        continue;
      }
      const budget = stage.stopTimeoutMs ?? this.defaultStopTimeoutMs;
      try {
        const finished = await withTimeout(Promise.resolve(stage.stop()), budget, () => {
          this.logger.warn('subsystem did not stop within its budget', {
            stage: stage.name,
            timeoutMs: budget,
          });
        });
        reports.push({ stage: stage.name, outcome: finished ? 'stopped' : 'timeout' });
      } catch (error) {
        // One subsystem failing to stop must not strand the ones after it — a hung
        // unmount should never be the reason the database is left un-checkpointed.
        this.logger.error('subsystem failed to stop', {
          stage: stage.name,
          error: describeError(error),
        });
        reports.push({ stage: stage.name, outcome: 'error', error: describeError(error) });
      }
    }

    this.started.length = 0;
    return reports;
  }
}
