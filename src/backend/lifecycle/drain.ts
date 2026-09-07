/**
 * In-flight work tracking, so shutdown can wait for it.
 *
 * A file transfer writes to `.tnc-tmp-<id>` and renames it into place when complete. If
 * the process exits between those two steps, the temp file survives on the share — and
 * on a TNC that means an operator sees a file the control cannot open, in a directory
 * they cannot easily clean up. The same applies to locks: a lock row written to SQLite
 * with no process left to release it blocks the file until its TTL expires.
 *
 * Neither problem is solved by "unlink the temp file on exit" — SIGKILL and power loss
 * do not run cleanup handlers. What is solved here is the *graceful* case, which is the
 * overwhelmingly common one: systemd sends SIGTERM, we stop accepting new work, we let
 * what is running finish, and only then do we close anything.
 *
 * The hard deadline matters as much as the wait. systemd's `TimeoutStopSec` will SIGKILL
 * us eventually; draining must give up before that, cancel what is left, and let the
 * cancellation path do its own cleanup while the process is still alive to run it.
 */

export interface DrainLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface OperationHandle {
  readonly id: number;
  readonly label: string;
  readonly startedAt: number;
  /** Set when the registry is draining and this operation should wind up early. */
  readonly cancelled: boolean;
  /** Call exactly once when the operation finishes, successfully or not. */
  done(): void;
}

export class RegistryClosedError extends Error {
  constructor(label: string) {
    super(`refusing to begin "${label}": the service is shutting down`);
    this.name = 'RegistryClosedError';
  }
}

export interface DrainRegistryOptions {
  readonly logger?: DrainLogger;
  readonly now?: () => number;
}

export interface DrainResult {
  /** False when the deadline passed with work still running. */
  readonly drained: boolean;
  readonly remaining: readonly string[];
  readonly waitedMs: number;
}

export class DrainRegistry {
  private readonly operations = new Map<number, { label: string; startedAt: number }>();
  private readonly waiters = new Set<() => void>();
  private readonly logger: DrainLogger | undefined;
  private readonly now: () => number;
  private nextId = 1;
  private closing = false;

  constructor(options: DrainRegistryOptions = {}) {
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  get inflight(): number {
    return this.operations.size;
  }

  get labels(): readonly string[] {
    return [...this.operations.values()].map((entry) => entry.label);
  }

  /** True once draining has begun. New work is refused from this point. */
  get isClosing(): boolean {
    return this.closing;
  }

  /**
   * Registers a unit of work. Throws once shutdown has begun, which is deliberate:
   * a caller that starts a transfer during shutdown would create exactly the temp file
   * this class exists to prevent, so the refusal must be impossible to ignore.
   */
  begin(label: string): OperationHandle {
    if (this.closing) {
      throw new RegistryClosedError(label);
    }
    const id = this.nextId;
    this.nextId += 1;
    const startedAt = this.now();
    this.operations.set(id, { label, startedAt });

    let finished = false;
    // Arrow functions so the handle closes over this registry lexically, rather than
    // depending on how the caller invokes the returned methods.
    const isCancelled = (): boolean => this.closing;
    const done = (): void => {
      // Guarded: a double `done()` would otherwise let the count drop below the real
      // number of running operations and release the drain early.
      if (finished) {
        return;
      }
      finished = true;
      this.operations.delete(id);
      this.notify();
    };

    return {
      id,
      label,
      startedAt,
      get cancelled(): boolean {
        return isCancelled();
      },
      done,
    };
  }

  /** Runs `work` with the operation registered for its duration, however it ends. */
  async track<T>(label: string, work: (handle: OperationHandle) => Promise<T>): Promise<T> {
    const handle = this.begin(label);
    try {
      return await work(handle);
    } finally {
      handle.done();
    }
  }

  private notify(): void {
    if (this.operations.size === 0) {
      for (const waiter of this.waiters) {
        waiter();
      }
      this.waiters.clear();
    }
  }

  /**
   * Stops accepting work and waits for what is running, up to `timeoutMs`.
   *
   * Returning `drained: false` is not a failure to handle later — it means the caller
   * must now assume those operations will be killed mid-write, and act accordingly.
   */
  async drain(timeoutMs: number): Promise<DrainResult> {
    const startedAt = this.now();
    this.closing = true;

    if (this.operations.size === 0) {
      return { drained: true, remaining: [], waitedMs: 0 };
    }

    this.logger?.info('waiting for in-flight operations', {
      count: this.operations.size,
      labels: this.labels,
      timeoutMs,
    });

    const drained = await new Promise<boolean>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.add(waiter);
    });

    const remaining = this.labels;
    if (!drained) {
      this.logger?.warn('drain deadline passed with work still running', {
        remaining,
        timeoutMs,
      });
    }

    return { drained, remaining, waitedMs: this.now() - startedAt };
  }

  /** Reopens the registry. Used by `--check` and by tests; never during a real shutdown. */
  reset(): void {
    this.closing = false;
    this.operations.clear();
    this.waiters.clear();
  }
}
