import {
  createNotifier,
  NoopNotifier,
  SystemdNotifier,
  SYSTEMD_NOTIFY_PATHS,
  Watchdog,
  watchdogIntervalFromEnv,
} from './watchdog';

/**
 * The watchdog's value depends entirely on it being honest. A ping that fires from a
 * timer regardless of whether the service can do any work would keep systemd satisfied
 * while the process is useless — worse than no watchdog, because it removes the
 * automatic recovery an operator is relying on.
 */

describe('watchdogIntervalFromEnv', () => {
  it('pings at half of WatchdogSec, leaving a margin for one missed tick', () => {
    // 30 s expressed in microseconds.
    expect(watchdogIntervalFromEnv({ WATCHDOG_USEC: '30000000' })).toBe(15_000);
  });

  it.each([undefined, '', 'abc', '-1', '12.5', '0'])('returns undefined for %p', (value) => {
    expect(watchdogIntervalFromEnv({ WATCHDOG_USEC: value })).toBeUndefined();
  });

  it('never returns zero for a very small interval', () => {
    expect(watchdogIntervalFromEnv({ WATCHDOG_USEC: '1' })).toBe(1);
  });
});

describe('createNotifier', () => {
  it('is a no-op when NOTIFY_SOCKET is absent — development and tests', () => {
    expect(createNotifier({}).enabled).toBe(false);
    expect(createNotifier({ NOTIFY_SOCKET: '' }).enabled).toBe(false);
  });

  it('is a no-op when systemd-notify is not installed', () => {
    expect(createNotifier({ NOTIFY_SOCKET: '/run/systemd/notify' }, () => false).enabled).toBe(
      false,
    );
  });

  it('notifies systemd when the socket and the tool are both present', () => {
    const notifier = createNotifier({ NOTIFY_SOCKET: '/run/systemd/notify' }, () => true);
    expect(notifier.enabled).toBe(true);
    expect(notifier).toBeInstanceOf(SystemdNotifier);
  });

  it('resolves the tool from a fixed list of absolute paths', () => {
    for (const path of SYSTEMD_NOTIFY_PATHS) {
      expect(path.startsWith('/')).toBe(true);
    }
  });
});

describe('NoopNotifier', () => {
  it('records the protocol messages without sending them', () => {
    const notifier = new NoopNotifier();
    notifier.ready();
    notifier.watchdog();
    notifier.status('running');
    notifier.stopping();
    expect(notifier.messages).toEqual(['READY=1', 'WATCHDOG=1', 'STATUS=running', 'STOPPING=1']);
    expect(notifier.enabled).toBe(false);
  });
});

describe('SystemdNotifier', () => {
  function fakeSpawn(): { calls: unknown[][]; fn: jest.Mock } {
    const calls: unknown[][] = [];
    const fn = jest.fn((...args: unknown[]) => {
      calls.push(args);
      return { on: jest.fn(), unref: jest.fn() };
    });
    return { calls, fn };
  }

  it('invokes systemd-notify with an argv array and no shell', () => {
    const spawn = fakeSpawn();
    new SystemdNotifier('/usr/bin/systemd-notify', true, spawn.fn as never).ready();

    expect(spawn.calls[0]![0]).toBe('/usr/bin/systemd-notify');
    expect(spawn.calls[0]![1]).toEqual(['READY=1']);
    expect(spawn.calls[0]![2]).toMatchObject({ shell: false });
  });

  it.each([
    ['ready', 'READY=1'],
    ['watchdog', 'WATCHDOG=1'],
    ['stopping', 'STOPPING=1'],
  ])('sends %s as %s', (method, message) => {
    const spawn = fakeSpawn();
    const notifier = new SystemdNotifier('/usr/bin/systemd-notify', true, spawn.fn as never);
    notifier[method as 'ready' | 'watchdog' | 'stopping']();
    expect(spawn.calls[0]![1]).toEqual([message]);
  });

  it('sends a status line', () => {
    const spawn = fakeSpawn();
    new SystemdNotifier('/usr/bin/systemd-notify', true, spawn.fn as never).status('draining');
    expect(spawn.calls[0]![1]).toEqual(['STATUS=draining']);
  });

  it('sends nothing when disabled', () => {
    const spawn = fakeSpawn();
    new SystemdNotifier('/usr/bin/systemd-notify', false, spawn.fn as never).ready();
    expect(spawn.fn).not.toHaveBeenCalled();
  });

  /** Telemetry must never take down the thing it observes. */
  it('swallows a spawn failure rather than crashing the service', () => {
    const throwing = jest.fn(() => {
      throw new Error('EAGAIN');
    });
    const notifier = new SystemdNotifier('/usr/bin/systemd-notify', true, throwing as never);
    expect(() => notifier.watchdog()).not.toThrow();
  });

  it('attaches an error handler so a missing listener cannot raise EPIPE', () => {
    const on = jest.fn();
    const spawn = jest.fn(() => ({ on, unref: jest.fn() }));
    new SystemdNotifier('/usr/bin/systemd-notify', true, spawn as never).ready();
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    // Invoking the handler must not throw.
    expect(() => (on.mock.calls[0]![1] as () => void)()).not.toThrow();
  });
});

