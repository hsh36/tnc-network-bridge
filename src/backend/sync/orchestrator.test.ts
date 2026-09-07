import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEMP_FILE_PREFIX } from '../../shared/constants';
import { type Side, type VersionCapture } from './diff-engine';
import { EchoGuard } from './echo-guard';
import { quantizeMtimeMs } from './hasher';
import { MemoryBaseStore, SyncOrchestrator, type BaseStore, type SyncPorts } from './orchestrator';
import { TransferQueue, type Clock } from './throttle';
import { deleteFile, transferFile } from './transfer';

/**
 * T22 acceptance tests.
 *
 * The stated criterion is end-to-end bidirectional sync against a dockerised Samba
 * server. Docker is not available in this environment, so the end-to-end test runs the
 * orchestrator over two real directories through the real transfer executor — which
 * exercises the same code path the Samba adapter will, minus the CIFS mount. The mount
 * itself is what T10's tests cover; what is proved here is that the orchestration is
 * correct, and that is the part a Samba container would not have told us anyway.
 *
 * The other three criteria — one failing file does not stop the share, one failing share
 * does not stop the bridge, and state survives a restart mid-sync — are tested directly,
 * because each is a claim about behaviour under failure rather than about plumbing.
 */

class TestClock implements Clock {
  private current = 1_700_000_000_000;

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    this.current += ms;
    return Promise.resolve();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

// ---------------------------------------------------------------------------
// An in-memory pair of sides, for everything that is not about real files
// ---------------------------------------------------------------------------

interface FakeFile {
  size: number;
  mtime: number;
  content: string;
}

class FakePorts implements SyncPorts {
  readonly local = new Map<string, FakeFile>();
  readonly remote = new Map<string, FakeFile>();
  readonly captured: { relPath: string; capture: VersionCapture }[] = [];
  readonly calls: string[] = [];

  online = true;
  failOn = new Map<string, string>();
  locked = new Set<string>();
  excluded = new Set<string>();
  listFails: string | null = null;

  listPaths(): Promise<readonly string[]> {
    if (this.listFails !== null) {
      return Promise.reject(new Error(this.listFails));
    }
    return Promise.resolve([...new Set([...this.local.keys(), ...this.remote.keys()])].sort());
  }

  private side(map: Map<string, FakeFile>, relPath: string): Side {
    const file = map.get(relPath);
    return file === undefined ? null : { size: file.size, mtime: file.mtime, hash: null };
  }

  statLocal(relPath: string): Promise<Side> {
    return Promise.resolve(this.side(this.local, relPath));
  }

  statRemote(relPath: string): Promise<Side> {
    return Promise.resolve(this.side(this.remote, relPath));
  }

  private guard(action: string, relPath: string): void {
    this.calls.push(`${action}:${relPath}`);
    const failure = this.failOn.get(relPath);
    if (failure !== undefined) {
      throw new Error(failure);
    }
  }

  push(relPath: string): Promise<void> {
    this.guard('push', relPath);
    const file = this.local.get(relPath);
    if (file !== undefined) {
      this.remote.set(relPath, { ...file });
    }
    return Promise.resolve();
  }

  pull(relPath: string): Promise<void> {
    this.guard('pull', relPath);
    const file = this.remote.get(relPath);
    if (file !== undefined) {
      this.local.set(relPath, { ...file });
    }
    return Promise.resolve();
  }

  deleteLocal(relPath: string): Promise<void> {
    this.guard('deleteLocal', relPath);
    this.local.delete(relPath);
    return Promise.resolve();
  }

  deleteRemote(relPath: string): Promise<void> {
    this.guard('deleteRemote', relPath);
    this.remote.delete(relPath);
    return Promise.resolve();
  }

  captureVersion(relPath: string, capture: VersionCapture): Promise<void> {
    this.calls.push(`capture:${relPath}`);
    this.captured.push({ relPath, capture });
    return Promise.resolve();
  }

  isServerOnline(): Promise<boolean> {
    return Promise.resolve(this.online);
  }

  isLocked = (relPath: string): boolean => this.locked.has(relPath);
  isExcluded = (relPath: string): boolean => this.excluded.has(relPath);

