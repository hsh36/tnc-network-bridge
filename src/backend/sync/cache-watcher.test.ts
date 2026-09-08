import { EventEmitter } from 'node:events';
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FSWatcher, type WatchOptions } from 'chokidar';
import {
  CacheWatcher,
  DEFAULT_STABILITY_THRESHOLD_MS,
  INOTIFY_LIMIT_REMEDIATION,
  type DegradedEvent,
  type WatchEvent,
  type WatchFailure,
  type WatcherFactory,
} from './cache-watcher';
import { EchoGuard } from './echo-guard';

/**
 * T17 acceptance tests.
 *
 * These run against real chokidar and a real directory, not a mock. A mocked watcher
 * would prove that this module reacts correctly to events *it was told to expect*, which
 * is not the risky part — the risky part is whether `awaitWriteFinish` actually suppresses
 * a partial write and whether a rename actually arrives as unlink-then-add. Both are
 * properties of chokidar and the kernel, and only a real file makes them true or false.
 *
 * Timings are compressed everywhere except the 10 MB test, which uses the real 750 ms
 * threshold precisely because that number is the acceptance criterion.
 */

let root: string;
let watcher: CacheWatcher | null = null;
let events: WatchEvent[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tnc-watch-'));
  events = [];
});

afterEach(async () => {
  await watcher?.stop();
  watcher = null;
  rmSync(root, { recursive: true, force: true });
});

/** Fast timings, for every test whose subject is not the stability threshold itself. */
const start = async (options: Partial<ConstructorParameters<typeof CacheWatcher>[0]> = {}) => {
  const created = new CacheWatcher({
    shareId: 1,
    root,
    stabilityThresholdMs: 60,
    debounceMs: 30,
    renameWindowMs: 400,
    rootCheckMs: 40,
    ...options,
  });
  watcher = created;
  created.on('file', (event: WatchEvent) => events.push(event));
  await created.start();
  return created;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Waits until `predicate` holds, or fails the test by timing out. */
const until = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`condition not met within ${timeoutMs} ms; saw ${JSON.stringify(events)}`);
};

const write = (relPath: string, content: string): void => {
  const absolute = join(root, relPath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
};

const typesOf = (): string[] => events.map((event) => event.type);

// ---------------------------------------------------------------------------

describe('basic change reporting', () => {
  it('reports a new file once it has settled', async () => {
    await start();

    write('part1.h', 'BEGIN PGM');
    await until(() => events.length > 0);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'added',
      relPath: 'part1.h',
      from: null,
      size: 9,
    });
    expect(events[0]?.mtimeMs).toBeGreaterThan(0);
  });

  it('does not replay the existing tree at startup', async () => {
    write('already-here.h', 'x');

    await start();
    await sleep(200);

    // Replaying the cache as additions would queue a full resync of the share on every
    // service restart. The scanner has already inventoried both sides.
    expect(events).toEqual([]);
  });

  it('reports a modification as a change, not an addition', async () => {
    write('part1.h', 'one');
    await start();

    write('part1.h', 'two longer');
    await until(() => events.length > 0);

    expect(events[0]).toMatchObject({ type: 'changed', relPath: 'part1.h' });
  });

  it('reports every successive edit of the same file', async () => {
    await start();

    // Regression: a write in place keeps the inode, so an inode-based "have I already seen
    // this?" check answers "unchanged" for a file that was genuinely just edited. Only the
    // first edit of a given file would survive it, and the operator would see the first
    // save of a program sync and every save after it silently vanish — which is precisely
    // the failure a bridge must not have.
    write('part1.h', 'first');
    await until(() => events.length >= 1);

    write('part1.h', 'second revision');
    await until(() => events.length >= 2);

    write('part1.h', 'third revision, longer still');
    await until(() => events.length >= 3);

    expect(typesOf()).toEqual(['added', 'changed', 'changed']);
    expect(events.map((event) => event.size)).toEqual([5, 15, 28]);
  }, 20_000);

  it('uses POSIX-shaped relative paths in nested directories', async () => {
    await start();

    write('programs/sub/part1.h', 'x');
    await until(() => events.some((event) => event.type === 'added'));

    const added = events.find((event) => event.type === 'added');
    expect(added?.relPath).toBe('programs/sub/part1.h');
  });

  it('reports directory creation and removal', async () => {
    await start();

    mkdirSync(join(root, 'newdir'));
    await until(() => typesOf().includes('dir-added'));

    rmSync(join(root, 'newdir'), { recursive: true });
    await until(() => typesOf().includes('dir-removed'));

    expect(events.map((event) => event.relPath)).toEqual(['newdir', 'newdir']);
  });

  it('honours exclude patterns against the relative path', async () => {
    await start({ excludes: ['*.tmp', 'scratch/**', '**/.tnc-tmp-*'] });

    write('ignored.tmp', 'x');
    write('scratch/also-ignored.h', 'x');
    write('.tnc-tmp-abc', 'x');
    write('kept.h', 'x');
    await until(() => events.length > 0);
    await sleep(200);

    // A bare `*.tmp` matching is the point: chokidar would test it against the absolute
    // path and never match, so this is checking our predicate, not chokidar's.
    expect(events.map((event) => event.relPath)).toEqual(['kept.h']);
  });
});

