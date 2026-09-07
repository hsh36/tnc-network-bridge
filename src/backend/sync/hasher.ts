import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createSHA256, createXXHash64 } from 'hash-wasm';
import pLimit from 'p-limit';

/**
 * The hash service (T16).
 *
 * Two algorithms, for two jobs that look alike and are not:
 *
 * - **xxhash64** answers "did this file change?". It is not a cryptographic hash and is
 *   never used as one. It is roughly an order of magnitude faster than SHA-256, which is
 *   what makes it affordable to run over a whole share on a Pi.
 * - **sha256** addresses version blobs in the content-addressed store (§4). There the
 *   digest *is* the filename, so two different files colliding would silently serve the
 *   wrong program back during a restore. That is a cryptographic requirement, and
 *   xxhash64 must never be substituted for it.
 *
 * ## Why hashing is avoided rather than optimised
 *
 * Hashing costs a full read. On a share of 10 000 files that is the difference between a
 * scan that finishes and one that never does. So the engine's cheap `(size, mtime)` check
 * decides first and this service is only asked when that check is inconclusive — and even
 * then the cache answers when the file is provably the same one, byte for byte, as the
 * last time it was read.
 *
 * ## The cache key
 *
 * `(path, size, mtimeMs, dev, ino)`. Path alone is not enough: a file can be replaced by
 * a rename, keeping its path while becoming entirely different content. `dev` and `ino`
 * catch that — a replaced file is a new inode — and they are why the key is not merely
 * `(path, size, mtime)`, which a fast rewrite inside one mtime granularity would defeat.
 */

export const HASH_ALGORITHMS = ['xxhash64', 'sha256'] as const;
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

/**
 * What makes a file "the same file, unchanged" for caching purposes.
 *
 * Every field comes from a single `stat`, so the identity is cheap next to the read it
 * avoids.
 */
export interface FileIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
}

export interface HashResult {
  readonly digest: string;
  readonly algorithm: HashAlgorithm;
  /** Bytes actually read. Zero on a cache hit, which is the point of the cache. */
  readonly bytesRead: number;
  readonly cached: boolean;
  readonly identity: FileIdentity;
}

export interface HashServiceOptions {
  /**
   * Concurrent file reads. The default is deliberately small: on a Pi with one SD card
   * and a CIFS mount, more parallel readers make the whole set slower, not faster.
   */
  readonly concurrency?: number;
  /** Entries retained per algorithm. */
  readonly cacheSize?: number;
  /** Read buffer. 256 KiB keeps the syscall count low without holding much. */
  readonly chunkSize?: number;
}

export interface HashServiceStats {
  readonly hits: number;
  readonly misses: number;
  readonly bytesRead: number;
  readonly filesHashed: number;
  readonly cacheEntries: number;
}

const DEFAULTS = {
  concurrency: 2,
  cacheSize: 20_000,
  chunkSize: 256 * 1024,
} as const;

/**
 * Anything that yields bytes: a file stream, a socket, an array of chunks.
 *
 * Synchronous iterables are accepted as well as asynchronous ones because `for await`
 * consumes both, and refusing the plain ones would force every caller holding a list of
 * buffers to wrap it in an async generator for no benefit.
 */
export type ByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/**
 * A hash of a stream that is never held in memory.
 *
 * Exported on its own because it is the honest unit of the memory guarantee: it takes a
 * source it cannot rewind, so there is nowhere for a whole-file buffer to hide.
 */
export async function hashStream(
  source: ByteSource,
  algorithm: HashAlgorithm,
): Promise<{ digest: string; bytesRead: number }> {
  const hasher = algorithm === 'sha256' ? await createSHA256() : await createXXHash64();
  hasher.init();

  let bytesRead = 0;
  for await (const chunk of source) {
    hasher.update(chunk);
    bytesRead += chunk.length;
  }

  return { digest: hasher.digest('hex'), bytesRead };
}

/** The identity a `stat` implies. Separated so callers that already have one can reuse it. */
export function identityOf(stats: {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}): FileIdentity {
  return {
    size: stats.size,
    // mtimeMs carries sub-millisecond noise on some filesystems and none on others.
    // Truncating makes the key stable across the two, at the cost of a granularity the
    // dev/ino pair already covers.
    mtimeMs: Math.floor(stats.mtimeMs),
    dev: stats.dev,
    ino: stats.ino,
  };
}

/** Whether two identities describe the same bytes, without reading any of them. */
export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino;
}

interface CacheEntry {
  readonly identity: FileIdentity;
  readonly digest: string;
}