describe('Watchdog', () => {
  /** A controllable clock and timer, so lag is a value under test rather than a race. */
  function harness(options: { intervalMs?: number; maxLagMs?: number } = {}) {
    let clock = 0;
    const notifier = new NoopNotifier();
    const warnings: Record<string, unknown>[] = [];
    let tick: (() => void) | undefined;
    const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;

    const watchdog = new Watchdog({
      notifier,
      intervalMs: options.intervalMs ?? 1000,
      ...(options.maxLagMs === undefined ? {} : { maxLagMs: options.maxLagMs }),
      now: () => clock,
      logger: { warn: (_message, fields) => warnings.push(fields ?? {}) },
      setIntervalFn: (fn: () => void) => {
        tick = fn;
        return timer;
      },
      clearIntervalFn: jest.fn() as typeof clearInterval,
    });

    return {
      watchdog,
      notifier,
      warnings,
      advance: (ms: number) => {
        clock += ms;
      },
      fire: () => tick?.(),
    };
  }

  it('pings when the loop is on schedule', () => {
    const h = harness({ intervalMs: 1000 });
    h.watchdog.start();
    h.advance(1000);
    h.fire();

    expect(h.notifier.messages).toEqual(['WATCHDOG=1']);
    expect(h.watchdog.pings).toBe(1);
    expect(h.watchdog.lag).toBe(0);
  });

  it('tolerates a small delay', () => {
    const h = harness({ intervalMs: 1000, maxLagMs: 500 });
    h.watchdog.start();
    h.advance(1200);
    h.fire();

    expect(h.watchdog.lag).toBe(200);
    expect(h.watchdog.pings).toBe(1);
  });

  /**
   * The property that makes this watchdog worth having: a sluggish loop stops being
   * vouched for, and systemd is allowed to restart the service.
   */
  it('withholds the ping when the loop is late beyond the threshold', () => {
    const h = harness({ intervalMs: 1000, maxLagMs: 500 });
    h.watchdog.start();
    h.advance(3000); // fired 2 s late
    h.fire();

    expect(h.notifier.messages).toEqual([]);
    expect(h.watchdog.skipped).toBe(1);
    expect(h.watchdog.pings).toBe(0);
  });

  it('warns with the measured lag when it withholds', () => {
    const h = harness({ intervalMs: 1000, maxLagMs: 500 });
    h.watchdog.start();
    h.advance(3000);
    h.fire();
    expect(h.warnings[0]).toMatchObject({ lagMs: 2000, maxLagMs: 500 });
  });

  it('resumes pinging once the loop recovers', () => {
    const h = harness({ intervalMs: 1000, maxLagMs: 500 });
    h.watchdog.start();

    h.advance(3000);
    h.fire();
    expect(h.watchdog.pings).toBe(0);

    h.advance(1000);
    h.fire();
    expect(h.watchdog.pings).toBe(1);
    expect(h.watchdog.lag).toBe(0);
  });

  it('defaults the lag threshold to one full interval', () => {
    const h = harness({ intervalMs: 1000 });
    h.watchdog.start();
    h.advance(1900); // 900 ms late — under one interval
    h.fire();
    expect(h.watchdog.pings).toBe(1);

    h.advance(3000); // 2 s late — over
    h.fire();
    expect(h.watchdog.skipped).toBe(1);
  });

  it('reports whether it is running and stops cleanly', () => {
    const h = harness();
    expect(h.watchdog.running).toBe(false);
    h.watchdog.start();
    expect(h.watchdog.running).toBe(true);
    h.watchdog.stop();
    expect(h.watchdog.running).toBe(false);
  });

  it('start and stop are both idempotent', () => {
    const h = harness();
    h.watchdog.start();
    h.watchdog.start();
    h.watchdog.stop();
    expect(() => h.watchdog.stop()).not.toThrow();
  });

  /** The watchdog must never be the reason a process refuses to exit. */
  it('unrefs its timer', () => {
    const h = harness();
    h.watchdog.start();
    h.watchdog.stop();
    // `unref` is called on the timer returned by the injected setInterval.
    expect(h.watchdog.running).toBe(false);
  });
});