// ---------------------------------------------------------------------------

describe('half-written files (AC)', () => {
  /**
   * The criterion, at the real threshold: a slow 10 MB write fires exactly one event.
   *
   * The file is written over roughly a second and a half in 512 KB chunks, which is a
   * fair imitation of a TNC streaming a large program over SMB 1.0. Every one of those
   * chunks is an inotify event; the watcher must turn all of them into one, and must not
   * report the file while it is still growing.
   */
  it('fires exactly one event for a slow 10 MB write', async () => {
    await start({ stabilityThresholdMs: DEFAULT_STABILITY_THRESHOLD_MS, debounceMs: 100 });

    const target = join(root, 'big.h');
    const stream = createWriteStream(target);
    const chunk = Buffer.alloc(512 * 1024, 0x41);
    const chunks = 20;

    const sizesWhenReported: number[] = [];
    watcher?.on('file', (event: WatchEvent) => sizesWhenReported.push(event.size));

    for (let i = 0; i < chunks; i += 1) {
      await new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => (error != null ? reject(error) : resolve()));
      });
      await sleep(70);
    }
    await new Promise<void>((resolve) => stream.end(resolve));

    // Nothing may have been reported yet: the file was never quiet for 750 ms.
    expect(events).toEqual([]);

    await until(() => events.length > 0, 8_000);
    await sleep(1_200);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('added');
    // And it was reported at its full size — the whole point of waiting.
    expect(sizesWhenReported).toEqual([chunks * 512 * 1024]);
  }, 30_000);

  it('coalesces a burst of rapid writes into one event', async () => {
    await start();
    write('part1.h', 'first');
    await until(() => events.length > 0);
    events.length = 0;

    for (let i = 0; i < 10; i += 1) {
      write('part1.h', `content ${i} ${'x'.repeat(i)}`);
      await sleep(10);
    }

    await until(() => events.length > 0);
    await sleep(300);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('changed');
  }, 20_000);
});

// ---------------------------------------------------------------------------

describe('renames (AC)', () => {
  it('reports a rename as a rename, not a delete and a create', async () => {
    write('old-name.h', 'BEGIN PGM 1');
    await start();

    renameSync(join(root, 'old-name.h'), join(root, 'new-name.h'));
    await until(() => events.length > 0);
    await sleep(600);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'renamed',
      relPath: 'new-name.h',
      from: 'old-name.h',
    });
    // Neither half of the literal event pair may escape: a `removed` would tell the
    // other side to delete the file, and an `added` would re-upload bytes that never
    // changed over a link the throttle is deliberately keeping narrow.
    expect(typesOf()).not.toContain('removed');
    expect(typesOf()).not.toContain('added');
  }, 20_000);

  it('reports a rename into a subdirectory', async () => {
    mkdirSync(join(root, 'archive'));
    write('part1.h', 'BEGIN PGM 2');
    await start();

    renameSync(join(root, 'part1.h'), join(root, 'archive', 'part1.h'));
    await until(() => events.some((event) => event.type === 'renamed'));

    const renamed = events.find((event) => event.type === 'renamed');
    expect(renamed).toMatchObject({ relPath: 'archive/part1.h', from: 'part1.h' });
  }, 20_000);

  it('reports a real deletion once the rename window closes', async () => {
    write('doomed.h', 'x');
    await start();

    rmSync(join(root, 'doomed.h'));
    await until(() => events.length > 0);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'removed', relPath: 'doomed.h', size: 0 });
  }, 20_000);

  it('holds a deletion open only for the rename window', async () => {
    write('doomed.h', 'x');
    const started = await start({ renameWindowMs: 800 });

    rmSync(join(root, 'doomed.h'));
    await until(() => started.pendingRemovals.length > 0);

    // Visibly pending, and not yet reported: this is the state a rename resolves.
    expect(started.pendingRemovals).toEqual(['doomed.h']);
    expect(events).toEqual([]);

    await until(() => events.length > 0, 3_000);
    expect(events[0]?.type).toBe('removed');
    expect(started.pendingRemovals).toEqual([]);
  }, 20_000);
});

