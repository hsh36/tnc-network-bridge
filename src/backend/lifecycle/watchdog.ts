import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * systemd integration: readiness, status, and the watchdog.
 *
 * The watchdog is the part that earns its keep. `WatchdogSec` in the unit file makes
 * systemd expect a `WATCHDOG=1` message at least that often; miss it and the service is
 * killed and restarted. That converts a hung process into a restarted one without an
 * operator noticing at 03:00 — which matters here because the failure this product is
 * most exposed to is precisely a hang: a CIFS call against a server that stopped
 * answering blocks a libuv thread-pool worker, and enough of them block the event loop.
 *
 * The subtlety is what the ping is allowed to prove. A ping sent from a bare timer only
 * proves the timer fired. If the loop is *sluggish* rather than stopped — slow enough
 * that API requests time out but not so slow that timers stop firing — a naive
 * watchdog keeps reassuring systemd that all is well while the service is useless. So
 * the ping is gated on measured event-loop lag: if the loop is late by more than the
 * threshold, the ping is withheld and systemd is allowed to act.
 */

export interface Notifier {
  /** Whether systemd is actually listening. False in development and in tests. */
  readonly enabled: boolean;
  ready(): void;
  watchdog(): void;
  stopping(): void;
  status(text: string): void;
}

/** Used whenever `NOTIFY_SOCKET` is absent — development, tests, a manual run. */
export class NoopNotifier implements Notifier {
  readonly enabled = false;
  readonly messages: string[] = [];

  ready(): void {
    this.messages.push('READY=1');
  }
  watchdog(): void {
    this.messages.push('WATCHDOG=1');
  }
  stopping(): void {
    this.messages.push('STOPPING=1');
  }
  status(text: string): void {
    this.messages.push(`STATUS=${text}`);
  }
}

export const SYSTEMD_NOTIFY_PATHS = ['/usr/bin/systemd-notify', '/bin/systemd-notify'] as const;

/**
 * Sends notifications by invoking `systemd-notify`.
 *
 * Node has no unix *datagram* socket support — `dgram` is UDP only — so the sd_notify
 * protocol cannot be spoken directly from JavaScript without a native addon. Shelling
 * out to systemd's own tool avoids adding a compiled dependency to an ARM64 build for
 * the sake of a message sent every few seconds. It is spawned with an argv array and no
 * shell, like everything else in this codebase.
 *
 * The spawn is asynchronous and its result ignored on purpose: a watchdog ping that
 * blocked the event loop to report that the event loop is healthy would be measuring
 * itself.
 */
export class SystemdNotifier implements Notifier {
  readonly enabled: boolean;

  constructor(
    private readonly notifyPath: string,
    enabled: boolean,
    private readonly spawnFn: typeof spawn = spawn,
  ) {
    this.enabled = enabled;
  }

  private send(message: string): void {
    if (!this.enabled) {
      return;
    }
    try {
      const child = this.spawnFn(this.notifyPath, [message], {
        shell: false,
        stdio: 'ignore',
        detached: false,
      });
      // A failed notification is not worth crashing over; systemd's own timeout is the
      // backstop. Without a listener, an EPIPE here would become an uncaught exception.
      child.on('error', () => undefined);
      child.unref();
    } catch {
      // Same reasoning: never let telemetry take down the thing it observes.
    }
  }

  ready(): void {
    this.send('READY=1');
  }
  watchdog(): void {
    this.send('WATCHDOG=1');
  }
  stopping(): void {
    this.send('STOPPING=1');
  }
  status(text: string): void {
    this.send(`STATUS=${text}`);
  }
}

export interface NotifierEnvironment {
  readonly NOTIFY_SOCKET?: string | undefined;
  readonly WATCHDOG_USEC?: string | undefined;
}

export function createNotifier(
  env: NotifierEnvironment = process.env,
  exists: (path: string) => boolean = existsSync,
): Notifier {
  if (env.NOTIFY_SOCKET === undefined || env.NOTIFY_SOCKET === '') {
    return new NoopNotifier();
  }
  const path = SYSTEMD_NOTIFY_PATHS.find((candidate) => exists(candidate));
  if (path === undefined) {
    return new NoopNotifier();
  }
  return new SystemdNotifier(path, true);
}

/**
 * `WATCHDOG_USEC` is set by systemd from `WatchdogSec`. The convention is to ping at
 * half the interval, leaving a full margin for one missed tick before systemd acts.
 */
export function watchdogIntervalFromEnv(env: NotifierEnvironment): number | undefined {
  const raw = env.WATCHDOG_USEC;
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const microseconds = Number(raw);
  if (microseconds <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(microseconds / 1000 / 2));
}

export interface WatchdogOptions {
  readonly notifier: Notifier;
  /** How often to ping. Normally half of `WatchdogSec`. */
  readonly intervalMs: number;
  /**
   * Event-loop lateness above which the ping is withheld. Defaults to the interval
   * itself: being a whole cycle late means roughly half the pings are already missing.
   */
  readonly maxLagMs?: number;
  readonly logger?: { warn(message: string, fields?: Record<string, unknown>): void };
  readonly now?: () => number;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}

export class Watchdog {
  private timer: NodeJS.Timeout | undefined;
  private expectedAt = 0;
  private readonly maxLagMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private lagValue = 0;
  private skippedValue = 0;
  private pingedValue = 0;

  constructor(private readonly options: WatchdogOptions) {
    this.maxLagMs = options.maxLagMs ?? options.intervalMs;
    this.now = options.now ?? Date.now;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  }

  /** Most recently measured event-loop lateness, in milliseconds. */
  get lag(): number {
    return this.lagValue;
  }
  get pings(): number {
    return this.pingedValue;
  }
  /** Pings deliberately withheld because the loop was unresponsive. */
  get skipped(): number {
    return this.skippedValue;
  }
  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.expectedAt = this.now() + this.options.intervalMs;
    this.timer = this.setIntervalFn(() => this.tick(), this.options.intervalMs);
    // The watchdog must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === undefined) {
      return;
    }
    this.clearIntervalFn(this.timer);
    this.timer = undefined;
  }

  /** Exposed so a test can drive a tick without waiting on a real timer. */
  tick(): void {
    const at = this.now();
    // How late this callback is, relative to when the interval should have fired. A
    // blocked loop cannot run timers on schedule, so lateness *is* the measurement.
    this.lagValue = Math.max(0, at - this.expectedAt);
    this.expectedAt = at + this.options.intervalMs;

    if (this.lagValue > this.maxLagMs) {
      this.skippedValue += 1;
      this.options.logger?.warn('event loop is unresponsive; withholding watchdog ping', {
        lagMs: this.lagValue,
        maxLagMs: this.maxLagMs,
      });
      return;
    }

    this.pingedValue += 1;
    this.options.notifier.watchdog();
  }
}