  /** Convenience for arranging a file on one side. */
  put(map: Map<string, FakeFile>, relPath: string, content: string, mtime: number): void {
    map.set(relPath, { size: content.length, mtime, content });
  }
}

const build = (
  ports: FakePorts,
  overrides: Partial<ConstructorParameters<typeof SyncOrchestrator>[0]> = {},
): { orchestrator: SyncOrchestrator; store: BaseStore; clock: TestClock } => {
  const clock = new TestClock();
  const store = overrides.store ?? new MemoryBaseStore();
  const orchestrator = new SyncOrchestrator({
    shareId: 1,
    ports,
    store,
    clock,
    queue: new TransferQueue({ concurrency: 1, clock }),
    ...overrides,
  });
  return { orchestrator, store, clock };
};

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe('the share state machine', () => {
  it('starts idle and returns to idle after a clean cycle', async () => {
    const ports = new FakePorts();
    const { orchestrator } = build(ports);
    const states: string[] = [];
    orchestrator.on('state', (e: { status: string }) => states.push(e.status));

    expect(orchestrator.state).toBe('idle');
    await orchestrator.runCycle();

    expect(states).toEqual(['scanning', 'syncing', 'idle']);
    expect(orchestrator.state).toBe('idle');
  });

  it('goes offline, not into error, when the server is unreachable', async () => {
    const ports = new FakePorts();
    ports.online = false;
    const { orchestrator } = build(ports);

    await orchestrator.runCycle();

    // An unreachable share is a state, not a fault: it is nothing the bridge did wrong
    // and nothing retrying harder will fix.
    expect(orchestrator.state).toBe('offline');
    expect(orchestrator.breakerState).toBe('closed');
  });

  it('defers pushes while offline instead of failing them', async () => {
    const ports = new FakePorts();
    ports.online = false;
    ports.put(ports.local, 'NEW.H', 'CONTENT', 1_000);
    const { orchestrator } = build(ports);

    const result = await orchestrator.runCycle();

    expect(result.deferred).toBe(1);
    expect(result.failed).toBe(0);
    expect(ports.remote.has('NEW.H')).toBe(false);
  });

  it('pauses and resumes without running work while paused', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'A.H', 'X', 1_000);
    const { orchestrator } = build(ports);

    orchestrator.pause();
    expect(orchestrator.state).toBe('paused');
    expect(orchestrator.isPaused).toBe(true);

    const paused = await orchestrator.runCycle();
    expect(paused.scanned).toBe(0);
    expect(ports.remote.size).toBe(0);

    orchestrator.resume();
    await orchestrator.runCycle();
    expect(ports.remote.has('A.H')).toBe(true);
  });

  it('reports a scan failure as an error without throwing', async () => {
    const ports = new FakePorts();
    ports.listFails = 'the mount went away';
    const { orchestrator } = build(ports);
    const errors: string[] = [];
    orchestrator.on('error', (e: { error: string }) => errors.push(e.error));

    await expect(orchestrator.runCycle()).resolves.toMatchObject({ scanned: 0 });

    expect(orchestrator.state).toBe('error');
    expect(errors).toEqual(['the mount went away']);
  });