// ---------------------------------------------------------------------------

describe('the watch root disappearing (AC)', () => {
  it('survives deletion and recreation of the watched directory', async () => {
    write('before.h', 'x');
    const started = await start({ recreateRoot: false });

    const missing = new Promise<void>((resolve) => started.once('root-missing', () => resolve()));
    const restored = new Promise<void>((resolve) => started.once('root-restored', () => resolve()));

    rmSync(root, { recursive: true, force: true });
    await missing;

    mkdirSync(root, { recursive: true });
    await restored;

    // The real test of recovery: a file created in the *new* directory is noticed. An
    // inotify watch does not survive its inode, so without the restart the watcher
    // would sit here looking healthy and reporting nothing forever.
    events.length = 0;
    write('after.h', 'new program');
    await until(() => events.some((event) => event.relPath === 'after.h'), 8_000);

    expect(events.find((event) => event.relPath === 'after.h')?.type).toBe('added');
  }, 30_000);

  it('recreates the root itself when it owns it', async () => {
    const started = await start({ recreateRoot: true });
    const restored = new Promise<void>((resolve) => started.once('root-restored', () => resolve()));

    rmSync(root, { recursive: true, force: true });
    await restored;

    events.length = 0;
    write('after.h', 'x');
    await until(() => events.some((event) => event.relPath === 'after.h'), 8_000);
  }, 30_000);

  it('asks for a rescan after a restart, because the event stream had a gap', async () => {
    const started = await start();
    const reasons: string[] = [];
    started.on('rescan-required', (event: { reason: string }) => reasons.push(event.reason));

    rmSync(root, { recursive: true, force: true });
    await until(() => reasons.length > 0, 8_000);

    expect(reasons).toContain('root_restored');
  }, 30_000);

  it('does not re-announce files that came back unchanged', async () => {
    const started = await start({ recreateRoot: false });
    write('stable.h', 'unchanged bytes');
    await until(() => events.length > 0);
    events.length = 0;

    // The directory is moved aside and moved back rather than deleted and rebuilt, so the
    // files that return are byte-for-byte the ones that left — same inode, same mtime.
    // That is the real shape of this failure (a remount, a share that flapped), and the
    // only version of it in which "unchanged" is actually true.
    const away = `${root}-away`;
    const missing = new Promise<void>((resolve) => started.once('root-missing', () => resolve()));
    const restored = new Promise<void>((resolve) => started.once('root-restored', () => resolve()));

    renameSync(root, away);
    await missing;
    renameSync(away, root);
    await restored;
    await sleep(400);

    // The restart re-reads the tree with ignoreInitial: false, so chokidar announces every
    // file it finds. Identical ones must be filtered here, or every recovery would look
    // like a full share of modifications and queue a resync of all of it.
    expect(typesOf()).not.toContain('changed');
    expect(typesOf()).not.toContain('added');
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe('the inotify watch limit (AC)', () => {
  /** A watcher that reports whatever the test tells it to. */
  class FakeWatcher extends EventEmitter {
    closed = false;
    close(): Promise<void> {
      this.closed = true;
      return Promise.resolve();
    }
  }

  const fakeFactory = (): {
    factory: WatcherFactory;
    created: { watcher: FakeWatcher; options: WatchOptions }[];
  } => {
    const created: { watcher: FakeWatcher; options: WatchOptions }[] = [];
    const factory: WatcherFactory = (_root, options) => {
      const fake = new FakeWatcher();
      created.push({ watcher: fake, options });
      setImmediate(() => fake.emit('ready'));
      return fake as unknown as FSWatcher;
    };
    return { factory, created };
  };

  it('degrades to polling with an actionable message', async () => {
    const { factory, created } = fakeFactory();
    const started = await start({ watcherFactory: factory });

    const degradedEvents: DegradedEvent[] = [];
    started.on('degraded', (event: DegradedEvent) => degradedEvents.push(event));

    const enospc: NodeJS.ErrnoException = new Error('watch ENOSPC');
    enospc.code = 'ENOSPC';
    created[0]?.watcher.emit('error', enospc);

    await until(() => created.length > 1, 3_000);

    expect(degradedEvents).toHaveLength(1);
    expect(degradedEvents[0]?.reason).toBe('inotify_limit');
    // The remediation has to be in the message itself: the operator meets this as a
    // banner at the moment their files stopped syncing.
    expect(degradedEvents[0]?.message).toContain('fs.inotify.max_user_watches=524288');
    expect(degradedEvents[0]?.message).toBe(INOTIFY_LIMIT_REMEDIATION);

    // Still watching — by polling, which is the whole point of degrading rather than
    // failing. Dying here would leave the local side of the bridge blind.
    expect(started.isDegraded).toBe(true);
    expect(started.isWatching).toBe(true);
    expect(created[0]?.watcher.closed).toBe(true);
    expect(created[0]?.options.usePolling).toBe(false);
    expect(created[1]?.options.usePolling).toBe(true);
    expect(created[1]?.options.interval).toBeGreaterThan(0);
  }, 20_000);

  it('degrades only once, however many times the kernel complains', async () => {
    const { factory, created } = fakeFactory();
    const started = await start({ watcherFactory: factory });
    const degradedEvents: DegradedEvent[] = [];
    started.on('degraded', (event: DegradedEvent) => degradedEvents.push(event));

    const enospc: NodeJS.ErrnoException = new Error('watch ENOSPC');
    enospc.code = 'ENOSPC';
    created[0]?.watcher.emit('error', enospc);
    await until(() => created.length > 1, 3_000);
    created[1]?.watcher.emit('error', enospc);
    await sleep(200);

    expect(degradedEvents).toHaveLength(1);
    expect(created).toHaveLength(2);
  }, 20_000);

  it('reports other watcher errors without degrading', async () => {
    const { factory, created } = fakeFactory();
    const started = await start({ watcherFactory: factory });
    const failures: WatchFailure[] = [];
    started.on('watch-error', (failure: WatchFailure) => failures.push(failure));

    const eacces: NodeJS.ErrnoException = new Error('permission denied');
    eacces.code = 'EACCES';
    created[0]?.watcher.emit('error', eacces);
    await sleep(100);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe('EACCES');
    expect(started.isDegraded).toBe(false);
    // One unreadable subdirectory must not stop the watch on the other forty thousand.
    expect(started.isWatching).toBe(true);
  }, 20_000);

  it('does not kill the process when nobody is listening for a failure', async () => {
    const { factory, created } = fakeFactory();
    await start({ watcherFactory: factory });

    const error: NodeJS.ErrnoException = new Error('boom');
    error.code = 'EIO';

    // Node turns an unlistened `error` event into a fatal throw, which is why this
    // module's failure event is called `watch-error`.
    expect(() => created[0]?.watcher.emit('error', error)).not.toThrow();
  }, 20_000);
});

// ---------------------------------------------------------------------------

describe('echo suppression', () => {
  it('drops the events caused by the engine writing the file itself', async () => {
    const guard = new EchoGuard();
    await start({ echoGuard: guard });

    const target = join(root, 'pulled.h');
    writeFileSync(target, 'pulled from the server');
    // What the transfer executor does before every write: declare what it is about to
    // produce, so the resulting inotify event is recognised as our own.
    const { statSync } = await import('node:fs');
    const stats = statSync(target);
    guard.expect({ path: 'pulled.h', size: stats.size, mtimeMs: stats.mtimeMs });

    await sleep(400);

    expect(events).toEqual([]);
  }, 20_000);

  it('still reports a genuine edit while an expectation is live for another path', async () => {
    const guard = new EchoGuard();
    await start({ echoGuard: guard });
    guard.expect({ path: 'other.h', size: 5, mtimeMs: Date.now() });

    write('real-edit.h', 'a real change');
    await until(() => events.length > 0);

    expect(events[0]?.relPath).toBe('real-edit.h');
  }, 20_000);
});

// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('creates the root if it does not exist', async () => {
    const missing = join(root, 'not-yet');
    const created = new CacheWatcher({ shareId: 1, root: missing, rootCheckMs: 50 });
    watcher = created;

    await created.start();

    expect(created.isWatching).toBe(true);
  });

  it('is idempotent on start and stop', async () => {
    const started = await start();
    await started.start();
    await started.stop();
    await started.stop();

    expect(started.isWatching).toBe(false);
  });

  it('emits nothing after it has been stopped', async () => {
    const started = await start();
    write('before-stop.h', 'x');
    await until(() => events.length > 0);

    await started.stop();
    events.length = 0;

    write('after-stop.h', 'x');
    await sleep(400);

    expect(events).toEqual([]);
  }, 20_000);
});
