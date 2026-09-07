import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HASH_ALGORITHMS,
  HashService,
  hashStream,
  identityOf,
  sameIdentity,
  type FileIdentity,
} from './hasher';

/**
 * T16 acceptance tests.
 *
 * The reference vectors are checked two ways. SHA-256 is compared against `node:crypto`,
 * an independent implementation shipped with the runtime — if hash-wasm ever disagrees
 * with it, the version store is addressing blobs wrongly and a restore would return the
 * wrong program. xxHash64 has no implementation in the standard library, so it is checked
 * against the algorithm's published vectors instead.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tnc-hasher-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content: string | Buffer): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

/** Yields `total` bytes in chunks without ever holding more than one chunk. */
function* generate(total: number, chunk: number, fill = 0x41): Generator<Uint8Array> {
  const buffer = Buffer.alloc(chunk, fill);
  let sent = 0;
  while (sent < total) {
    const size = Math.min(chunk, total - sent);
    yield size === chunk ? buffer : buffer.subarray(0, size);
    sent += size;
  }
}

// ---------------------------------------------------------------------------
// Reference vectors
// ---------------------------------------------------------------------------

describe('reference vectors', () => {
  // The canonical xxHash64 vectors, seed 0.
  const XXHASH64: readonly [string, string][] = [
    ['', 'ef46db3751d8e999'],
    ['a', 'd24ec4f1a98c6e5b'],
    ['abc', '44bc2cf5ad770999'],
  ];

  it.each(XXHASH64)('xxhash64(%p) is %s', async (input, expected) => {
    const path = write('vector.bin', input);
    const service = new HashService();

    expect((await service.hashFile(path, 'xxhash64')).digest).toBe(expected);
  });

  it('produces a 16-character lowercase hex digest, as the schema requires', async () => {
    const service = new HashService();
    const digest = (await service.hashFile(write('a.H', 'CONTENT'), 'xxhash64')).digest;

    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('agrees with node:crypto on sha256, across sizes and chunk boundaries', async () => {
    const service = new HashService({ chunkSize: 1024 });

    for (const size of [0, 1, 1023, 1024, 1025, 70_000]) {
      const content = randomBytes(size);
      const path = write(`blob-${size}`, content);
      const expected = createHash('sha256').update(content).digest('hex');

      expect((await service.hashFile(path, 'sha256')).digest).toBe(expected);
    }
  });

  it('gives different digests to different content and equal ones to equal content', async () => {
    const service = new HashService();
    const first = await service.hashFile(write('one.H', 'BEGIN PGM ONE'), 'xxhash64');
    const second = await service.hashFile(write('two.H', 'BEGIN PGM TWO'), 'xxhash64');
    const copy = await service.hashFile(write('three.H', 'BEGIN PGM ONE'), 'xxhash64');

    expect(first.digest).not.toBe(second.digest);
    expect(copy.digest).toBe(first.digest);
  });

  it('defaults to xxhash64, the cheap change-detection hash', async () => {
    const service = new HashService();
    const result = await service.hashFile(write('d.H', 'x'));

    expect(result.algorithm).toBe('xxhash64');
  });

  it('never returns the same digest from the two algorithms', async () => {
    const service = new HashService();
    const path = write('both.H', 'SAME BYTES');
    const [cheap, cryptographic] = await Promise.all([
      service.hashFile(path, 'xxhash64'),
      service.hashFile(path, 'sha256'),
    ]);

    expect(cheap.digest).not.toBe(cryptographic.digest);
    expect(cryptographic.digest).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// Streaming and memory
// ---------------------------------------------------------------------------

describe('hashStream', () => {
  it('matches the one-shot digest when the input arrives in many chunks', async () => {
    const content = randomBytes(100_000);
    const expected = createHash('sha256').update(content).digest('hex');

    function* chunked(): Generator<Uint8Array> {
      for (let offset = 0; offset < content.length; offset += 997) {
        yield content.subarray(offset, offset + 997);
      }
    }

    expect((await hashStream(chunked(), 'sha256')).digest).toBe(expected);
  });

  it('reports the byte count it consumed', async () => {
    const { bytesRead } = await hashStream(generate(5_000, 512), 'xxhash64');

    expect(bytesRead).toBe(5_000);
  });

  it('hashes an empty source', async () => {
    const { digest, bytesRead } = await hashStream(generate(0, 512), 'xxhash64');

    expect(bytesRead).toBe(0);
    expect(digest).toBe('ef46db3751d8e999');
  });

  it('hashes 100 MB without retaining it', async () => {
    const total = 100 * 1024 * 1024;

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const { digest, bytesRead } = await hashStream(generate(total, 256 * 1024), 'xxhash64');
    global.gc?.();
    const after = process.memoryUsage().heapUsed;

    expect(bytesRead).toBe(total);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    // An implementation that buffered the input would have to hold 100 MB to do it. The
    // bound is generous precisely so this fails only on that, not on ordinary GC noise.
    expect(after - before).toBeLessThan(32 * 1024 * 1024);
  }, 60_000);

  it('hashes a large file from disk in bounded memory', async () => {
    const size = 8 * 1024 * 1024;
    const path = write('large.bin', Buffer.alloc(size, 0x5a));
    const service = new HashService({ chunkSize: 64 * 1024 });

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const result = await service.hashFile(path, 'sha256');
    global.gc?.();
    const after = process.memoryUsage().heapUsed;

    expect(result.bytesRead).toBe(size);
    expect(result.digest).toBe(createHash('sha256').update(Buffer.alloc(size, 0x5a)).digest('hex'));
    expect(after - before).toBeLessThan(size);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('identity', () => {
  const identity = (over: Partial<FileIdentity> = {}): FileIdentity => ({
    size: 10,
    mtimeMs: 1_000,
    dev: 2,
    ino: 3,
    ...over,
  });

  it('is drawn from a single stat', () => {
    const path = write('i.H', 'abc');
    const stats = statSync(path);
    const result = identityOf(stats);

    expect(result.size).toBe(3);
    expect(result.ino).toBe(stats.ino);
    expect(result.dev).toBe(stats.dev);
  });

  it('truncates sub-millisecond mtime noise', () => {
    expect(identityOf({ size: 1, mtimeMs: 1_000.75, dev: 1, ino: 1 }).mtimeMs).toBe(1_000);
  });

  it('treats identical tuples as the same file', () => {
    expect(sameIdentity(identity(), identity())).toBe(true);
  });

  it('treats any differing field as a different file', () => {
    expect(sameIdentity(identity(), identity({ size: 11 }))).toBe(false);
    expect(sameIdentity(identity(), identity({ mtimeMs: 1_001 }))).toBe(false);
    expect(sameIdentity(identity(), identity({ dev: 9 }))).toBe(false);
    // The one a (path, size, mtime) key would miss: same path, same size, same clock
    // tick, different inode. That is a file replaced by a rename.
    expect(sameIdentity(identity(), identity({ ino: 99 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe('caching', () => {
  it('a cache hit avoids re-reading the file', async () => {
    const service = new HashService();
    const path = write('cached.H', 'BEGIN PGM CACHED');

    const first = await service.hashFile(path, 'xxhash64');
    const second = await service.hashFile(path, 'xxhash64');

    expect(first.cached).toBe(false);
    expect(first.bytesRead).toBeGreaterThan(0);
    expect(second.cached).toBe(true);
    expect(second.bytesRead).toBe(0);
    expect(second.digest).toBe(first.digest);
    expect(service.stats).toMatchObject({ hits: 1, misses: 1, filesHashed: 1 });
  });

  it('re-reads when the content changes', async () => {
    const service = new HashService();
    const path = write('changing.H', 'ONE');
    const first = await service.hashFile(path, 'xxhash64');

    writeFileSync(path, 'TWO DIFFERENT');
    const second = await service.hashFile(path, 'xxhash64');

    expect(second.cached).toBe(false);
    expect(second.digest).not.toBe(first.digest);
  });

  it('re-reads when only the mtime moves, since content is what it cannot see', async () => {
    const service = new HashService();
    const path = write('touched.H', 'STABLE');
    await service.hashFile(path, 'xxhash64');

    const later = new Date(Date.now() + 10_000);
    utimesSync(path, later, later);
    const second = await service.hashFile(path, 'xxhash64');

    expect(second.cached).toBe(false);
    // Same bytes, so the digest is unchanged — the re-read was the honest cost of not
    // being able to tell without looking.
    expect(second.bytesRead).toBeGreaterThan(0);
  });

  it('keeps the two algorithms in separate caches', async () => {
    const service = new HashService();
    const path = write('two-algos.H', 'CONTENT');

    await service.hashFile(path, 'xxhash64');
    const sha = await service.hashFile(path, 'sha256');

    expect(sha.cached).toBe(false);
    expect((await service.hashFile(path, 'sha256')).cached).toBe(true);
    expect(service.stats.cacheEntries).toBe(2);
  });

  it('forgets a path on invalidate, in every algorithm', async () => {
    const service = new HashService();
    const path = write('inv.H', 'CONTENT');
    await service.hashFile(path, 'xxhash64');
    await service.hashFile(path, 'sha256');

    service.invalidate(path);

    expect(service.stats.cacheEntries).toBe(0);
    expect((await service.hashFile(path, 'xxhash64')).cached).toBe(false);
  });

  it('evicts the least recently used entry when full', async () => {
    const service = new HashService({ cacheSize: 2 });
    const a = write('a.H', 'A');
    const b = write('b.H', 'B');
    const c = write('c.H', 'C');

    await service.hashFile(a);
    await service.hashFile(b);
    // Touch `a` so `b` becomes the least recently used.
    await service.hashFile(a);
    await service.hashFile(c);

    expect(service.stats.cacheEntries).toBe(2);
    expect((await service.hashFile(a)).cached).toBe(true);
    expect((await service.hashFile(b)).cached).toBe(false);
  });

  it('clears the cache and the counters', async () => {
    const service = new HashService();
    await service.hashFile(write('cl.H', 'X'));

    service.clear();

    expect(service.stats).toEqual({
      hits: 0,
      misses: 0,
      bytesRead: 0,
      filesHashed: 0,
      cacheEntries: 0,
    });
  });

  it('counts the bytes it actually read', async () => {
    const service = new HashService();
    await service.hashFile(write('bytes.H', 'X'.repeat(500)));
    await service.hashFile(write('bytes2.H', 'Y'.repeat(300)));

    expect(service.stats.bytesRead).toBe(800);
  });
});

describe('hashIfChanged', () => {
  it('skips the read entirely when the caller already knows the identity', async () => {
    const service = new HashService();
    const path = write('known.H', 'BEGIN PGM KNOWN');
    const first = await service.hashFile(path);

    const again = await service.hashIfChanged(path, {
      identity: first.identity,
      digest: first.digest,
    });

    expect(again.cached).toBe(true);
    expect(again.bytesRead).toBe(0);
    expect(again.digest).toBe(first.digest);
    expect(service.stats.filesHashed).toBe(1);
  });

  it('hashes when the identity has moved on', async () => {
    const service = new HashService();
    const path = write('moved.H', 'ONE');
    const first = await service.hashFile(path);

    writeFileSync(path, 'SOMETHING ELSE ENTIRELY');
    const again = await service.hashIfChanged(path, {
      identity: first.identity,
      digest: first.digest,
    });

    expect(again.cached).toBe(false);
    expect(again.digest).not.toBe(first.digest);
  });

  it('hashes when there is no previous state at all', async () => {
    const service = new HashService();
    const result = await service.hashIfChanged(write('fresh.H', 'NEW'), null);

    expect(result.cached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrency and failure
// ---------------------------------------------------------------------------

describe('concurrency and failure', () => {
  it('hashes many files correctly under a concurrency limit', async () => {
    const service = new HashService({ concurrency: 2 });
    const paths = Array.from({ length: 25 }, (_, i) => write(`c${i}.H`, `CONTENT ${i}`));

    const results = await Promise.all(paths.map((path) => service.hashFile(path, 'sha256')));

    for (const [i, result] of results.entries()) {
      expect(result.digest).toBe(createHash('sha256').update(`CONTENT ${i}`).digest('hex'));
    }
    expect(service.stats.filesHashed).toBe(25);
  });

  it('rejects for a file that does not exist', async () => {
    const service = new HashService();

    await expect(service.hashFile(join(dir, 'absent.H'))).rejects.toThrow(/ENOENT/);
  });

  it('leaves no cache entry behind when the read fails', async () => {
    const service = new HashService();

    await expect(service.hashFile(join(dir, 'absent.H'))).rejects.toThrow();
    expect(service.stats.cacheEntries).toBe(0);
  });

  it('exposes exactly the algorithms it supports', () => {
    expect([...HASH_ALGORITHMS]).toEqual(['xxhash64', 'sha256']);
  });
});