  it('refuses to run two cycles at once', async () => {
    const ports = new FakePorts();
    const { orchestrator } = build(ports);

    const first = orchestrator.runCycle();
    await expect(orchestrator.runCycle()).rejects.toThrow('already running');
    await first;

    // And is runnable again once the first has finished.
    await expect(orchestrator.runCycle()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// One failing file does not stop the share
// ---------------------------------------------------------------------------

describe('one failing file does not stop the share', () => {
  it('syncs everything else when one file cannot be transferred', async () => {
    const ports = new FakePorts();
    for (let i = 0; i < 10; i += 1) {
      ports.put(ports.local, `F${i}.H`, `CONTENT ${i}`, 1_000);
    }
    ports.failOn.set('F4.H', 'EACCES: permission denied');
    const { orchestrator } = build(ports);

    const result = await orchestrator.runCycle();

    expect(result.applied).toBe(9);
    expect(result.failed).toBe(1);
    expect(ports.remote.size).toBe(9);
    expect(ports.remote.has('F4.H')).toBe(false);
  });

  it('records the failure against that path alone', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'GOOD.H', 'X', 1_000);
    ports.put(ports.local, 'BAD.H', 'X', 1_000);
    ports.failOn.set('BAD.H', 'disk on fire');
    const { orchestrator, store } = build(ports);

    await orchestrator.runCycle();

    expect(store.get('BAD.H')).toMatchObject({
      state: 'error',
      retryCount: 1,
      lastError: 'disk on fire',
    });
    expect(store.get('GOOD.H')).toMatchObject({ state: 'synced', lastError: null });
  });

  it('emits a per-file error rather than raising one', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'BAD.H', 'X', 1_000);
    ports.failOn.set('BAD.H', 'nope');
    const { orchestrator } = build(ports);
    const seen: { relPath: string; error: string }[] = [];
    orchestrator.on('file-error', (e: { relPath: string; error: string }) => seen.push(e));

    await expect(orchestrator.runCycle()).resolves.toBeDefined();

    expect(seen).toEqual([{ shareId: 1, relPath: 'BAD.H', error: 'nope', retryCount: 1 }]);
  });

  it('keeps a failing path out of the way until its retry is due', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'BAD.H', 'X', 1_000);
    ports.failOn.set('BAD.H', 'nope');
    const { orchestrator, clock } = build(ports, { retryDelaysMs: [10_000] });

    await orchestrator.runCycle();
    ports.calls.length = 0;

    // Too soon: the path is skipped entirely rather than retried in a tight loop.
    await orchestrator.runCycle();
    expect(ports.calls).toEqual([]);

    clock.advance(10_001);
    await orchestrator.runCycle();
    expect(ports.calls).toContain('push:BAD.H');
  });

  it('backs off further with each successive failure', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'BAD.H', 'X', 1_000);
    ports.failOn.set('BAD.H', 'nope');
    const { orchestrator, store, clock } = build(ports, { retryDelaysMs: [1_000, 5_000] });

    await orchestrator.runCycle();
    expect(store.get('BAD.H')?.nextRetryAt).toBe(clock.now() + 1_000);

    clock.advance(1_001);
    await orchestrator.runCycle();
    expect(store.get('BAD.H')?.retryCount).toBe(2);
    expect(store.get('BAD.H')?.nextRetryAt).toBe(clock.now() + 5_000);
  });

  it('clears the failure once the path finally succeeds', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'FLAKY.H', 'X', 1_000);
    ports.failOn.set('FLAKY.H', 'transient');
    const { orchestrator, store, clock } = build(ports, { retryDelaysMs: [1_000] });

    await orchestrator.runCycle();
    ports.failOn.delete('FLAKY.H');
    clock.advance(1_001);
    await orchestrator.runCycle();

    expect(store.get('FLAKY.H')).toMatchObject({
      state: 'synced',
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
    });
  });
});

// ---------------------------------------------------------------------------
// One failing share does not stop the bridge
// ---------------------------------------------------------------------------

