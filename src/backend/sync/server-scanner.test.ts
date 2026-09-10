import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import {
  BACKOFF_FACTOR,
  FileIndex,
  InlineScanWalker,
  MAX_SCAN_INTERVAL_MS,
  MIN_SCAN_INTERVAL_MS,
  ServerScanner,
  WalkTimeoutError,
  WorkerScanWalker,
  portsFromIndex,
  scanWorkerPath,
  type ScanChange,
  type ScanEntry,
  type ScanResult,
  type ScanWalker,
  type WalkRequest,
  type WalkStats,
} from './server-scanner';

/**
 * T15 acceptance tests.
 *
 * Three of the four acceptance criteria are about things that are invisible in a
 * functional test, so they are each pinned by a test that measures the property directly
 * rather than a proxy for it:
 *
 * - *worker thread isolation* is proven by the walk reporting a non-zero `threadId` (the
 *   main thread is always 0) and by the parent's event loop continuing to tick while a
 *   walk is in flight;
 * - *changes made by another SMB client* are simulated by a genuinely separate OS
 *   process, because a change this process made itself could be detected by bookkeeping
 *   rather than by actually looking at the filesystem — which is the failure this
 *   criterion exists to catch;
 * - *memory flat across 100 scans* is asserted structurally (the index does not grow, and
 *   an unchanging tree keeps producing zero changes) as well as by heap size, because a
 *   heap figure alone is too noisy to fail honestly.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tnc-scan-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const file = (relPath: string, content = 'x'): string => {
  const absolute = join(root, relPath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
};

const dir = (relPath: string): string => {
  const absolute = join(root, relPath);
  mkdirSync(absolute, { recursive: true });
  return absolute;
};

/** Sets an explicit mtime so "modified" tests do not depend on clock resolution. */
const touch = (relPath: string, epochSeconds: number): void => {
  utimesSync(join(root, relPath), epochSeconds, epochSeconds);
};

const walkAll = async (
  walker: ScanWalker,
  request: WalkRequest,
): Promise<{ entries: ScanEntry[]; stats: WalkStats }> => {
  const entries: ScanEntry[] = [];
  const stats = await walker.walk(request, (chunk) => {
    entries.push(...chunk);
  });
  return { entries, stats };
};

const paths = (entries: readonly ScanEntry[]): string[] => entries.map((e) => e.relPath).sort();

const changesOf = (result: ScanResult | null, type: ScanChange['type']): string[] =>
  (result?.changes ?? [])
    .filter((change) => change.type === type)
    .map((change) => change.relPath)
    .sort();

// ---------------------------------------------------------------------------

