import {
  Lifecycle,
  type LifecycleLogger,
  StageStartError,
  type Stage,
  describeError,
  silentLogger,
  withTimeout,
} from './lifecycle';

/**
 * The two properties worth proving: subsystems stop in the reverse of the order they
 * started, and a failed start leaves nothing behind. Everything else in this file
 * exists to make those two impossible to regress.
 */

function recordingLogger(): LifecycleLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info:${message}`),
    warn: (message) => lines.push(`warn:${message}`),
    error: (message) => lines.push(`error:${message}`),
  };
}

/** A stage that appends to a shared trace on start and stop. */
function tracer(trace: string[], name: string, overrides: Partial<Stage> = {}): Stage {
  return {
    name,
    start: () => {
      trace.push(`start:${name}`);
    },
    stop: () => {
      trace.push(`stop:${name}`);
    },
    ...overrides,
  };
}

describe('startup ordering', () => {
  it('starts stages in registration order', async () => {
    const trace: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle
      .register(tracer(trace, 'db'))
      .register(tracer(trace, 'logging'))
      .register(tracer(trace, 'web'));

    await lifecycle.start();
    expect(trace).toEqual(['start:db', 'start:logging', 'start:web']);
    expect(lifecycle.state).toBe('running');
  });

  it('awaits an async stage before starting the next', async () => {
    const trace: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle.register({
      name: 'slow',
      start: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        trace.push('start:slow');
      },
    });
    lifecycle.register(tracer(trace, 'fast'));

    await lifecycle.start();
    expect(trace).toEqual(['start:slow', 'start:fast']);
  });

  it('reports which stages are running', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.register(tracer([], 'a')).register(tracer([], 'b'));
    await lifecycle.start();
    expect(lifecycle.running).toEqual(['a', 'b']);
  });

  it('refuses to start twice', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.register(tracer([], 'a'));
    await lifecycle.start();
    await expect(lifecycle.start()).rejects.toThrow(/while the lifecycle is "running"/);
  });

  it('refuses to register after starting', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.register(tracer([], 'a'));
    await lifecycle.start();
    expect(() => lifecycle.register(tracer([], 'b'))).toThrow(/cannot register/);
  });

  it('refuses a duplicate stage name', () => {
    const lifecycle = new Lifecycle();
    lifecycle.register(tracer([], 'a'));
    expect(() => lifecycle.register(tracer([], 'a'))).toThrow(/already registered/);
  });
});

describe('shutdown ordering', () => {
  /** Nothing may be torn down before the things that depend on it. */
  it('stops in the reverse of the start order', async () => {
    const trace: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle
      .register(tracer(trace, 'db'))
      .register(tracer(trace, 'logging'))
      .register(tracer(trace, 'web'));

    await lifecycle.start();
    trace.length = 0;
    await lifecycle.stop();

    expect(trace).toEqual(['stop:web', 'stop:logging', 'stop:db']);
    expect(lifecycle.state).toBe('stopped');
  });

  it('skips stages that declare no stop', async () => {
    const trace: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle.register({
      name: 'pure',
      start: () => {
        trace.push('start:pure');
      },
    });
    lifecycle.register(tracer(trace, 'db'));

    await lifecycle.start();
    const reports = await lifecycle.stop();
    expect(reports.map((report) => report.stage)).toEqual(['db', 'pure']);
    expect(reports.every((report) => report.outcome === 'stopped')).toBe(true);
  });

  /**
   * systemd may send a second SIGTERM, and SIGINT can arrive alongside it. A competing
   * shutdown would close the database twice.
   */
  it('is idempotent — concurrent stops join the one in progress', async () => {
    const trace: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle.register(tracer(trace, 'db'));
    await lifecycle.start();

    await Promise.all([lifecycle.stop(), lifecycle.stop(), lifecycle.stop()]);
    expect(trace.filter((entry) => entry === 'stop:db')).toHaveLength(1);
  });

  it('stopping before starting is a no-op', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.register(tracer([], 'db'));
    expect(await lifecycle.stop()).toEqual([]);
    expect(lifecycle.state).toBe('stopped');
  });

  /**
   * A hung CIFS unmount must not be the reason the database is left un-checkpointed, so
   * the stages after a failing one still run.
   */
  it('continues stopping after a stage throws', async () => {
    const trace: string[] = [];
    const logger = recordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.register(tracer(trace, 'db'));
    lifecycle.register({
      name: 'unmount',
      start: () => undefined,
      stop: () => {
        throw new Error('device is busy');
      },
    });

    await lifecycle.start();
    const reports = await lifecycle.stop();

    expect(trace).toContain('stop:db');
    expect(reports).toEqual([
      { stage: 'unmount', outcome: 'error', error: 'device is busy' },
      { stage: 'db', outcome: 'stopped' },
    ]);
    expect(logger.lines).toContain('error:subsystem failed to stop');
  });

  it('moves on when a stage exceeds its stop budget', async () => {
    const trace: string[] = [];
    const logger = recordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.register(tracer(trace, 'db'));
    lifecycle.register({
      name: 'hung-unmount',
      start: () => undefined,
      stop: () => new Promise<void>(() => undefined), // never settles
      stopTimeoutMs: 20,
    });

    await lifecycle.start();
    const reports = await lifecycle.stop();

    expect(reports[0]).toEqual({ stage: 'hung-unmount', outcome: 'timeout' });
    // The critical part: the database was still closed despite the hang above it.
    expect(trace).toContain('stop:db');
    expect(logger.lines).toContain('warn:subsystem did not stop within its budget');
  });

  it('applies the lifecycle-wide default budget when a stage sets none', async () => {
    const lifecycle = new Lifecycle({ stopTimeoutMs: 20 });
    lifecycle.register({
      name: 'hung',
      start: () => undefined,
      stop: () => new Promise<void>(() => undefined),
    });
    await lifecycle.start();
    expect((await lifecycle.stop())[0]).toMatchObject({ outcome: 'timeout' });
  });
});

describe('failed startup unwinds', () => {
  /**
   * Without this, a failed start leaks the handles — open databases, bound sockets, live
   * timers — that make the *next* start fail too, turning one bad config into a restart
   * loop the service never escapes.
   */
  it('stops the already-started stages in reverse order', async () => {
    const trace: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle.register(tracer(trace, 'db'));
    lifecycle.register(tracer(trace, 'logging'));
    lifecycle.register({
      name: 'web',
      start: () => {
        throw new Error('EADDRINUSE :443');
      },
    });

    await expect(lifecycle.start()).rejects.toThrow(StageStartError);
    expect(trace).toEqual(['start:db', 'start:logging', 'stop:logging', 'stop:db']);
  });

  it('does not start the stages after the failing one', async () => {
    const trace: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle.register({
      name: 'secret-key',
      start: () => {
        throw new Error('secret.key is unreadable');
      },
    });
    lifecycle.register(tracer(trace, 'db'));

    await expect(lifecycle.start()).rejects.toThrow(/secret.key is unreadable/);
    expect(trace).toEqual([]);
  });

  it('names the failing stage on the error', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.register({
      name: 'migrations',
      start: () => {
        throw new Error('schema is ahead of this build');
      },
    });

    await expect(lifecycle.start()).rejects.toMatchObject({
      name: 'StageStartError',
      stage: 'migrations',
    });
  });

  it('ends in the failed state', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.register({
      name: 'boom',
      start: () => {
        throw new Error('nope');
      },
    });
    await expect(lifecycle.start()).rejects.toThrow();
    expect(lifecycle.state).toBe('failed');
    expect(lifecycle.running).toEqual([]);
  });

  it('rejects a stage that fails asynchronously', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.register({
      name: 'async-boom',
      start: () => Promise.reject(new Error('async nope')),
    });
    await expect(lifecycle.start()).rejects.toThrow(/async nope/);
  });

  it('logs the failure', async () => {
    const logger = recordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.register({
      name: 'boom',
      start: () => {
        throw new Error('nope');
      },
    });
    await expect(lifecycle.start()).rejects.toThrow();
    expect(logger.lines).toContain('error:subsystem failed to start');
  });
});

describe('withTimeout', () => {
  it('resolves true when the work finishes in time', async () => {
    const onTimeout = jest.fn();
    expect(await withTimeout(Promise.resolve(), 100, onTimeout)).toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('resolves false and reports when the budget passes', async () => {
    const onTimeout = jest.fn();
    const never = new Promise<void>(() => undefined);
    expect(await withTimeout(never, 10, onTimeout)).toBe(false);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('propagates a rejection rather than swallowing it', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100, jest.fn())).rejects.toThrow(
      'boom',
    );
  });
});

describe('describeError', () => {
  it('uses the message of an Error', () => {
    expect(describeError(new Error('a message'))).toBe('a message');
  });

  it('stringifies anything else', () => {
    expect(describeError('a string')).toBe('a string');
    expect(describeError(42)).toBe('42');
    expect(describeError(undefined)).toBe('undefined');
  });
});

describe('silentLogger', () => {
  it('accepts every level without throwing', () => {
    expect(() => {
      silentLogger.info('a');
      silentLogger.warn('b');
      silentLogger.error('c');
    }).not.toThrow();
  });
});