/**
 * Insertion-ordered LRU over a `Map`.
 *
 * A `Map` iterates in insertion order, so "delete then set" moves a key to the back and
 * the first key is always the least recently used. That is the whole implementation; a
 * dependency for it would be more code to audit than the eleven lines it replaces.
 */
class LruCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly max: number) {}

  get(key: string): CacheEntry | undefined {
    const found = this.entries.get(key);
    if (found === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, found);
    return found;
  }

  set(key: string, value: CacheEntry): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      /* istanbul ignore next -- the loop condition proves the map is non-empty; this
         guard exists only because the iterator protocol's type cannot say so */
      if (oldest.done === true) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export class HashService {
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly caches: ReadonlyMap<HashAlgorithm, LruCache>;
  private readonly chunkSize: number;

  private hits = 0;
  private misses = 0;
  private bytesRead = 0;
  private filesHashed = 0;

  constructor(options: HashServiceOptions = {}) {
    const concurrency = options.concurrency ?? DEFAULTS.concurrency;
    const cacheSize = options.cacheSize ?? DEFAULTS.cacheSize;
    this.chunkSize = options.chunkSize ?? DEFAULTS.chunkSize;
    this.limit = pLimit(concurrency);
    this.caches = new Map(
      HASH_ALGORITHMS.map((algorithm) => [algorithm, new LruCache(cacheSize)] as const),
    );
  }

  /**
   * Hashes a file, reading it only if the cache cannot answer.
   *
   * The `stat` happens outside the concurrency limit on purpose: it is cheap, and doing
   * it first means a cache hit never occupies one of the few read slots.
   */
  async hashFile(path: string, algorithm: HashAlgorithm = 'xxhash64'): Promise<HashResult> {
    const identity = identityOf(await stat(path));
    const cache = this.cacheFor(algorithm);
    const cached = cache.get(path);

    if (cached !== undefined && sameIdentity(cached.identity, identity)) {
      this.hits += 1;
      return { digest: cached.digest, algorithm, bytesRead: 0, cached: true, identity };
    }

    this.misses += 1;

    return this.limit(async () => {
      // Re-stat inside the limit: the file may have been rewritten while this call was
      // queued behind others, and hashing bytes while reporting a stale identity would
      // poison the cache for as long as the entry lives.
      const current = identityOf(await stat(path));
      const stream = createReadStream(path, { highWaterMark: this.chunkSize });
      const { digest, bytesRead } = await hashStream(stream, algorithm);

      this.bytesRead += bytesRead;
      this.filesHashed += 1;
      cache.set(path, { identity: current, digest });

      return { digest, algorithm, bytesRead, cached: false, identity: current };
    });
  }

  /**
   * Hashes only when the cheap check cannot rule the change out.
   *
   * This is the entry point the scanner should use: it makes "we already know this is
   * unchanged" cost nothing at all, not even a `stat`.
   */
  async hashIfChanged(
    path: string,
    previous: { identity: FileIdentity; digest: string } | null,
    algorithm: HashAlgorithm = 'xxhash64',
  ): Promise<HashResult> {
    if (previous !== null) {
      const identity = identityOf(await stat(path));
      if (sameIdentity(previous.identity, identity)) {
        this.hits += 1;
        return {
          digest: previous.digest,
          algorithm,
          bytesRead: 0,
          cached: true,
          identity,
        };
      }
    }
    return this.hashFile(path, algorithm);
  }

  /** Forgets one path, in every algorithm. Call after writing to it. */
  invalidate(path: string): void {
    for (const cache of this.caches.values()) {
      cache.delete(path);
    }
  }

  clear(): void {
    for (const cache of this.caches.values()) {
      cache.clear();
    }
    this.hits = 0;
    this.misses = 0;
    this.bytesRead = 0;
    this.filesHashed = 0;
  }

  get stats(): HashServiceStats {
    let cacheEntries = 0;
    for (const cache of this.caches.values()) {
      cacheEntries += cache.size;
    }
    return {
      hits: this.hits,
      misses: this.misses,
      bytesRead: this.bytesRead,
      filesHashed: this.filesHashed,
      cacheEntries,
    };
  }

  private cacheFor(algorithm: HashAlgorithm): LruCache {
    const cache = this.caches.get(algorithm);
    /* istanbul ignore next -- the map is built from HASH_ALGORITHMS, which types the argument */
    if (cache === undefined) {
      throw new Error(`no cache for algorithm ${algorithm}`);
    }
    return cache;
  }
}
