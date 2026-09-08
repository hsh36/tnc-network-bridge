import { EventEmitter } from 'node:events';
import { promises as fsPromises, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';

import { type HelperInvoker, invokePrivileged, PrivilegedCallError } from '../privileged/client';
import { mountPointFor, type MountShareRequest } from '../privileged/verbs';

/**
 * The CIFS mount manager (T10).
 *
 * This module owns the LAN-side half of the bridge: the kernel mount of the corporate
 * SMB 3.1.1 share, its health, and its recovery. Everything above it — the scanner, the
 * transfer executor — treats the server share as an ordinary POSIX path, which is the
 * whole reason `mount.cifs` was chosen over a userspace SMB library (D1).
 *
 * That convenience has one sharp edge, and this module exists to blunt it. A CIFS call
 * against a server that has gone away does not fail fast the way a socket does. On a
 * `hard` mount it never fails at all: the calling thread parks in uninterruptible sleep
 * (`D` state) and cannot be signalled, killed, or timed out. Node's `fs.promises` calls
 * run on the libuv thread pool, which is four threads by default, so four such calls
 * wedge the entire process — including the dashboard an operator would use to find out
 * what is wrong. R3 rates this **fatal**, and it is.
 *
 * Three defences, in order of how much they actually buy:
 *
 *  1. **`soft` is mandatory and asserted** — not merely requested. {@link assertSoftMount}
 *     reads the options the *kernel* reports in `/proc/self/mounts` and refuses to treat
 *     the mount as usable if `hard` is in force. Asking for `soft` and trusting that it
 *     was honoured is not the same as checking.
 *  2. **Every server-side call is wrapped** in {@link withTimeout}, so the caller is
 *     released on a deadline even when the syscall is not.
 *  3. **Errors are classified, not just propagated.** `EIO` from a soft mount means "the
 *     server went away", which is a retry; `EACCES` means the service account is wrong,
 *     which is not. Retrying the second forever is how a bridge looks alive while
 *     silently doing nothing.
 *
 * Note the asymmetry in what a timeout can promise. {@link withTimeout} bounds how long
 * the *caller* waits; it cannot cancel the underlying syscall, because POSIX offers no
 * way to. The pool thread is released when the kernel gives up — which is precisely why
 * `soft` (bounded by `timeo`) is load-bearing and the timeout is the backstop.
 */

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * What kind of failure this is, which is the same question as "what should the caller
 * do about it" (error-handling doctrine §2).
 *
 * - `transient` — the server or link is unavailable. Retry with backoff; the sync engine
 *   defers rather than failing the file.
 * - `timeout` — we gave up waiting. Treated as transient for retry purposes but reported
 *   separately, because a mount that times out while the server is up means something
 *   different (overloaded server, saturated link) than one that returns `EIO`.
 * - `permission` — credentials or share ACLs are wrong. Retrying cannot fix it; an
 *   operator must.
 * - `missing` — the path is not there. On a mounted share this is an ordinary "file does
 *   not exist"; on the mount point itself it means the mount is gone.
 * - `unknown` — unclassified. Treated as persistent, because guessing "transient" on an
 *   unrecognised error produces an infinite retry loop that hides the real problem.
 */
export type MountErrorKind = 'transient' | 'timeout' | 'permission' | 'missing' | 'unknown';

/**
 * Errno values a soft CIFS mount produces when the far end is unreachable.
 *
 * `EIO` is the important one and the least obvious: it is what `soft` converts a timed
 * out SMB request into. Code that treats `EIO` as corruption rather than disconnection
 * will mark every file on the share as errored the moment a switch reboots.
 */
const TRANSIENT_ERRNOS = new Set([
  'EIO',
  'ESTALE',
  'ENOTCONN',
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENETRESET',
  'ETIMEDOUT',
  'EAGAIN',
  'EBUSY',
  'EINTR',
  'EPIPE',
  'ENOMEM',
  'EREMOTEIO',
  'ENODATA',
]);

const PERMISSION_ERRNOS = new Set(['EACCES', 'EPERM', 'EROFS', 'EKEYEXPIRED', 'EKEYREVOKED']);

const MISSING_ERRNOS = new Set(['ENOENT', 'ENOTDIR', 'ENXIO', 'ENODEV']);

/** A failure of a server-side operation, carrying enough to decide whether to retry. */
export class MountError extends Error {
  constructor(
    message: string,
    readonly kind: MountErrorKind,
    /** The operation that failed, for logs — e.g. `stat /mnt/tnc-server/programs`. */
    readonly operation: string,
    /** The underlying errno string, when there was one. */
    readonly code?: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MountError';
  }

  /** Whether a retry with backoff is worth attempting. */
  get transient(): boolean {
    return this.kind === 'transient' || this.kind === 'timeout';
  }
}

interface ErrnoLike {
  readonly code?: unknown;
  readonly message?: unknown;
}

/** Extracts the errno string from an unknown thrown value, if it has one. */
export function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code = (error as ErrnoLike).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Maps a thrown value to a {@link MountErrorKind}.
 *
 * A {@link MountError} passes its own classification through unchanged so that wrapping
 * an already-classified error at a higher layer does not launder it back to `unknown`.
 */
export function classifyError(error: unknown): MountErrorKind {
  if (error instanceof MountError) {
    return error.kind;
  }
  const code = errnoOf(error);
  if (code === undefined) {
    return 'unknown';
  }
  if (TRANSIENT_ERRNOS.has(code)) {
    return 'transient';
  }
  if (PERMISSION_ERRNOS.has(code)) {
    return 'permission';
  }
  if (MISSING_ERRNOS.has(code)) {
    return 'missing';
  }
  return 'unknown';
}

/** True when the failure is worth retrying. The predicate D1 promised callers. */
export function isTransient(error: unknown): boolean {
  const kind = classifyError(error);
  return kind === 'transient' || kind === 'timeout';
}

/** Wraps any thrown value as a classified {@link MountError}. */
export function toMountError(error: unknown, operation: string): MountError {
  if (error instanceof MountError) {
    return error;
  }
  const code = errnoOf(error);
  const detail =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return new MountError(
    `${operation} failed: ${detail}`,
    classifyError(error),
    operation,
    code,
    error,
  );
}

// ---------------------------------------------------------------------------
// Timeout wrapper
// ---------------------------------------------------------------------------

/** Default deadline for a single server-side call. Comfortably above the mount's `timeo=50` (5 s). */
export const DEFAULT_FS_TIMEOUT_MS = 15_000;

/**
 * Races an operation against a deadline.
 *
 * On expiry the returned promise rejects with a `timeout`-kind {@link MountError}. The
 * underlying operation is **not** cancelled — it cannot be — so it may still complete
 * later, and its result is discarded. This is why the mount must be `soft`: without it
 * the abandoned call never completes and the pool thread is gone for good.
 *
 * The timer is `unref`'d, so a pending deadline never by itself keeps the process alive
 * during shutdown.
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new MountError(
          `${label} did not complete within ${timeoutMs} ms`,
          'timeout',
          label,
          'ETIMEDOUT',
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    // `Promise.resolve().then(operation)` rather than `operation()` so a synchronous
    // throw inside the operation becomes a rejection and still loses the race cleanly.
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } catch (error) {
    throw toMountError(error, label);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// /proc/self/mounts
// ---------------------------------------------------------------------------

/** One line of `/proc/self/mounts`, parsed. */
export interface MountEntry {
  readonly device: string;
  readonly mountPoint: string;
  readonly fsType: string;
  readonly options: readonly string[];
}

/**
 * `/proc/self/mounts` escapes space, tab, newline and backslash as octal. A share called
 * `CNC Programme` arrives as `CNC\040Programme`, and comparing that against the
 * unescaped path we asked for would silently never match — the mount would look absent
 * and be remounted in a loop.
 */
function unescapeMountField(value: string): string {
  return value.replace(/\\(\d{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

export function parseProcMounts(content: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const fields = line.split(/\s+/);
    const [device, mountPoint, fsType, options] = fields;
    if (device === undefined || mountPoint === undefined || fsType === undefined) {
      continue;
    }
    entries.push({
      device: unescapeMountField(device),
      mountPoint: unescapeMountField(mountPoint),
      fsType,
      options: (options ?? '').split(',').filter((option) => option !== ''),
    });
  }
  return entries;
}

/** The mount table entry for `mountPoint`, or undefined when nothing is mounted there. */
export function findMountEntry(entries: readonly MountEntry[], mountPoint: string): MountEntry {
  const match = entries.find((entry) => entry.mountPoint === mountPoint);
  if (match === undefined) {
    throw new MountError(
      `nothing is mounted at ${mountPoint}`,
      'missing',
      `lookup ${mountPoint}`,
      'ENOENT',
    );
  }
  return match;
}

/**
 * Refuses a mount that is not `soft`.
 *
 * The check is deliberately positive: `soft` must be present, rather than `hard` merely
 * being absent. `hard` is the kernel's default, so an options list containing neither is
 * a hard mount — exactly the case a "reject if it says hard" test would wave through.
 *
 * `noserverino` is required too, though for a duller reason: without it, inode numbers
 * come from the server and change across a reconnect, which makes the index's identity
 * checks disagree with themselves after every outage.
 */
export function assertSoftMount(entry: MountEntry): void {
  const options = new Set(entry.options);

  if (options.has('hard')) {
    throw new MountError(
      `${entry.mountPoint} is mounted 'hard'; a lost server would wedge the event loop ` +
        `in uninterruptible sleep (R3). Refusing to use this mount.`,
      'unknown',
      `assert soft ${entry.mountPoint}`,
    );
  }
  if (!options.has('soft')) {
    throw new MountError(
      `${entry.mountPoint} does not carry the 'soft' option (the kernel default is 'hard'). ` +
        `Refusing to use this mount.`,
      'unknown',
      `assert soft ${entry.mountPoint}`,
    );
  }
  if (!options.has('noserverino')) {
    throw new MountError(
      `${entry.mountPoint} is missing 'noserverino'; server-assigned inode numbers churn ` +
        `across reconnects and confuse the file index.`,
      'unknown',
      `assert noserverino ${entry.mountPoint}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Mount health, mirroring the failover state machine in ARCHITECTURE §3.4.
 *
 * `degraded` exists so a single dropped probe — a switch relearning a MAC, a server
 * pausing for a snapshot — does not flip a whole share into read-only. Three
 * consecutive failures do.
 */
export const MOUNT_STATES = ['unmounted', 'healthy', 'degraded', 'offline', 'remounting'] as const;

export type MountState = (typeof MOUNT_STATES)[number];

export interface MountSpec {
  readonly shareName: string;
  readonly serverUnc: string;
  readonly smbVersion: '3.1.1' | '3.0' | '2.1';
  readonly seal: boolean;
  readonly domain: string;
  readonly username: string;
  readonly password: string;
  readonly uid: number;
  readonly gid: number;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: MountError;
}

/** The subset of `fs.promises` this module uses, narrowed so tests can substitute it. */
export interface MountFs {
  stat(path: string): Promise<Stats>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
}

export interface MountLogger {
  debug(object: Record<string, unknown>, message: string): void;
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

const NULL_LOGGER: MountLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface CifsMountOptions {
  readonly spec: MountSpec;
  readonly invoke?: HelperInvoker;
  readonly fs?: MountFs;
  readonly logger?: MountLogger;
  readonly procMountsPath?: string;
  readonly fsTimeoutMs?: number;
  readonly probeIntervalMs?: number;
  /** Consecutive probe failures before the mount is declared offline. */
  readonly offlineAfter?: number;
  readonly now?: () => number;
  /** Injected for deterministic backoff in tests. */
  readonly jitter?: () => number;
}

/** Reconnect backoff, 15 s → 300 s (T10). Capped, then repeated indefinitely. */
export const BACKOFF_SCHEDULE_MS = [15_000, 30_000, 60_000, 120_000, 240_000, 300_000] as const;

export function backoffDelayMs(attempt: number, jitter = Math.random()): number {
  const index = Math.min(Math.max(attempt, 0), BACKOFF_SCHEDULE_MS.length - 1);
  const base = BACKOFF_SCHEDULE_MS[index] ?? 300_000;
  // ±10 % so a rack of bridges that lost the same server does not retry in lockstep.
  return Math.round(base * (0.9 + jitter * 0.2));
}

/**
 * Probe marker. Nothing creates this file — its *absence* is a perfectly good answer.
 *
 * That is the point: a reachable server answers `ENOENT` in milliseconds, while a dead
 * one produces `EIO` or nothing at all. Statting a path we do not own also avoids
 * writing to a share that may legitimately be read-only, and avoids the mistake of
 * probing the mount point itself, whose attributes the kernel will happily serve from
 * cache while the server is long gone.
 */
export const PROBE_MARKER = '.tnc-bridge-probe';

export interface MountStateChange {
  readonly previous: MountState;
  readonly current: MountState;
  readonly reason: string;
}

/**
 * Owns one share's mount: establishing it, proving it still works, and rebuilding it
 * when it does not.
 *
 * Privileged operations go through the helper (T7) — this class never touches `mount`
 * or `umount` itself, and never sees a shell. It holds the service account password
 * only for the duration of a mount call; the helper writes the `0600` credentials file,
 * consumes it, and shreds it.
 */
export class CifsMountManager extends EventEmitter {
  readonly mountPoint: string;

  private readonly spec: MountSpec;
  private readonly invoke: HelperInvoker;
  private readonly fs: MountFs;
  private readonly log: MountLogger;
  private readonly procMountsPath: string;
  private readonly fsTimeoutMs: number;
  private readonly probeIntervalMs: number;
  private readonly offlineAfter: number;
  private readonly now: () => number;
  private readonly jitter: () => number;

  private currentState: MountState = 'unmounted';
  private consecutiveFailures = 0;
  private reconnectAttempt = 0;
  private monitorTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  /** Serialises mount/unmount/remount so two callers cannot interleave. */
  private operationChain: Promise<unknown> = Promise.resolve();

  constructor(options: CifsMountOptions) {
    super();
    this.spec = options.spec;
    this.mountPoint = mountPointFor(options.spec.shareName);
    this.invoke = options.invoke ?? invokePrivileged;
    // `fs.promises` satisfies MountFs structurally; the interface exists to narrow what
    // this module may reach for, and to let tests substitute a mount table they control.
    this.fs = options.fs ?? fsPromises;
    this.log = options.logger ?? NULL_LOGGER;
    this.procMountsPath = options.procMountsPath ?? '/proc/self/mounts';
    this.fsTimeoutMs = options.fsTimeoutMs ?? DEFAULT_FS_TIMEOUT_MS;
    this.probeIntervalMs = options.probeIntervalMs ?? 10_000;
    this.offlineAfter = options.offlineAfter ?? 3;
    this.now = options.now ?? Date.now;
    this.jitter = options.jitter ?? Math.random;
  }

  get state(): MountState {
    return this.currentState;
  }

  /** True only in `healthy`; `degraded` is deliberately excluded from "usable". */
  get healthy(): boolean {
    return this.currentState === 'healthy';
  }

  // -------------------------------------------------------------------------
  // Guarded filesystem access
  // -------------------------------------------------------------------------

  /**
   * The wrapper every server-side `fs` call in the codebase must go through.
   *
   * Two things happen here that a bare `await fs.stat(...)` does not do: the caller is
   * released on a deadline, and the error arrives classified. Callers outside this
   * module should reach for this rather than `fs.promises` directly whenever the path
   * lives under a CIFS mount.
   */
  async guard<T>(label: string, operation: () => Promise<T>, timeoutMs?: number): Promise<T> {
    try {
      return await withTimeout(operation, timeoutMs ?? this.fsTimeoutMs, label);
    } catch (error) {
      const mountError = toMountError(error, label);
      if (mountError.transient) {
        this.recordFailure(mountError);
      }
      throw mountError;
    }
  }

  // -------------------------------------------------------------------------
  // Mount table
  // -------------------------------------------------------------------------

  /** Reads the kernel's mount table. Cheap: `/proc` never blocks on the network. */
  private async readMountTable(): Promise<MountEntry[]> {
    const content = await withTimeout(
      () => this.fs.readFile(this.procMountsPath, 'utf8'),
      this.fsTimeoutMs,
      `read ${this.procMountsPath}`,
    );
    return parseProcMounts(content);
  }

  /**
   * Whether the kernel currently has *something* mounted at our mount point.
   *
   * Deliberately a mount-table lookup rather than the usual `st_dev` comparison against
   * the parent directory: `stat()` on a mount point whose server has vanished is exactly
   * the call that can hang, and asking "is the mount alive" must never be the thing that
   * blocks.
   */
  async isMounted(): Promise<boolean> {
    const entries = await this.readMountTable();
    return entries.some((entry) => entry.mountPoint === this.mountPoint);
  }

  /** Reads back the options the kernel actually applied and asserts `soft` (R3). */
  async assertMountOptions(): Promise<MountEntry> {
    const entry = findMountEntry(await this.readMountTable(), this.mountPoint);
    assertSoftMount(entry);
    return entry;
  }

  // -------------------------------------------------------------------------
  // Mount / unmount
  // -------------------------------------------------------------------------

  /** Runs `operation` with the mount lock held, so operations never interleave. */
  private serialise<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation);
    // Keep the chain alive regardless of outcome; a rejected link must not poison it.
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Mounts the share, then proves the result is soft and reachable.
   *
   * A mount that succeeded at the syscall level but is `hard`, or that is mounted but
   * unreachable, is not a usable mount. Both are checked before the state becomes
   * `healthy`, because everything downstream reads that flag as permission to do I/O.
   */
  mount(): Promise<void> {
    return this.serialise(async () => {
      if (await this.isMounted()) {
        this.log.debug({ mountPoint: this.mountPoint }, 'already mounted; verifying instead');
      } else {
        await this.ensureMountPoint();
        this.invokeMount();
      }

      await this.assertMountOptions();

      const probe = await this.probe();
      if (!probe.ok) {
        throw (
          probe.error ??
          new MountError('mount probe failed', 'transient', `probe ${this.mountPoint}`)
        );
      }

      this.consecutiveFailures = 0;
      this.reconnectAttempt = 0;
      this.transition('healthy', 'mounted and probed');
    });
  }

  /**
   * The mount point must exist before `mount.cifs` runs, and it must be a directory.
   * Creating it is not privileged — `/mnt/tnc-server` is owned by the service user.
   */
  private async ensureMountPoint(): Promise<void> {
    await withTimeout(
      () => this.fs.mkdir(this.mountPoint, { recursive: true }),
      this.fsTimeoutMs,
      `mkdir ${this.mountPoint}`,
    );
  }

  /**
   * The one privileged call. Synchronous because the helper client is `spawnSync`;
   * it is short (a `mount` invocation) and runs only on mount transitions, never in the
   * sync hot path.
   */
  private invokeMount(): void {
    const request: MountShareRequest = {
      verb: 'mount-share',
      shareName: this.spec.shareName,
      serverUnc: this.spec.serverUnc,
      mountPoint: this.mountPoint,
      smbVersion: this.spec.smbVersion,
      seal: this.spec.seal,
      domain: this.spec.domain,
      username: this.spec.username,
      password: this.spec.password,
      uid: this.spec.uid,
      gid: this.spec.gid,
    };

    try {
      this.invoke(request);
    } catch (error) {
      throw this.classifyHelperError(error, `mount ${this.spec.serverUnc}`);
    }
  }

  /**
   * A failed `mount.cifs` is not an errno, so the generic classifier cannot help. The
   * distinction that matters to the caller is the same one the connectivity tester (T11)
   * makes in more detail: bad credentials are permanent until an operator acts, an
   * unreachable host is not.
   */
  private classifyHelperError(error: unknown, operation: string): MountError {
    if (!(error instanceof PrivilegedCallError)) {
      return toMountError(error, operation);
    }
    const text = error.message.toLowerCase();
    const permission =
      text.includes('logon_failure') ||
      text.includes('access_denied') ||
      text.includes('permission denied') ||
      text.includes('bad_network_name') ||
      text.includes('no such share');
    return new MountError(
      error.message,
      permission ? 'permission' : 'transient',
      operation,
      undefined,
      error,
    );
  }

  /**
   * Unmounts. `force` escalates to `umount -f -l`, which is what actually detaches a
   * mount whose server is gone — a plain `umount` against a dead server can itself hang.
   */
  unmount(force = false): Promise<void> {
    return this.serialise(async () => {
      if (!(await this.isMounted())) {
        this.transition('unmounted', 'nothing mounted');
        return;
      }
      try {
        this.invoke({
          verb: 'unmount-share',
          shareName: this.spec.shareName,
          mountPoint: this.mountPoint,
          force,
        });
      } catch (error) {
        throw this.classifyHelperError(error, `unmount ${this.mountPoint}`);
      }
      this.transition('unmounted', force ? 'force unmounted' : 'unmounted');
    });
  }

  /**
   * Tears the mount down and builds it again.
   *
   * The unmount is forced and its failure ignored on purpose. After an outage the old
   * mount is frequently in a state where a clean unmount is impossible; refusing to
   * remount because the corpse could not be buried tidily would leave the share offline
   * for exactly the reason we are trying to fix.
   */
  async remount(): Promise<void> {
    this.transition('remounting', 'remount requested');
    try {
      await this.unmount(true);
    } catch (error) {
      this.log.warn(
        { mountPoint: this.mountPoint, error: (error as Error).message },
        'unmount before remount failed; continuing',
      );
    }
    await this.mount();
  }

  // -------------------------------------------------------------------------
  // Health probing
  // -------------------------------------------------------------------------

  /**
   * One health probe: stat a marker path inside the mount, on a deadline.
   *
   * `ENOENT` is success. The question is not "does this file exist" but "did the server
   * answer at all", and a negative answer delivered promptly is proof that it did.
   */
  async probe(timeoutMs?: number): Promise<ProbeResult> {
    const started = this.now();
    const markerPath = join(this.mountPoint, PROBE_MARKER);
    try {
      await withTimeout(
        () => this.fs.stat(markerPath),
        timeoutMs ?? this.fsTimeoutMs,
        `probe ${markerPath}`,
      );
      return { ok: true, durationMs: this.now() - started };
    } catch (error) {
      const mountError = toMountError(error, `probe ${markerPath}`);
      if (mountError.kind === 'missing') {
        return { ok: true, durationMs: this.now() - started };
      }
      return { ok: false, durationMs: this.now() - started, error: mountError };
    }
  }

  /** Runs a probe and folds the result into the health state machine. */
  async checkHealth(): Promise<boolean> {
    const result = await this.probe();
    if (result.ok) {
      this.recordSuccess();
      return true;
    }
    this.recordFailure(
      result.error ?? new MountError('probe failed', 'transient', `probe ${this.mountPoint}`),
    );
    return false;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.currentState !== 'healthy') {
      this.reconnectAttempt = 0;
      this.transition('healthy', 'probe recovered');
    }
  }

  private recordFailure(error: MountError): void {
    if (this.currentState === 'unmounted' || this.currentState === 'remounting') {
      return;
    }
    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.offlineAfter) {
      if (this.currentState !== 'offline') {
        this.log.error(
          {
            mountPoint: this.mountPoint,
            failures: this.consecutiveFailures,
            code: error.code,
          },
          'server share is offline; sync pauses and the TNC side goes read-only',
        );
        this.transition('offline', error.message);
        this.scheduleReconnect();
      }
      return;
    }

    if (this.currentState === 'healthy') {
      this.transition('degraded', error.message);
    }
  }

  // -------------------------------------------------------------------------
  // Monitor loop
  // -------------------------------------------------------------------------

  /**
   * Starts periodic probing.
   *
   * Timers are chained rather than set on an interval, so a probe that takes longer than
   * the interval cannot stack up behind itself — with a soft-mount timeout of 15 s and a
   * 10 s interval, `setInterval` would queue probes faster than a sick server retires them.
   */
  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.scheduleProbe();
  }

  /** Stops probing and cancels any pending reconnect. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.monitorTimer !== undefined) {
      clearTimeout(this.monitorTimer);
      this.monitorTimer = undefined;
    }
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private scheduleProbe(): void {
    if (this.stopped) {
      return;
    }
    this.monitorTimer = setTimeout(() => {
      void this.runProbeTick();
    }, this.probeIntervalMs);
    this.monitorTimer.unref?.();
  }

  private async runProbeTick(): Promise<void> {
    // While offline the reconnect loop owns recovery; probing in parallel would double
    // the traffic to a server that is already not answering.
    if (this.currentState !== 'offline' && this.currentState !== 'remounting') {
      try {
        await this.checkHealth();
      } catch (error) {
        this.log.warn(
          { mountPoint: this.mountPoint, error: (error as Error).message },
          'health probe threw',
        );
      }
    }
    this.scheduleProbe();
  }

  /** Schedules the next remount attempt on the 15 s → 300 s backoff. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) {
      return;
    }
    const delay = backoffDelayMs(this.reconnectAttempt, this.jitter());
    this.log.info(
      { mountPoint: this.mountPoint, attempt: this.reconnectAttempt + 1, delayMs: delay },
      'scheduling remount',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async attemptReconnect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.reconnectAttempt += 1;
    try {
      await this.remount();
      this.log.info(
        { mountPoint: this.mountPoint, attempts: this.reconnectAttempt },
        'server share recovered',
      );
    } catch (error) {
      const mountError = toMountError(error, `remount ${this.mountPoint}`);
      this.log.warn(
        {
          mountPoint: this.mountPoint,
          attempt: this.reconnectAttempt,
          kind: mountError.kind,
          error: mountError.message,
        },
        'remount failed',
      );
      this.transition('offline', mountError.message);
      this.scheduleReconnect();
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private transition(next: MountState, reason: string): void {
    if (this.currentState === next) {
      return;
    }
    const change: MountStateChange = { previous: this.currentState, current: next, reason };
    this.currentState = next;
    this.log.info(
      { mountPoint: this.mountPoint, from: change.previous, to: next, reason },
      'mount state changed',
    );
    this.emit('state', change);
  }

  override on(event: 'state', listener: (change: MountStateChange) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

/**
 * Convenience for callers that hold a path rather than a manager — the sidecar-lock
 * projection and the version store both write into the mount without owning it.
 */
export const mountRootOf = (path: string): string => dirname(path);
