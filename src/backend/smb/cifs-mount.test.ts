import { type Stats } from 'node:fs';

import { PrivilegedCallError } from '../privileged/client';
import { type PrivilegedRequest } from '../privileged/verbs';
import {
  assertSoftMount,
  backoffDelayMs,
  CifsMountManager,
  classifyError,
  errnoOf,
  findMountEntry,
  isTransient,
  type MountEntry,
  MountError,
  type MountFs,
  type MountSpec,
  type MountState,
  type MountStateChange,
  parseProcMounts,
  PROBE_MARKER,
  toMountError,
  withTimeout,
} from './cifs-mount';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHARE = 'programs';
const MOUNT_POINT = '/mnt/tnc-server/programs';

const SPEC: MountSpec = {
  shareName: SHARE,
  serverUnc: '//fileserver/cnc$/programs',
  smbVersion: '3.1.1',
  seal: true,
  domain: 'WORK',
  username: 'svc-tnc',
  password: 'correct horse battery staple',
  uid: 1001,
  gid: 1001,
};

const SOFT_OPTIONS = 'rw,relatime,vers=3.1.1,seal,soft,noserverino,actimeo=1';

function errnoError(code: string, message = code): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

const FAKE_STATS = { size: 0, mtimeMs: 0 } as unknown as Stats;

/**
 * A filesystem stand-in backed by a mutable mount table, so a test can make the mount
 * appear, vanish, or come back the way a real server does.
 */
class FakeFs implements MountFs {
  mountLine: string | undefined;
  statError: NodeJS.ErrnoException | undefined;
  statDelayMs = 0;
  mkdirCalls: string[] = [];
  statCalls: string[] = [];

  constructor(mounted = false, options = SOFT_OPTIONS) {
    if (mounted) {
      this.mount(options);
    }
  }

  mount(options = SOFT_OPTIONS): void {
    this.mountLine = `//fileserver/cnc$/programs ${MOUNT_POINT} cifs ${options} 0 0`;
  }

  unmount(): void {
    this.mountLine = undefined;
  }

  stat(path: string): Promise<Stats> {
    this.statCalls.push(path);
    if (this.statDelayMs > 0) {
      return new Promise<Stats>((resolve, reject) => {
        // Unref'd: this models a call the timeout wrapper abandons, and an abandoned
        // fake must not hold the test runner open the way the real syscall would not.
        const timer = setTimeout(() => {
          if (this.statError !== undefined) {
            reject(this.statError);
          } else {
            resolve(FAKE_STATS);
          }
        }, this.statDelayMs);
        timer.unref?.();
      });
    }
    return this.statError !== undefined
      ? Promise.reject(this.statError)
      : Promise.resolve(FAKE_STATS);
  }

  readFile(_path: string, _encoding: 'utf8'): Promise<string> {
    const lines = ['proc /proc proc rw,relatime 0 0', 'sysfs /sys sysfs rw 0 0'];
    if (this.mountLine !== undefined) {
      lines.push(this.mountLine);
    }
    return Promise.resolve(`${lines.join('\n')}\n`);
  }

  mkdir(path: string, _options: { recursive: true }): Promise<string | undefined> {
    this.mkdirCalls.push(path);
    return Promise.resolve(undefined);
  }
}

/** Records helper calls and mutates the fake mount table the way the real helper would. */
function makeInvoker(fs: FakeFs, options?: { failWith?: PrivilegedCallError }) {
  const calls: PrivilegedRequest[] = [];
  const invoke = jest.fn((request: PrivilegedRequest) => {
    calls.push(request);
    if (options?.failWith !== undefined) {
      throw options.failWith;
    }
    if (request.verb === 'mount-share') {
      fs.mount();
    }
    if (request.verb === 'unmount-share') {
      fs.unmount();
    }
    return { ok: true as const };
  });
  return { invoke, calls };
}