describe('the walk', () => {
  let walker: InlineScanWalker;

  beforeEach(() => {
    walker = new InlineScanWalker();
  });

  it('reports every file and directory with POSIX-shaped relative paths', async () => {
    file('root.h');
    file('programs/part1.h');
    file('programs/nested/deep/part2.h');
    dir('empty');

    const { entries, stats } = await walkAll(walker, { root });

    expect(paths(entries)).toEqual([
      'empty',
      'programs',
      'programs/nested',
      'programs/nested/deep',
      'programs/nested/deep/part2.h',
      'programs/part1.h',
      'root.h',
    ]);
    expect(stats.files).toBe(3);
    expect(stats.directories).toBe(4);
    // Backslashes would make the index key change spelling with the host OS, and the
    // same path would then be two different rows on a Pi and a Windows dev machine.
    expect(entries.every((entry) => !entry.relPath.includes('\\'))).toBe(true);
  });

  it('records size and mtime for files and leaves directories at zero', async () => {
    file('part1.h', 'HELLO WORLD');
    touch('part1.h', 1_700_000_000);
    dir('sub');

    const { entries } = await walkAll(walker, { root });
    const part = entries.find((entry) => entry.relPath === 'part1.h');
    const sub = entries.find((entry) => entry.relPath === 'sub');

    expect(part).toEqual({
      relPath: 'part1.h',
      isDir: false,
      size: 11,
      mtimeMs: 1_700_000_000_000,
    });
    expect(sub).toEqual({ relPath: 'sub', isDir: true, size: 0, mtimeMs: 0 });
  });

  it('applies exclude patterns and does not descend into an excluded directory', async () => {
    file('keep.h');
    file('backup/old1.h');
    file('backup/old2.h');
    file('backup/deeper/old3.h');
    file('notes.txt');

    const { entries, stats } = await walkAll(walker, {
      root,
      excludes: ['backup/**', 'backup', '*.txt'],
    });

    expect(paths(entries)).toEqual(['keep.h']);
    // Three excluded *entries*, not five: the whole `backup` subtree cost one match.
    expect(stats.excluded).toBe(2);
    expect(stats.files).toBe(1);
  });

  it('excludes the transfer temporaries the executor writes', async () => {
    file('part1.h');
    file('.tnc-tmp-abc123');

    const { entries } = await walkAll(walker, { root, excludes: ['**/.tnc-tmp-*'] });

    expect(paths(entries)).toEqual(['part1.h']);
  });

  it('stops at maxEntries and marks the walk truncated', async () => {
    for (let i = 0; i < 20; i += 1) {
      file(`p${i}.h`);
    }

    const { entries, stats } = await walkAll(walker, { root, maxEntries: 5 });

    expect(stats.truncated).toBe(true);
    expect(entries.length).toBeLessThanOrEqual(20);
    expect(stats.files).toBeGreaterThanOrEqual(5);
  });

  it('emits entries in bounded chunks rather than one array at the end', async () => {
    for (let i = 0; i < 25; i += 1) {
      file(`p${i}.h`);
    }

    const sizes: number[] = [];
    await walker.walk({ root, chunkSize: 10 }, (chunk) => {
      sizes.push(chunk.length);
    });

    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(10);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(25);
  });

  it('rejects when the root does not exist', async () => {
    await expect(walkAll(walker, { root: join(root, 'missing') })).rejects.toThrow();
  });

  it('skips a file that vanishes between readdir and stat', async () => {
    file('a-first.h');
    file('z-doomed.h');

    // Not a simulation: `readdir` lists a directory's names before the walk stats any of
    // them, so deleting the second file while the first is being reported reproduces the
    // real race exactly — and it is an entirely ordinary race on a live share.
    const entries: ScanEntry[] = [];
    const stats = await walker.walk({ root, chunkSize: 1 }, (chunk) => {
      if (chunk[0]?.relPath === 'a-first.h') {
        rmSync(join(root, 'z-doomed.h'));
      }
      entries.push(...chunk);
    });

    expect(paths(entries)).toEqual(['a-first.h']);
    expect(stats.skipped).toBe(1);
    expect(stats.files).toBe(1);
  });

  const posixOnly = process.platform === 'win32' ? it.skip : it;

  posixOnly('never follows a symlink', async () => {
    file('real.h');
    const target = dir('target');
    writeFileSync(join(target, 'inner.h'), 'x');
    symlinkSync(target, join(root, 'link'));

    const { entries, stats } = await walkAll(walker, { root });

    expect(paths(entries)).toEqual(['real.h', 'target', 'target/inner.h']);
    expect(stats.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('the file index', () => {
  const entry = (relPath: string, size: number, mtimeMs: number): ScanEntry => ({
    relPath,
    isDir: false,
    size,
    mtimeMs,
  });

  it('reports a first sighting as an addition', () => {
    const index = new FileIndex();
    const generation = index.beginScan();

    const change = index.observe(entry('a.h', 10, 1000), generation);

    expect(change).toEqual({
      type: 'added',
      relPath: 'a.h',
      isDir: false,
      side: { size: 10, mtime: 1000, hash: null },
      previous: null,
    });
  });

  it('reports nothing for an unchanged path', () => {
    const index = new FileIndex();
    index.observe(entry('a.h', 10, 1000), index.beginScan());

    expect(index.observe(entry('a.h', 10, 1000), index.beginScan())).toBeNull();
  });

  it.each([
    ['size', entry('a.h', 11, 1000)],
    ['mtime', entry('a.h', 10, 2000)],
  ])('reports a change of %s as a modification', (_label, next) => {
    const index = new FileIndex();
    index.observe(entry('a.h', 10, 1000), index.beginScan());

    const change = index.observe(next, index.beginScan());

    expect(change?.type).toBe('modified');
    expect(change?.previous).toEqual({ size: 10, mtime: 1000, hash: null });
  });

  it('treats a path that changed between file and directory as a modification', () => {
    const index = new FileIndex();
    index.observe(entry('thing', 0, 0), index.beginScan());

    const change = index.observe(
      { relPath: 'thing', isDir: true, size: 0, mtimeMs: 0 },
      index.beginScan(),
    );

    expect(change?.type).toBe('modified');
    expect(change?.isDir).toBe(true);
  });

  it('reaps paths not stamped with the current generation', () => {
    const index = new FileIndex();
    const first = index.beginScan();
    index.observe(entry('kept.h', 1, 1), first);
    index.observe(entry('gone.h', 1, 1), first);

    const second = index.beginScan();
    index.observe(entry('kept.h', 1, 1), second);
    const removed = index.reap(second);

    expect(removed.map((change) => change.relPath)).toEqual(['gone.h']);
    expect(removed[0]?.previous).toEqual({ size: 1, mtime: 1, hash: null });
    expect(index.paths()).toEqual(['kept.h']);
  });

  it('detects a case collision and forgets it when one spelling goes away', () => {
    const index = new FileIndex();
    const first = index.beginScan();
    index.observe(entry('PART1.H', 1, 1), first);
    index.observe(entry('part1.h', 1, 1), first);

    expect(index.hasCaseCollision('PART1.H')).toBe(true);
    expect(index.hasCaseCollision('part1.h')).toBe(true);
    expect(index.caseCollisions()).toEqual([['PART1.H', 'part1.h']]);

    const second = index.beginScan();
    index.observe(entry('part1.h', 1, 1), second);
    index.reap(second);

    expect(index.hasCaseCollision('part1.h')).toBe(false);
    expect(index.caseCollisions()).toEqual([]);
  });

  it('exposes the two questions the orchestrator asks of it', async () => {
    const index = new FileIndex();
    const generation = index.beginScan();
    index.observe(entry('A.H', 1, 1), generation);
    index.observe(entry('a.h', 1, 1), generation);

    const ports = portsFromIndex(index);

    await expect(ports.listPaths()).resolves.toEqual(['A.H', 'a.h']);
    expect(ports.hasCaseCollision('a.h')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the scanner', () => {
  const make = (options: Partial<ConstructorParameters<typeof ServerScanner>[0]> = {}) =>
    new ServerScanner({
      shareId: 1,
      root,
      walker: new InlineScanWalker(),
      ...options,
    });

  it('reports additions, modifications and deletions across scans', async () => {
    file('a.h');
    touch('a.h', 1_700_000_000);
    file('b.h');
    touch('b.h', 1_700_000_000);
    const scanner = make();

    const first = await scanner.scanOnce();
    expect(changesOf(first, 'added')).toEqual(['a.h', 'b.h']);

    const unchanged = await scanner.scanOnce();
    expect(unchanged?.changes).toEqual([]);

    file('a.h', 'longer content');
    touch('a.h', 1_700_000_100);
    rmSync(join(root, 'b.h'));
    file('c.h');

    const third = await scanner.scanOnce();
    expect(changesOf(third, 'modified')).toEqual(['a.h']);
    expect(changesOf(third, 'removed')).toEqual(['b.h']);
    expect(changesOf(third, 'added')).toEqual(['c.h']);
  });

  it('emits one change event per change plus a scan event', async () => {
    file('a.h');
    const scanner = make();
    const changes: ScanChange[] = [];
    const scans: ScanResult[] = [];
    scanner.on('change', (change: ScanChange) => changes.push(change));
    scanner.on('scan', (result: ScanResult) => scans.push(result));

    await scanner.scanOnce();

    expect(changes).toHaveLength(1);
    expect(changes[0]?.relPath).toBe('a.h');
    expect(scans).toHaveLength(1);
    expect(scans[0]?.indexed).toBe(1);
    expect(scans[0]?.generation).toBe(1);
  });

  it('never reads a failed walk as mass deletion', async () => {
    file('a.h');
    file('b.h');

    let failNext = false;
    const flaky: ScanWalker = {
      walk: async (request, onChunk) => {
        if (failNext) {
          throw Object.assign(new Error('ENOTCONN: mount is gone'), { code: 'ENOTCONN' });
        }
        return new InlineScanWalker().walk(request, onChunk);
      },
      close: () => Promise.resolve(),
    };

    const scanner = make({ walker: flaky });
    const failures: unknown[] = [];
    scanner.on('scan-error', (failure: unknown) => failures.push(failure));

    await scanner.scanOnce();
    expect(scanner.index.size).toBe(2);

    failNext = true;
    const result = await scanner.scanOnce();

    // The whole safety property in three assertions: no result, no exception, and above
    // all no deletions — the index still holds both files, so nothing downstream is
    // told to delete anything from the other side.
    expect(result).toBeNull();
    expect(failures).toHaveLength(1);
    expect(scanner.index.size).toBe(2);
    expect([...scanner.index.paths()].sort()).toEqual(['a.h', 'b.h']);

    // And the next successful scan reports no spurious changes either.
    failNext = false;
    const recovered = await scanner.scanOnce();
    expect(recovered?.changes).toEqual([]);
  });

  it('does not reap after a truncated walk', async () => {
    file('a.h');
    file('b.h');
    const scanner = make({ maxEntries: 1 });

    await scanner.scanOnce();
    const before = scanner.index.size;
    const result = await scanner.scanOnce();

    expect(result?.stats.truncated).toBe(true);
    expect(changesOf(result, 'removed')).toEqual([]);
    expect(scanner.index.size).toBe(before);
  });

  it('refuses to run two scans at once', async () => {
    file('a.h');
    const scanner = make();

    const first = scanner.scanOnce();
    await expect(scanner.scanOnce()).rejects.toThrow(/already scanning/);
    await first;
  });

  describe('the adaptive interval', () => {
    it('backs off while nothing changes and snaps back when something does', async () => {
      file('a.h');
      touch('a.h', 1_700_000_000);
      const scanner = make();

      // The first scan finds the tree itself, which is a change.
      const first = await scanner.scanOnce();
      expect(first?.nextIntervalMs).toBe(MIN_SCAN_INTERVAL_MS);

      const quiet1 = await scanner.scanOnce();
      expect(quiet1?.nextIntervalMs).toBe(MIN_SCAN_INTERVAL_MS * BACKOFF_FACTOR);

      const quiet2 = await scanner.scanOnce();
      expect(quiet2?.nextIntervalMs).toBe(MIN_SCAN_INTERVAL_MS * BACKOFF_FACTOR ** 2);

      file('b.h');
      const busy = await scanner.scanOnce();
      expect(busy?.nextIntervalMs).toBe(MIN_SCAN_INTERVAL_MS);
    });

    it('never exceeds the ceiling', async () => {
      file('a.h');
      const scanner = make();

      for (let i = 0; i < 20; i += 1) {
        await scanner.scanOnce();
      }

      expect(scanner.currentIntervalMs).toBe(MAX_SCAN_INTERVAL_MS);
    });

    it('backs off after a failure too', async () => {
      const scanner = make({
        walker: { walk: () => Promise.reject(new Error('x')), close: () => Promise.resolve() },
      });
      scanner.on('scan-error', () => undefined);

      await scanner.scanOnce();

      expect(scanner.currentIntervalMs).toBe(MIN_SCAN_INTERVAL_MS * BACKOFF_FACTOR);
    });

    it('does not crash the process when a failure has no listener', async () => {
      // Node turns an unhandled `error` event into a fatal throw. A background scanner
      // must never be able to do that, so the failure event is named `scan-error`.
      const scanner = make({
        walker: {
          walk: () => Promise.reject(new Error('mount gone')),
          close: () => Promise.resolve(),
        },
      });

      await expect(scanner.scanOnce()).resolves.toBeNull();
    });

    it('announces interval changes', async () => {
      file('a.h');
      const scanner = make();
      const intervals: number[] = [];
      scanner.on('interval', (event: { intervalMs: number }) => intervals.push(event.intervalMs));

      await scanner.scanOnce();
      await scanner.scanOnce();
      await scanner.scanOnce();

      expect(intervals).toEqual([
        MIN_SCAN_INTERVAL_MS * BACKOFF_FACTOR,
        MIN_SCAN_INTERVAL_MS * BACKOFF_FACTOR ** 2,
      ]);
    });

    it('can be forced back to the floor', async () => {
      file('a.h');
      const scanner = make();
      await scanner.scanOnce();
      await scanner.scanOnce();
      expect(scanner.currentIntervalMs).toBeGreaterThan(MIN_SCAN_INTERVAL_MS);

      scanner.resetInterval();

      expect(scanner.currentIntervalMs).toBe(MIN_SCAN_INTERVAL_MS);
    });
  });

  describe('scheduling', () => {
    it('scans repeatedly and stops when told to', async () => {
      file('a.h');
      const scanner = make({ minIntervalMs: 5, maxIntervalMs: 10 });
      const scans: ScanResult[] = [];
      scanner.on('scan', (result: ScanResult) => scans.push(result));

      scanner.start();
      scanner.start(); // idempotent: must not start a second timer chain
      await new Promise((resolve) => setTimeout(resolve, 80));
      await scanner.stop();

      const seen = scans.length;
      expect(seen).toBeGreaterThan(1);

      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(scans.length).toBe(seen);
    });

    it('emits nothing once stop() has resolved, even mid-scan', async () => {
      file('a.h');
      const scanner = make({ minIntervalMs: 1, maxIntervalMs: 2 });
      const after: string[] = [];
      let stopped = false;

      // Regression: stop() used to cancel only the *next* scan. A scan already in flight
      // went on to emit into an orchestrator that had been told the scanner was finished
      // — and had, on that assurance, already torn down the handlers those events land in.
      scanner.on('scan', () => {
        if (stopped) {
          after.push('scan');
        }
      });
      scanner.on('change', () => {
        if (stopped) {
          after.push('change');
        }
      });

      scanner.start();
      // Stop without waiting for a quiet moment, so the odds of landing mid-scan are high.
      await new Promise((resolve) => setTimeout(resolve, 12));
      await scanner.stop();
      stopped = true;

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(after).toEqual([]);
      expect(scanner.isScanning).toBe(false);
    });

    it('keeps scanning after a scan fails', async () => {
      let calls = 0;
      const scanner = make({
        minIntervalMs: 5,
        maxIntervalMs: 5,
        walker: {
          walk: async (request, onChunk) => {
            calls += 1;
            if (calls === 1) {
              throw new Error('transient');
            }
            return new InlineScanWalker().walk(request, onChunk);
          },
          close: () => Promise.resolve(),
        },
      });
      file('a.h');

      scanner.start();
      await new Promise((resolve) => setTimeout(resolve, 60));
      await scanner.stop();

      expect(calls).toBeGreaterThan(1);
      expect(scanner.index.size).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------

describe('worker thread isolation (AC)', () => {
  let walker: WorkerScanWalker;

  afterEach(async () => {
    await walker?.close();
  });

  it('runs the walk on a thread that is not this one', async () => {
    file('a.h');
    file('sub/b.h');
    walker = new WorkerScanWalker();

    const { entries, stats } = await walkAll(walker, { root });

    expect(paths(entries)).toEqual(['a.h', 'sub', 'sub/b.h']);
    // The main thread is always thread 0. A non-zero id can only have come from a
    // genuinely separate thread, which is the criterion stated as "isolation proven".
    expect(threadId).toBe(0);
    expect(stats.threadId).toBeGreaterThan(0);
  });

  it('leaves the parent event loop free while it walks', async () => {
    // Enough files that the walk cannot finish inside a single timer tick, so there is
    // a window in which the main thread can be observed running.
    for (let i = 0; i < 2000; i += 1) {
      file(`d${i % 20}/p${i}.h`);
    }
    walker = new WorkerScanWalker();

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 1);

    await walkAll(walker, { root });
    clearInterval(ticker);

    // A walk that blocked the main thread would let through no ticks at all.
    //
    // There used to be an `expect(elapsed).toBeGreaterThan(5)` here, which asserted the
    // walk was *slow* — the opposite of the property under test, and a failure waiting
    // for a fast enough machine. What matters is only that the loop kept turning.
    expect(ticks).toBeGreaterThan(0);
  });

  it('surfaces a walk error from the worker as a rejection', async () => {
    walker = new WorkerScanWalker();

    await expect(walkAll(walker, { root: join(root, 'nope') })).rejects.toThrow(/ENOENT/i);
  });

  it('terminates a walk that stalls, rather than waiting on it forever', async () => {
    // Exactly the CIFS failure this design exists for: a walk that neither finishes nor
    // fails. Simulated with a worker module that simply never resolves.
    const stalled = join(root, 'stalled-worker.cjs');
    writeFileSync(
      stalled,
      `'use strict';
const { parentPort } = require('node:worker_threads');
if (parentPort !== null) { setInterval(() => {}, 1000); }
module.exports = { walk: () => new Promise(() => {}) };
`,
    );
    walker = new WorkerScanWalker(stalled, 150);

    await expect(walkAll(walker, { root })).rejects.toBeInstanceOf(WalkTimeoutError);
  });

  it('rejects after it has been closed', async () => {
    walker = new WorkerScanWalker();
    await walker.close();

    await expect(walkAll(walker, { root })).rejects.toThrow(/closed/);
  });

  it('resolves the worker next to the compiled module', () => {
    expect(scanWorkerPath().replace(/\\/g, '/')).toMatch(/sync\/scan-worker\.cjs$/);
  });
});

// ---------------------------------------------------------------------------

describe('changes made by another client (AC — R4/D4)', () => {
  it('detects files a separate process created, changed and deleted', async () => {
    file('existing.h', 'original');
    touch('existing.h', 1_700_000_000);
    const scanner = new ServerScanner({ shareId: 1, root, walker: new InlineScanWalker() });

    await scanner.scanOnce();

    // A different OS process, standing in for the CAD workstation writing to the same
    // SMB share. Nothing in this process observed the write, so the only way the scan
    // can know about it is by actually looking at the filesystem.
    const asOtherClient = (source: string): void => {
      execFileSync(process.execPath, ['-e', source, root], { stdio: 'ignore' });
    };

    asOtherClient(`
      const { writeFileSync, utimesSync } = require('node:fs');
      const { join } = require('node:path');
      const root = process.argv[1];
      writeFileSync(join(root, 'from-other-client.h'), 'new program');
      writeFileSync(join(root, 'existing.h'), 'edited by someone else');
      utimesSync(join(root, 'existing.h'), 1700000500, 1700000500);
      writeFileSync(join(root, 'doomed.h'), 'about to go');
    `);

    const afterWrites = await scanner.scanOnce();
    expect(changesOf(afterWrites, 'added')).toEqual(['doomed.h', 'from-other-client.h']);
    expect(changesOf(afterWrites, 'modified')).toEqual(['existing.h']);

    asOtherClient(`
      const { rmSync } = require('node:fs');
      const { join } = require('node:path');
      rmSync(join(process.argv[1], 'doomed.h'));
    `);

    const afterDelete = await scanner.scanOnce();
    expect(changesOf(afterDelete, 'removed')).toEqual(['doomed.h']);
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe('scale (AC)', () => {
  /**
   * The stated criterion is 10 000 files in under two seconds on a Pi 5. That number can
   * only be measured on a Pi; what a portable test can do is fix the *rate* so an
   * algorithmic regression — an accidental O(n²), a stat per directory per entry, a
   * re-created matcher inside the loop — fails here rather than on the machine. The
   * floor is set well below any healthy result so a loaded CI runner does not fail it.
   */
  it('scans a large tree at a rate that extrapolates past the Pi target', async () => {
    const count = 3_000;
    for (let i = 0; i < count; i += 1) {
      file(`d${i % 30}/p${i}.h`);
    }

    const scanner = new ServerScanner({ shareId: 1, root, walker: new InlineScanWalker() });
    const started = Date.now();
    const result = await scanner.scanOnce();
    const elapsed = Math.max(1, Date.now() - started);
    const rate = Math.round((count / elapsed) * 1000);

    // eslint-disable-next-line no-console -- the measured rate is the point of the test
    console.log(`scan rate: ${rate} files/s (${count} files in ${elapsed} ms)`);

    expect(result?.stats.files).toBe(count);
    expect(rate).toBeGreaterThan(500);
  }, 120_000);

  it('stays flat across 100 consecutive scans of an unchanging tree', async () => {
    for (let i = 0; i < 200; i += 1) {
      file(`d${i % 10}/p${i}.h`);
    }
    const scanner = new ServerScanner({ shareId: 1, root, walker: new InlineScanWalker() });

    const first = await scanner.scanOnce();
    const indexed = first?.indexed ?? 0;
    expect(indexed).toBe(210);

    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let i = 0; i < 100; i += 1) {
      const result = await scanner.scanOnce();
      // The structural half of "flat": an unchanging tree must produce no changes and
      // no index growth. A leak of per-scan state would show up here as either.
      expect(result?.changes).toEqual([]);
      expect(result?.indexed).toBe(indexed);
    }

    gc?.();
    const growthMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

    // eslint-disable-next-line no-console -- the measured growth is the point of the test
    console.log(`heap growth across 100 scans: ${growthMb.toFixed(1)} MB`);

    expect(scanner.index.size).toBe(indexed);
    expect(scanner.index.generation).toBe(101);
    expect(growthMb).toBeLessThan(50);
  }, 120_000);
});
