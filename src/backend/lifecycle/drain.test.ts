import { DrainRegistry, RegistryClosedError } from './drain';

/**
 * The drain is what makes "SIGTERM during a transfer leaves no `.tnc-tmp-*` file and no
 * orphaned lock" true. These tests model the transfer lifecycle directly: begin, write,
 * rename, done — and assert that shutdown waits for the rename.
 */

describe('tracking in-flight work', () => {
  it('counts operations between begin and done', () => {
    const registry = new DrainRegistry();
    expect(registry.inflight).toBe(0);

    const handle = registry.begin('transfer werkstatt/1234.H');
    expect(registry.inflight).toBe(1);
    expect(registry.labels).toEqual(['transfer werkstatt/1234.H']);

    handle.done();
    expect(registry.inflight).toBe(0);
  });

  it('gives each operation a distinct id', () => {
    const registry = new DrainRegistry();
    expect(registry.begin('a').id).not.toBe(registry.begin('b').id);
  });

  it('stamps the start time so a stuck operation can be identified', () => {
    const registry = new DrainRegistry({ now: () => 1_700_000_000_000 });
    expect(registry.begin('a').startedAt).toBe(1_700_000_000_000);
  });

  /** A double `done()` would drop the count below reality and release the drain early. */
  it('ignores a repeated done', () => {
    const registry = new DrainRegistry();
    const a = registry.begin('a');
    registry.begin('b');
    a.done();
    a.done();
    expect(registry.inflight).toBe(1);
  });

  it('releases the operation even when the tracked work throws', async () => {
    const registry = new DrainRegistry();
    await expect(
      registry.track('failing transfer', () => Promise.reject(new Error('EIO'))),
    ).rejects.toThrow('EIO');
    expect(registry.inflight).toBe(0);
  });

  it('returns the tracked value', async () => {
    const registry = new DrainRegistry();
    expect(await registry.track('hash', () => Promise.resolve('abc'))).toBe('abc');
    expect(registry.inflight).toBe(0);
  });
});

describe('draining', () => {
  it('returns immediately when nothing is running', async () => {
    const registry = new DrainRegistry();
    expect(await registry.drain(1000)).toMatchObject({ drained: true, remaining: [] });
  });

  /** The core case: shutdown waits for a transfer to reach its rename. */
  it('waits for an in-flight operation to finish', async () => {
    const registry = new DrainRegistry();
    const handle = registry.begin('transfer werkstatt/1234.H');

    let resolved = false;
    const draining = registry.drain(1000).then((result) => {
      resolved = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);

    handle.done();
    expect(await draining).toMatchObject({ drained: true, remaining: [] });
  });

  it('waits for every operation, not just the first', async () => {
    const registry = new DrainRegistry();
    const a = registry.begin('a');
    const b = registry.begin('b');

    const draining = registry.drain(1000);
    a.done();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registry.inflight).toBe(1);

    b.done();
    expect(await draining).toMatchObject({ drained: true });
  });

  /**
   * systemd will SIGKILL at `TimeoutStopSec`. Draining must give up before that so the
   * cancellation path still has a live process to run in.
   */
  it('gives up at the deadline and reports what is still running', async () => {
    const registry = new DrainRegistry();
    registry.begin('transfer werkstatt/big.H');

    const result = await registry.drain(20);
    expect(result.drained).toBe(false);
    expect(result.remaining).toEqual(['transfer werkstatt/big.H']);
  });

  it('reports how long it waited', async () => {
    let clock = 0;
    const registry = new DrainRegistry({ now: () => clock });
    registry.begin('a');
    const draining = registry.drain(20);
    clock = 25;
    expect((await draining).waitedMs).toBe(25);
  });

  it('logs the wait and the give-up', async () => {
    const lines: string[] = [];
    const registry = new DrainRegistry({
      logger: { info: (m) => lines.push(`info:${m}`), warn: (m) => lines.push(`warn:${m}`) },
    });
    registry.begin('a');
    await registry.drain(10);
    expect(lines).toEqual([
      'info:waiting for in-flight operations',
      'warn:drain deadline passed with work still running',
    ]);
  });
});

describe('refusing new work once shutting down', () => {
  /**
   * Starting a transfer during shutdown would create precisely the temp file this class
   * exists to prevent, so the refusal is an exception rather than a silent no-op.
   */
  it('rejects begin after draining has started', async () => {
    const registry = new DrainRegistry();
    await registry.drain(10);
    expect(() => registry.begin('late transfer')).toThrow(RegistryClosedError);
    expect(() => registry.begin('late transfer')).toThrow(/shutting down/);
  });

  it('marks the registry as closing', async () => {
    const registry = new DrainRegistry();
    expect(registry.isClosing).toBe(false);
    await registry.drain(10);
    expect(registry.isClosing).toBe(true);
  });

  /** Long operations poll this so they can wind up early rather than be killed. */
  it('signals cancellation to operations already running', async () => {
    const registry = new DrainRegistry();
    const handle = registry.begin('long scan');
    expect(handle.cancelled).toBe(false);

    const draining = registry.drain(20);
    expect(handle.cancelled).toBe(true);

    handle.done();
    await draining;
  });

  it('rejects tracked work after closing too', async () => {
    const registry = new DrainRegistry();
    await registry.drain(10);
    await expect(registry.track('late', () => Promise.resolve())).rejects.toThrow(
      RegistryClosedError,
    );
  });

  it('reopens on reset, for --check and tests', async () => {
    const registry = new DrainRegistry();
    registry.begin('a');
    await registry.drain(10);
    registry.reset();
    expect(registry.isClosing).toBe(false);
    expect(registry.inflight).toBe(0);
    expect(() => registry.begin('b')).not.toThrow();
  });
});