function makeManager(
  fs: FakeFs,
  invoke: ReturnType<typeof makeInvoker>['invoke'],
  overrides: Partial<ConstructorParameters<typeof CifsMountManager>[0]> = {},
): CifsMountManager {
  return new CifsMountManager({
    spec: SPEC,
    fs,
    // The invoker's real signature returns a HelperResponse; the fake returns the
    // success shape, which is all this module reads.
    invoke: invoke as never,
    procMountsPath: '/proc/self/mounts',
    fsTimeoutMs: 200,
    probeIntervalMs: 50,
    jitter: () => 0.5,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  it('treats EIO as transient — it is what a soft mount returns for a vanished server', () => {
    // The single most consequential mapping in the module. Getting this wrong marks
    // every file on the share as errored the moment a switch reboots.
    expect(classifyError(errnoError('EIO'))).toBe('transient');
    expect(isTransient(errnoError('EIO'))).toBe(true);
  });

  it.each(['ESTALE', 'ENOTCONN', 'ETIMEDOUT', 'EHOSTDOWN', 'ECONNRESET', 'ENETUNREACH'])(
    'classifies %s as transient',
    (code) => {
      expect(classifyError(errnoError(code))).toBe('transient');
    },
  );

  it.each(['EACCES', 'EPERM', 'EROFS'])('classifies %s as permission, never retried', (code) => {
    expect(classifyError(errnoError(code))).toBe('permission');
    expect(isTransient(errnoError(code))).toBe(false);
  });

  it.each(['ENOENT', 'ENOTDIR'])('classifies %s as missing', (code) => {
    expect(classifyError(errnoError(code))).toBe('missing');
  });

  it('classifies an unrecognised errno as unknown rather than guessing transient', () => {
    // Guessing "transient" on an unknown error produces an infinite retry loop that
    // hides the real fault, so the default must be the conservative one.
    expect(classifyError(errnoError('EWHATEVER'))).toBe('unknown');
    expect(isTransient(errnoError('EWHATEVER'))).toBe(false);
  });

  it('classifies a value with no errno at all as unknown', () => {
    expect(classifyError(new Error('plain'))).toBe('unknown');
    expect(classifyError('a string')).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
    expect(errnoOf(null)).toBeUndefined();
    expect(errnoOf({ code: 42 })).toBeUndefined();
  });

  it('preserves an existing classification instead of laundering it back to unknown', () => {
    const original = new MountError('gone', 'transient', 'stat', 'EIO');
    expect(classifyError(original)).toBe('transient');
    expect(toMountError(original, 'other')).toBe(original);
  });

  it('wraps a non-Error throw without losing the operation label', () => {
    const wrapped = toMountError('boom', 'stat /mnt/x');
    expect(wrapped).toBeInstanceOf(MountError);
    expect(wrapped.operation).toBe('stat /mnt/x');
    expect(wrapped.message).toContain('boom');
  });

  it('reports timeout as transient for retry purposes but distinct in kind', () => {
    const error = new MountError('slow', 'timeout', 'stat', 'ETIMEDOUT');
    expect(error.transient).toBe(true);
    expect(error.kind).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe('withTimeout', () => {
  it('returns the value when the operation finishes in time', async () => {
    await expect(withTimeout(() => Promise.resolve(7), 1000, 'op')).resolves.toBe(7);
  });

  it('rejects with a typed timeout error when the operation hangs', async () => {
    // This is the guarantee that matters under R3: the caller is released even though
    // the underlying syscall cannot be cancelled.
    const hang = () => new Promise<never>(() => undefined);
    const error: unknown = await withTimeout(hang, 20, 'stat /mnt/x').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MountError);
    expect((error as MountError).kind).toBe('timeout');
    expect((error as MountError).transient).toBe(true);
    expect((error as MountError).message).toContain('20 ms');
  });

  it('classifies a rejection from the operation itself', async () => {
    const error: unknown = await withTimeout(
      () => Promise.reject(errnoError('EIO')),
      1000,
      'stat',
    ).catch((e: unknown) => e);
    expect((error as MountError).kind).toBe('transient');
  });

  it('turns a synchronous throw into a classified rejection', async () => {
    const error: unknown = await withTimeout(
      () => {
        throw errnoError('EACCES');
      },
      1000,
      'stat',
    ).catch((e: unknown) => e);
    expect((error as MountError).kind).toBe('permission');
  });

  it('does not leave a pending timer behind after the operation wins', async () => {
    jest.useFakeTimers();
    try {
      const promise = withTimeout(() => Promise.resolve('done'), 60_000, 'op');
      await expect(promise).resolves.toBe('done');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// /proc/self/mounts
// ---------------------------------------------------------------------------

describe('parseProcMounts', () => {
  it('parses device, mount point, type and options', () => {
    const entries = parseProcMounts(
      `//fileserver/cnc$ ${MOUNT_POINT} cifs rw,soft,noserverino 0 0\n`,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      device: '//fileserver/cnc$',
      mountPoint: MOUNT_POINT,
      fsType: 'cifs',
    });
    expect(entries[0]?.options).toEqual(['rw', 'soft', 'noserverino']);
  });

  it('unescapes octal sequences so a share name with a space still matches', () => {
    // Without this the mount looks absent and gets remounted forever.
    const entries = parseProcMounts(
      '//srv/x /mnt/tnc-server/CNC\\040Programme cifs rw,soft 0 0\n',
    );
    expect(entries[0]?.mountPoint).toBe('/mnt/tnc-server/CNC Programme');
  });

  it('skips blank and malformed lines instead of throwing', () => {
    const entries = parseProcMounts('\n\nnot-enough-fields\n//a /b cifs rw 0 0\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.mountPoint).toBe('/b');
  });

  it('tolerates an entry with no options field', () => {
    const entries = parseProcMounts('//a /b cifs\n');
    expect(entries[0]?.options).toEqual([]);
  });
});

describe('findMountEntry', () => {
  it('throws a missing-kind error when nothing is mounted there', () => {
    const error: unknown = (() => {
      try {
        findMountEntry([], MOUNT_POINT);
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect((error as MountError).kind).toBe('missing');
  });
});

describe('assertSoftMount', () => {
  const entry = (options: string): MountEntry => ({
    device: '//fileserver/cnc$',
    mountPoint: MOUNT_POINT,
    fsType: 'cifs',
    options: options.split(','),
  });

  it('accepts a soft mount carrying noserverino', () => {
    expect(() => assertSoftMount(entry('rw,soft,noserverino'))).not.toThrow();
  });

  it('rejects an explicitly hard mount', () => {
    expect(() => assertSoftMount(entry('rw,hard,noserverino'))).toThrow(/hard/);
  });

  it('rejects a mount that names neither, because the kernel default is hard', () => {
    // The check has to be positive. A "reject if it says hard" test would pass this
    // input while the mount is, in fact, hard.
    expect(() => assertSoftMount(entry('rw,noserverino'))).toThrow(/does not carry the 'soft'/);
  });

  it('rejects a soft mount missing noserverino', () => {
    expect(() => assertSoftMount(entry('rw,soft'))).toThrow(/noserverino/);
  });
});

// ---------------------------------------------------------------------------
// backoff
// ---------------------------------------------------------------------------

describe('backoffDelayMs', () => {
  it('walks the 15 s → 300 s schedule', () => {
    const delays = [0, 1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, 0.5));
    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000]);
  });

  it('caps at 300 s rather than growing without bound', () => {
    expect(backoffDelayMs(50, 0.5)).toBe(300_000);
  });

  it('applies ±10 % jitter so a rack of bridges does not retry in lockstep', () => {
    expect(backoffDelayMs(0, 0)).toBe(13_500);
    expect(backoffDelayMs(0, 1)).toBe(16_500);
  });

  it('clamps a negative attempt to the first step', () => {
    expect(backoffDelayMs(-3, 0.5)).toBe(15_000);
  });
});

// ---------------------------------------------------------------------------
// Manager: mount / unmount
// ---------------------------------------------------------------------------

describe('CifsMountManager mounting', () => {
  it('mounts, asserts the options and probes before declaring itself healthy', async () => {
    const fs = new FakeFs(false);
    const { invoke, calls } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);

    await manager.mount();

    expect(manager.state).toBe('healthy');
    expect(manager.healthy).toBe(true);
    expect(calls[0]?.verb).toBe('mount-share');
    expect(fs.mkdirCalls).toContain(MOUNT_POINT);
    // The probe must target the marker inside the mount, not the mount point itself,
    // whose attributes the kernel can serve from cache after the server is gone.
    expect(fs.statCalls.some((path) => path.endsWith(PROBE_MARKER))).toBe(true);
  });

  it('passes the share spec through to the helper unchanged', async () => {
    const fs = new FakeFs(false);
    const { invoke, calls } = makeInvoker(fs);
    await makeManager(fs, invoke).mount();

    expect(calls[0]).toMatchObject({
      verb: 'mount-share',
      shareName: SHARE,
      serverUnc: SPEC.serverUnc,
      mountPoint: MOUNT_POINT,
      smbVersion: '3.1.1',
      seal: true,
    });
  });

  it('refuses to use a hard mount even when the mount call succeeded', async () => {
    // The AC that matters most: asking for `soft` and trusting it was honoured is not
    // the same as checking what the kernel actually applied.
    const fs = new FakeFs(false);
    const invoke = jest.fn((request: PrivilegedRequest) => {
      if (request.verb === 'mount-share') {
        fs.mount('rw,hard,noserverino');
      }
      return { ok: true as const };
    });
    const manager = makeManager(fs, invoke as never);

    await expect(manager.mount()).rejects.toThrow(/hard/);
    expect(manager.state).not.toBe('healthy');
  });

  it('does not re-issue a mount when the share is already mounted', async () => {
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);

    await makeManager(fs, invoke).mount();

    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails the mount when the post-mount probe cannot reach the server', async () => {
    const fs = new FakeFs(false);
    fs.statError = errnoError('EIO');
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);

    await expect(manager.mount()).rejects.toThrow(MountError);
    expect(manager.state).not.toBe('healthy');
  });

  it('maps a credentials failure from the helper to a permission error, not a retry', async () => {
    const fs = new FakeFs(false);
    const { invoke } = makeInvoker(fs, {
      failWith: new PrivilegedCallError(
        'mount error: NT_STATUS_LOGON_FAILURE',
        'failed',
        32,
      ),
    });
    const manager = makeManager(fs, invoke);

    const error: unknown = await manager.mount().catch((e: unknown) => e);
    expect((error as MountError).kind).toBe('permission');
  });

  it('maps an unreachable host from the helper to a transient error', async () => {
    const fs = new FakeFs(false);
    const { invoke } = makeInvoker(fs, {
      failWith: new PrivilegedCallError('Unable to find suitable address', 'failed', 32),
    });

    const error: unknown = await makeManager(fs, invoke)
      .mount()
      .catch((e: unknown) => e);
    expect((error as MountError).kind).toBe('transient');
    expect((error as MountError).transient).toBe(true);
  });

  it('unmounts and reports the state', async () => {
    const fs = new FakeFs(true);
    const { invoke, calls } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);

    await manager.unmount();

    expect(calls[0]).toMatchObject({ verb: 'unmount-share', force: false });
    expect(manager.state).toBe('unmounted');
    expect(await manager.isMounted()).toBe(false);
  });

  it('short-circuits an unmount when nothing is mounted', async () => {
    const fs = new FakeFs(false);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);

    await manager.unmount();

    expect(invoke).not.toHaveBeenCalled();
    expect(manager.state).toBe('unmounted');
  });

  it('remounts even when the unmount of a dead mount fails', async () => {
    // After an outage a clean unmount is often impossible. Refusing to remount because
    // the corpse could not be buried tidily would leave the share offline for exactly
    // the reason we are trying to fix.
    const fs = new FakeFs(true);
    let unmountAttempts = 0;
    const invoke = jest.fn((request: PrivilegedRequest) => {
      if (request.verb === 'unmount-share') {
        unmountAttempts += 1;
        throw new PrivilegedCallError('target is busy', 'failed', 16);
      }
      if (request.verb === 'mount-share') {
        fs.mount();
      }
      return { ok: true as const };
    });
    const manager = makeManager(fs, invoke as never);

    await manager.remount();

    expect(unmountAttempts).toBe(1);
    expect(manager.state).toBe('healthy');
  });

  it('serialises concurrent operations so they cannot interleave', async () => {
    const fs = new FakeFs(false);
    const { invoke, calls } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);

    await Promise.all([manager.mount(), manager.mount(), manager.mount()]);

    // The first call mounts; the others observe the mount already present.
    expect(calls.filter((call) => call.verb === 'mount-share')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Manager: probing and health
// ---------------------------------------------------------------------------

describe('CifsMountManager probing', () => {
  it('treats ENOENT on the marker as a healthy answer', async () => {
    // The question is "did the server answer", not "does this file exist". A prompt
    // negative is proof that it did.
    const fs = new FakeFs(true);
    fs.statError = errnoError('ENOENT');
    const { invoke } = makeInvoker(fs);

    const result = await makeManager(fs, invoke).probe();

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('reports EIO as a failed probe carrying the classified error', async () => {
    const fs = new FakeFs(true);
    fs.statError = errnoError('EIO');
    const { invoke } = makeInvoker(fs);

    const result = await makeManager(fs, invoke).probe();

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('transient');
  });

  it('bounds a hanging probe by the timeout rather than waiting forever', async () => {
    const fs = new FakeFs(true);
    fs.statDelayMs = 5_000;
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke, { fsTimeoutMs: 30 });

    const result = await manager.probe();

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('timeout');
  });

  it('goes healthy → degraded on the first failure, offline on the third', async () => {
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);
    const states: MountState[] = [];
    manager.on('state', (change: MountStateChange) => states.push(change.current));

    await manager.mount();
    expect(manager.state).toBe('healthy');

    // A single dropped probe must not flip a whole share into read-only.
    fs.statError = errnoError('EIO');
    await manager.checkHealth();
    expect(manager.state).toBe('degraded');

    await manager.checkHealth();
    expect(manager.state).toBe('degraded');

    await manager.checkHealth();
    expect(manager.state).toBe('offline');

    expect(states).toEqual(['healthy', 'degraded', 'offline']);
    manager.stop();
  });

  it('returns to healthy from degraded when the server answers again', async () => {
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);

    await manager.mount();
    fs.statError = errnoError('EIO');
    await manager.checkHealth();
    expect(manager.state).toBe('degraded');

    fs.statError = undefined;
    await manager.checkHealth();
    expect(manager.state).toBe('healthy');
    manager.stop();
  });

  it('does not degrade a mount that was never mounted', async () => {
    const fs = new FakeFs(false);
    fs.statError = errnoError('EIO');
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);

    await manager.checkHealth();

    expect(manager.state).toBe('unmounted');
  });
});

// ---------------------------------------------------------------------------
// Manager: guard()
// ---------------------------------------------------------------------------

describe('CifsMountManager.guard', () => {
  it('passes a value through untouched', async () => {
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);

    await expect(manager.guard('op', () => Promise.resolve('value'))).resolves.toBe('value');
  });

  it('surfaces a typed transient error within the timeout and never blocks', async () => {
    // The T10 acceptance criterion, stated directly: a server that disappears mid-call
    // produces a classified error on a deadline instead of parking a pool thread.
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke, { fsTimeoutMs: 30 });
    await manager.mount();

    const started = Date.now();
    const error: unknown = await manager
      .guard('stat /mnt/tnc-server/programs/x.H', () => new Promise<never>(() => undefined))
      .catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect((error as MountError).kind).toBe('timeout');
    expect((error as MountError).transient).toBe(true);
    manager.stop();
  });

  it('feeds transient failures into the health state machine', async () => {
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);
    await manager.mount();

    await manager.guard('op', () => Promise.reject(errnoError('EIO'))).catch(() => undefined);

    expect(manager.state).toBe('degraded');
    manager.stop();
  });

  it('does not degrade the mount for a permission error', async () => {
    // Wrong ACLs on one file say nothing about whether the server is reachable.
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke);
    await manager.mount();

    await manager.guard('op', () => Promise.reject(errnoError('EACCES'))).catch(() => undefined);

    expect(manager.state).toBe('healthy');
    manager.stop();
  });
});

// ---------------------------------------------------------------------------
// Manager: monitor + reconnect
// ---------------------------------------------------------------------------

describe('CifsMountManager monitor', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('remounts automatically after the backoff once the server returns', async () => {
    jest.useFakeTimers();
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke, { probeIntervalMs: 10 });

    await manager.mount();
    manager.start();

    // Server disappears; three probe ticks take the mount offline.
    fs.statError = errnoError('EIO');
    for (let i = 0; i < 3; i += 1) {
      await jest.advanceTimersByTimeAsync(10);
    }
    expect(manager.state).toBe('offline');

    // Server returns while the bridge is waiting out the first 15 s backoff.
    fs.statError = undefined;
    fs.unmount();
    await jest.advanceTimersByTimeAsync(backoffDelayMs(0, 0.5) + 10);

    expect(manager.state).toBe('healthy');
    manager.stop();
  });

  it('keeps retrying on a longer delay when the remount fails', async () => {
    jest.useFakeTimers();
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke, { probeIntervalMs: 10 });

    await manager.mount();
    manager.start();

    fs.statError = errnoError('EIO');
    for (let i = 0; i < 3; i += 1) {
      await jest.advanceTimersByTimeAsync(10);
    }
    expect(manager.state).toBe('offline');

    // First attempt fails — the server is still down.
    await jest.advanceTimersByTimeAsync(backoffDelayMs(0, 0.5) + 10);
    expect(manager.state).toBe('offline');

    // Second attempt lands on the longer step and succeeds.
    fs.statError = undefined;
    await jest.advanceTimersByTimeAsync(backoffDelayMs(1, 0.5) + 10);
    expect(manager.state).toBe('healthy');

    manager.stop();
  });

  it('stops cleanly, leaving no timers behind', async () => {
    jest.useFakeTimers();
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke, { probeIntervalMs: 10 });

    await manager.mount();
    manager.start();
    await jest.advanceTimersByTimeAsync(10);
    manager.stop();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('is idempotent across repeated start and stop calls', async () => {
    jest.useFakeTimers();
    const fs = new FakeFs(true);
    const { invoke } = makeInvoker(fs);
    const manager = makeManager(fs, invoke, { probeIntervalMs: 10 });
    await manager.mount();

    manager.start();
    manager.start();
    await jest.advanceTimersByTimeAsync(10);
    manager.stop();
    manager.stop();

    expect(jest.getTimerCount()).toBe(0);
  });
});