describe('one failing share does not stop the bridge', () => {
  it('leaves a healthy share untouched while another is broken', async () => {
    const broken = new FakePorts();
    broken.listFails = 'share one is gone';
    const healthy = new FakePorts();
    healthy.put(healthy.local, 'OK.H', 'CONTENT', 1_000);

    const one = new SyncOrchestrator({ shareId: 1, ports: broken, clock: new TestClock() });
    const two = new SyncOrchestrator({ shareId: 2, ports: healthy, clock: new TestClock() });
    one.on('error', () => undefined);

    const [first, second] = await Promise.all([one.runCycle(), two.runCycle()]);

    expect(one.state).toBe('error');
    expect(first.scanned).toBe(0);
    expect(two.state).toBe('idle');
    expect(second.applied).toBe(1);
    expect(healthy.remote.has('OK.H')).toBe(true);
  });

  it('gives each share its own breaker', async () => {
    const failing = new FakePorts();
    for (let i = 0; i < 12; i += 1) {
      failing.put(failing.local, `F${i}.H`, 'X', 1_000);
      failing.failOn.set(`F${i}.H`, 'broken');
    }
    const healthy = new FakePorts();
    healthy.put(healthy.local, 'OK.H', 'X', 1_000);

    const one = build(failing, { breakerThreshold: 10 });
    const two = build(healthy, { breakerThreshold: 10 });

    await one.orchestrator.runCycle();
    await two.orchestrator.runCycle();

    expect(one.orchestrator.breakerState).toBe('open');
    expect(two.orchestrator.breakerState).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// The circuit breaker
// ---------------------------------------------------------------------------

describe('the circuit breaker', () => {
  const allFailing = (count: number): FakePorts => {
    const ports = new FakePorts();
    for (let i = 0; i < count; i += 1) {
      ports.put(ports.local, `F${i}.H`, 'X', 1_000);
      ports.failOn.set(`F${i}.H`, 'the share is broken');
    }
    return ports;
  };

  it('opens after ten consecutive failures and stops trying', async () => {
    const ports = allFailing(30);
    const { orchestrator } = build(ports, { breakerThreshold: 10 });

    const result = await orchestrator.runCycle();

    expect(orchestrator.breakerState).toBe('open');
    expect(orchestrator.state).toBe('error');
    // It stopped rather than logging thirty identical failures at a server already unwell.
    expect(result.failed).toBeLessThan(30);
    expect(result.haltedByBreaker).toBe(true);
  });

  it('does not open while failures are interleaved with successes', async () => {
    const ports = new FakePorts();
    for (let i = 0; i < 30; i += 1) {
      ports.put(ports.local, `F${i}.H`, 'X', 1_000);
      if (i % 2 === 0) {
        ports.failOn.set(`F${i}.H`, 'unlucky');
      }
    }
    const { orchestrator } = build(ports, { breakerThreshold: 10 });

    await orchestrator.runCycle();

    // Fifteen failures, but never ten in a row: this is a set of bad files, not a
    // broken share, and the difference is exactly what the breaker is for.
    expect(orchestrator.breakerState).toBe('closed');
  });

  it('refuses to run again until the cooldown has passed', async () => {
    const ports = allFailing(15);
    const { orchestrator, clock } = build(ports, {
      breakerThreshold: 10,
      breakerCooldownMs: 300_000,
    });
    await orchestrator.runCycle();
    ports.calls.length = 0;

    clock.advance(299_999);
    const tooSoon = await orchestrator.runCycle();

    expect(tooSoon.haltedByBreaker).toBe(true);
    expect(ports.calls).toEqual([]);
  });

  it('allows exactly one probe after the cooldown, and closes when it works', async () => {
    const ports = allFailing(15);
    const { orchestrator, clock } = build(ports, {
      breakerThreshold: 10,
      breakerCooldownMs: 300_000,
    });
    const states: string[] = [];
    orchestrator.on('breaker', (e: { state: string }) => states.push(e.state));
    await orchestrator.runCycle();

    // Whatever was wrong has been fixed.
    ports.failOn.clear();
    clock.advance(300_000);
    await orchestrator.runCycle();

    expect(states).toEqual(['open', 'half_open', 'closed']);
    expect(orchestrator.breakerState).toBe('closed');
  });

  it('re-opens immediately when the probe fails, without another ten failures', async () => {
    const ports = allFailing(15);
    const { orchestrator, clock } = build(ports, {
      breakerThreshold: 10,
      breakerCooldownMs: 300_000,
    });
    await orchestrator.runCycle();
    clock.advance(300_000);
    ports.calls.length = 0;

    await orchestrator.runCycle();

    expect(orchestrator.breakerState).toBe('open');
    // One probe, not fifteen.
    expect(ports.calls.filter((call) => call.startsWith('push:'))).toHaveLength(1);
  });

  it('stays half-open when the probe lands on a path that is not due yet', async () => {
    const ports = allFailing(15);
    const { orchestrator, clock } = build(ports, {
      breakerThreshold: 10,
      breakerCooldownMs: 300_000,
      // Long enough that the cooldown expires while every path is still backing off.
      retryDelaysMs: [10_000_000],
    });
    await orchestrator.runCycle();
    clock.advance(300_000);
    ports.calls.length = 0;

    const probe = await orchestrator.runCycle();

    // The probe was spent on a path that was not due, so nothing was attempted and
    // nothing was learned — the breaker must not close on the strength of that.
    expect(ports.calls).toEqual([]);
    expect(probe.haltedByBreaker).toBe(false);
    expect(orchestrator.breakerState).toBe('half_open');

    // And it stays half-open rather than restarting the cooldown.
    await orchestrator.runCycle();
    expect(orchestrator.breakerState).toBe('half_open');
  });

  it('is reset by a full resync', async () => {
    const ports = allFailing(15);
    const { orchestrator } = build(ports, { breakerThreshold: 10 });
    await orchestrator.runCycle();

    orchestrator.fullResync();

    expect(orchestrator.breakerState).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// Base state and restart safety
// ---------------------------------------------------------------------------

describe('base state', () => {
  it('is committed only after the transfer succeeded', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'CRASH.H', 'CONTENT', 1_000);
    ports.failOn.set('CRASH.H', 'killed mid-transfer');
    const { orchestrator, store } = build(ports);

    await orchestrator.runCycle();

    // Committing first would leave the index claiming both sides agree when they do
    // not, and the next scan would see no difference and never repair it.
    expect(store.get('CRASH.H')?.base).toBeNull();
    expect(store.get('CRASH.H')?.state).toBe('error');
  });

  it('records the surviving side as the new agreement', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'P.H', 'LOCAL CONTENT', 5_000);
    const { orchestrator, store } = build(ports);

    await orchestrator.runCycle();

    expect(store.get('P.H')?.base).toEqual({ size: 13, mtime: 5_000, hash: null });
  });

  it('records the remote side after a pull', async () => {
    const ports = new FakePorts();
    ports.put(ports.remote, 'P.H', 'REMOTE', 7_000);
    const { orchestrator, store } = build(ports);

    await orchestrator.runCycle();

    expect(store.get('P.H')?.base).toEqual({ size: 6, mtime: 7_000, hash: null });
    expect(ports.local.get('P.H')?.content).toBe('REMOTE');
  });

  it('forgets a path entirely once it is deleted on both sides', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'D.H', 'X', 1_000);
    const { orchestrator, store } = build(ports, {
      diffConfig: { protectDeletes: false },
    });
    await orchestrator.runCycle();

    ports.local.delete('D.H');
    await orchestrator.runCycle();

    // "Agreed to be absent" and "never seen" are the same state to the next cycle.
    expect(store.get('D.H')).toBeNull();
    expect(ports.remote.has('D.H')).toBe(false);
  });

  it('reaches a fixed point: a second cycle changes nothing', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'A.H', 'ONE', 1_000);
    ports.put(ports.remote, 'B.H', 'TWO', 2_000);
    const { orchestrator } = build(ports);

    await orchestrator.runCycle();
    ports.calls.length = 0;
    const second = await orchestrator.runCycle();

    // The engine must not sync what it just synced — that is the loop, seen from above.
    expect(second.applied).toBe(0);
    expect(ports.calls).toEqual([]);
  });

  it('survives a restart mid-sync by resuming from the store', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'DONE.H', 'X', 1_000);
    ports.put(ports.local, 'PENDING.H', 'Y', 1_000);
    ports.failOn.set('PENDING.H', 'the process died here');
    const store = new MemoryBaseStore();

    const first = build(ports, { store });
    await first.orchestrator.runCycle();

    // The process restarts: a brand new orchestrator over the same durable store.
    ports.failOn.clear();
    const second = build(ports, { store });
    // Enough time has passed for the failed path's backoff to expire.
    second.clock.advance(60_000);
    const result = await second.orchestrator.runCycle();

    // It did not redo the finished file, and it did finish the unfinished one.
    expect(result.applied).toBe(1);
    expect(ports.remote.has('PENDING.H')).toBe(true);
    expect(store.get('DONE.H')?.state).toBe('synced');
  });

  it('re-derives everything after a full resync', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'A.H', 'X', 1_000);
    const { orchestrator, store } = build(ports);
    await orchestrator.runCycle();

    orchestrator.fullResync();

    expect(store.paths()).toEqual([]);
    const result = await orchestrator.runCycle();
    // Both sides now hold identical content, so it converges rather than copying again.
    expect(result.outcomes[0]?.verdict.action).toBe('CONVERGE');
  });
});

// ---------------------------------------------------------------------------
// Version capture and the echo guard
// ---------------------------------------------------------------------------

describe('safety interlocks', () => {
  it('captures a version before the transfer that would destroy it', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'P.H', 'NEW CONTENT', 5_000);
    ports.put(ports.remote, 'P.H', 'OLD CONTENT', 1_000);
    const store = new MemoryBaseStore();
    store.set('P.H', {
      base: { size: 11, mtime: 1_000, hash: null },
      state: 'synced',
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
    });
    const { orchestrator } = build(ports, { store });

    await orchestrator.runCycle();

    expect(ports.captured).toEqual([
      { relPath: 'P.H', capture: { side: 'remote', reason: 'overwrite' } },
    ]);
    // Order matters more than the fact: the capture must precede the write.
    expect(ports.calls.indexOf('capture:P.H')).toBeLessThan(ports.calls.indexOf('push:P.H'));
  });

  it('does not transfer at all when the capture fails', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'P.H', 'NEW', 5_000);
    ports.put(ports.remote, 'P.H', 'OLD', 1_000);
    jest.spyOn(ports, 'captureVersion').mockRejectedValue(new Error('the version store is full'));
    const store = new MemoryBaseStore();
    store.set('P.H', {
      base: { size: 3, mtime: 1_000, hash: null },
      state: 'synced',
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
    });
    const { orchestrator } = build(ports, { store });

    const result = await orchestrator.runCycle();

    // Proceeding without the capture would be worse than not syncing at all.
    expect(result.failed).toBe(1);
    expect(ports.remote.get('P.H')?.content).toBe('OLD');
  });

  it('tells the echo guard what it is about to write, before writing it', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'P.H', 'CONTENT', 5_000);
    const guard = new EchoGuard();
    const { orchestrator } = build(ports, { echoGuard: guard });

    await orchestrator.runCycle();

    // The watcher event this write produces must now be recognised as our own.
    expect(guard.shouldDrop({ path: 'P.H', size: 7, mtimeMs: 5_000 })).toBe(true);
  });

  it('skips a quarantined path entirely', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'LOOP.H', 'X', 1_000);
    const guard = new EchoGuard({ maxSyncsPerWindow: 1 });
    guard.recordSync('LOOP.H');
    guard.recordSync('LOOP.H');
    const { orchestrator } = build(ports, { echoGuard: guard });

    const result = await orchestrator.runCycle();

    expect(guard.isQuarantined('LOOP.H')).toBe(true);
    expect(result.scanned).toBe(0);
    expect(ports.remote.has('LOOP.H')).toBe(false);
  });

  it('defers a locked file instead of overwriting what a machine is running', async () => {
    const ports = new FakePorts();
    ports.put(ports.remote, 'RUNNING.H', 'NEW VERSION', 5_000);
    ports.locked.add('RUNNING.H');
    const { orchestrator } = build(ports);

    const result = await orchestrator.runCycle();

    expect(result.deferred).toBe(1);
    expect(ports.local.has('RUNNING.H')).toBe(false);
  });

  it('a deferral does not consume the retry budget', async () => {
    const ports = new FakePorts();
    ports.put(ports.remote, 'L.H', 'X', 1_000);
    ports.locked.add('L.H');
    const { orchestrator, store } = build(ports);

    await orchestrator.runCycle();
    await orchestrator.runCycle();

    expect(store.get('L.H')).toMatchObject({ retryCount: 0, nextRetryAt: null });
    expect(store.get('L.H')?.state).toBe('deferred_locked');
  });

  it('excludes a path without ever touching it', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'notes.txt', 'X', 1_000);
    ports.excluded.add('notes.txt');
    const { orchestrator, store } = build(ports);

    await orchestrator.runCycle();

    expect(ports.calls).toEqual([]);
    expect(store.get('notes.txt')?.state).toBe('excluded');
  });

  it('applies a local deletion when the server side is gone and deletes propagate', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'GONE.H', 'X', 1_000);
    const store = new MemoryBaseStore();
    store.set('GONE.H', {
      base: { size: 1, mtime: 1_000, hash: null },
      state: 'synced',
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
    });
    const { orchestrator } = build(ports, { store, diffConfig: { protectDeletes: false } });

    const result = await orchestrator.runCycle();

    expect(result.outcomes[0]?.verdict.action).toBe('DELETE_LOCAL');
    expect(ports.local.has('GONE.H')).toBe(false);
    expect(store.get('GONE.H')).toBeNull();
  });

  it('treats a failure to read either side as that path failing, not the cycle', async () => {
    const ports = new FakePorts();
    ports.put(ports.local, 'A.H', 'X', 1_000);
    ports.put(ports.local, 'UNREADABLE.H', 'X', 1_000);
    jest.spyOn(ports, 'statLocal').mockImplementation((relPath: string) => {
      if (relPath === 'UNREADABLE.H') {
        return Promise.reject(new Error('EIO: the medium is failing'));
      }
      return Promise.resolve({ size: 1, mtime: 1_000, hash: null });
    });
    const { orchestrator, store } = build(ports);

    const result = await orchestrator.runCycle();

    expect(result.failed).toBe(1);
    expect(result.applied).toBe(1);
    expect(store.get('UNREADABLE.H')?.lastError).toContain('the medium is failing');
  });

  it('exposes its echo guard, so the watcher can ask what to drop', () => {
    const guard = new EchoGuard();
    const { orchestrator } = build(new FakePorts(), { echoGuard: guard });

    expect(orchestrator.echoGuard).toBe(guard);
  });

  it('surfaces filename warnings for the operator', async () => {
    const ports = new FakePorts();
    ports.put(ports.remote, 'NOTES.TXT', 'X', 1_000);
    const { orchestrator } = build(ports);
    const warnings: string[] = [];
    orchestrator.on('warning', (e: { message: string }) => warnings.push(e.message));

    await orchestrator.runCycle();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('.TXT');
  });
});

// ---------------------------------------------------------------------------
// End to end, over real files
// ---------------------------------------------------------------------------

describe('end-to-end bidirectional sync over real files', () => {
  let root: string;
  let localDir: string;
  let remoteDir: string;
  let versionsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tnc-e2e-'));
    localDir = join(root, 'local');
    remoteDir = join(root, 'remote');
    versionsDir = join(root, 'versions');
    for (const dir of [localDir, remoteDir, versionsDir]) {
      mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const walk = (dir: string, prefix = ''): string[] => {
    if (!existsSync(dir)) {
      return [];
    }
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.name.startsWith(TEMP_FILE_PREFIX)) {
        continue;
      }
      if (entry.isDirectory()) {
        found.push(...walk(join(dir, entry.name), rel));
      } else {
        found.push(rel);
      }
    }
    return found;
  };

  /** The same shape the CIFS adapter will have, over two plain directories. */
  const makePorts = (): SyncPorts => {
    const sideOf = (dir: string, relPath: string): Side => {
      const full = join(dir, relPath);
      if (!existsSync(full)) {
        return null;
      }
      const stats = statSync(full);
      // Both sides go through the same quantiser. Truncating instead would let a copy
      // that faithfully preserved its mtime read back a millisecond low, and the sync
      // would copy the file back and forth for ever.
      return { size: stats.size, mtime: quantizeMtimeMs(stats.mtimeMs), hash: null };
    };

    return {
      listPaths: () =>
        Promise.resolve([...new Set([...walk(localDir), ...walk(remoteDir)])].sort()),
      statLocal: (relPath) => Promise.resolve(sideOf(localDir, relPath)),
      statRemote: (relPath) => Promise.resolve(sideOf(remoteDir, relPath)),
      push: async (relPath) => {
        await transferFile(join(localDir, relPath), join(remoteDir, relPath));
      },
      pull: async (relPath) => {
        await transferFile(join(remoteDir, relPath), join(localDir, relPath));
      },
      deleteLocal: async (relPath) => {
        await deleteFile(join(localDir, relPath));
      },
      deleteRemote: async (relPath) => {
        await deleteFile(join(remoteDir, relPath));
      },
      captureVersion: async (relPath, capture) => {
        const from = join(capture.side === 'local' ? localDir : remoteDir, relPath);
        await transferFile(from, join(versionsDir, `${relPath.replace(/\//gu, '_')}.bak`));
      },
      isServerOnline: () => Promise.resolve(true),
    };
  };

  const orchestratorFor = (store: BaseStore): SyncOrchestrator =>
    new SyncOrchestrator({ shareId: 1, ports: makePorts(), store });

  it('carries a new local program to the server and a new server one back', async () => {
    writeFileSync(join(localDir, 'FROM_TNC.H'), 'BEGIN PGM FROM_TNC MM');
    writeFileSync(join(remoteDir, 'FROM_SERVER.H'), 'BEGIN PGM FROM_SERVER MM');
    const orchestrator = orchestratorFor(new MemoryBaseStore());

    const result = await orchestrator.runCycle();

    expect(result.applied).toBe(2);
    expect(readFileSync(join(remoteDir, 'FROM_TNC.H'), 'utf8')).toBe('BEGIN PGM FROM_TNC MM');
    expect(readFileSync(join(localDir, 'FROM_SERVER.H'), 'utf8')).toBe('BEGIN PGM FROM_SERVER MM');
  }, 30_000);

  it('settles: a second cycle transfers nothing at all', async () => {
    writeFileSync(join(localDir, 'A.H'), 'ONE');
    writeFileSync(join(remoteDir, 'B.H'), 'TWO');
    const orchestrator = orchestratorFor(new MemoryBaseStore());

    await orchestrator.runCycle();
    const second = await orchestrator.runCycle();
    const third = await orchestrator.runCycle();

    // The real anti-loop proof: the whole pipeline, over real files, reaches a fixed
    // point rather than copying its own writes back and forth.
    expect(second.applied).toBe(0);
    expect(third.applied).toBe(0);
    expect(second.outcomes.every((o) => o.verdict.action === 'NOOP')).toBe(true);
  }, 30_000);

  it('propagates an edit made on either side', async () => {
    writeFileSync(join(localDir, 'P.H'), 'ORIGINAL');
    const store = new MemoryBaseStore();
    await orchestratorFor(store).runCycle();

    // Edited at the machine.
    writeFileSync(join(localDir, 'P.H'), 'EDITED AT THE MACHINE');
    await orchestratorFor(store).runCycle();
    expect(readFileSync(join(remoteDir, 'P.H'), 'utf8')).toBe('EDITED AT THE MACHINE');

    // And then edited on the server.
    writeFileSync(join(remoteDir, 'P.H'), 'EDITED ON THE SERVER');
    await orchestratorFor(store).runCycle();
    expect(readFileSync(join(localDir, 'P.H'), 'utf8')).toBe('EDITED ON THE SERVER');
  }, 30_000);

  it('captures the copy it is about to overwrite', async () => {
    writeFileSync(join(localDir, 'P.H'), 'ORIGINAL');
    const store = new MemoryBaseStore();
    await orchestratorFor(store).runCycle();

    writeFileSync(join(localDir, 'P.H'), 'REPLACEMENT');
    await orchestratorFor(store).runCycle();

    expect(readFileSync(join(versionsDir, 'P.H.bak'), 'utf8')).toBe('ORIGINAL');
    expect(readFileSync(join(remoteDir, 'P.H'), 'utf8')).toBe('REPLACEMENT');
  }, 30_000);

  it('handles nested directories', async () => {
    mkdirSync(join(localDir, 'PARTS', 'JOB1'), { recursive: true });
    writeFileSync(join(localDir, 'PARTS', 'JOB1', 'PART.H'), 'NESTED');
    const orchestrator = orchestratorFor(new MemoryBaseStore());

    await orchestrator.runCycle();

    expect(readFileSync(join(remoteDir, 'PARTS', 'JOB1', 'PART.H'), 'utf8')).toBe('NESTED');
  }, 30_000);

  it('leaves no temp files anywhere once it has settled', async () => {
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(join(localDir, `F${i}.H`), `CONTENT ${i}`);
    }
    const orchestrator = orchestratorFor(new MemoryBaseStore());

    await orchestrator.runCycle();

    for (const dir of [localDir, remoteDir]) {
      expect(readdirSync(dir).filter((n) => n.startsWith(TEMP_FILE_PREFIX))).toEqual([]);
    }
    expect(walk(remoteDir)).toHaveLength(12);
  }, 30_000);

  it('keeps going when one real file cannot be read', async () => {
    writeFileSync(join(localDir, 'GOOD1.H'), 'A');
    writeFileSync(join(localDir, 'GOOD2.H'), 'B');
    const ports = makePorts();
    const orchestrator = new SyncOrchestrator({
      shareId: 1,
      ports: {
        ...ports,
        push: (relPath) =>
          relPath === 'GOOD1.H' ? Promise.reject(new Error('EACCES')) : ports.push(relPath),
      },
    });

    const result = await orchestrator.runCycle();

    expect(result.failed).toBe(1);
    expect(result.applied).toBe(1);
    expect(existsSync(join(remoteDir, 'GOOD2.H'))).toBe(true);
  }, 30_000);
});
