import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { createHasher, hashStream, type ByteSource } from '../sync/hasher';

/**
 * The content-addressed blob store behind file versioning (T34).
 *
 * A version's identity is the SHA-256 of its content, and that digest *is* the blob's
 * address on disk. Three properties fall out of that choice, and they are the reason
 * for it:
 *
 * - **Deduplication is free and exact.** Ten versions of a program that was saved ten
 *   times without being edited are ten `file_versions` rows pointing at one blob. No
 *   comparison pass, no heuristic — the address is the content, so identical content
 *   cannot occupy two addresses.
 * - **Writes are idempotent.** Storing content that is already present is a `stat`, not
 *   a copy. Re-running a capture after a crash is therefore harmless.
 * - **Corruption is detectable.** {@link BlobStore.verify} re-hashes a blob and compares
 *   it to its own filename, which is a self-checking invariant no external index can
 *   drift from.
 *
 * ## Layout
 *
 * `<root>/<aa>/<bb>/<full-hash>[.gz]`, fanned out on the first two byte-pairs of the
 * digest. The fan-out is not decoration: ext4 directory lookups degrade badly past a few
 * tens of thousands of entries, and a busy share can produce that many versions. Two
 * levels of 256 gives 65 536 buckets, which keeps every directory small for any store
 * this hardware can hold.
 *
 * ## Compression
 *
 * gzip above {@link COMPRESS_THRESHOLD_BYTES}, and only when it actually pays. The
 * digest always describes the *uncompressed* content — compression is a storage detail,
 * never part of the address — so `.gz` is discovered by probing both names rather than
 * recorded anywhere. That keeps the metadata row honest: its `hash` is what a restore
 * must produce, whatever the bytes on disk look like.
 *
 * ## Durability
 *
 * Every write lands in a temp file in the same directory, is fsynced, and is then
 * renamed into place. A crash mid-write therefore leaves a stray temp file — never a
 * truncated blob at a valid address, which would be indistinguishable from good content
 * until someone restored it.
 */

/** Below this, gzip's header costs more than it saves on the small NC programs typical here. */
export const COMPRESS_THRESHOLD_BYTES = 1024 * 1024;

/** A digest is 64 lowercase hex characters, and nothing else is ever accepted as an address. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface BlobStoreOptions {
  /** Root directory, e.g. `/var/lib/tnc-bridge/versions`. Created on demand. */
  readonly root: string;
  /** Set to 0 to disable compression entirely. */
  readonly compressThresholdBytes?: number;
}

export interface StoredBlob {
  readonly hash: string;
  /** Uncompressed length — the size a restore will produce. */
  readonly size: number;
  /** Bytes this blob actually occupies on disk. Equals `size` when stored raw. */
  readonly storedSize: number;
  readonly compressed: boolean;
  /** False when the content was already present, which is the dedup hit. */
  readonly created: boolean;
}

export interface BlobStoreStats {
  readonly blobs: number;
  readonly bytesOnDisk: number;
}

export class BlobCorruptError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Blob ${expected} hashes to ${actual} — the store is corrupt`);
    this.name = 'BlobCorruptError';
  }
}

export class BlobNotFoundError extends Error {
  constructor(readonly hash: string) {
    super(`No blob stored for ${hash}`);
    this.name = 'BlobNotFoundError';
  }
}

/** Rejects anything that is not a well-formed digest, before it can become a path. */
export function assertHash(hash: string): void {
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`Not a SHA-256 digest: ${JSON.stringify(hash)}`);
  }
}

export class BlobStore {
  private readonly root: string;
  private readonly compressThreshold: number;

  constructor(options: BlobStoreOptions) {
    this.root = resolve(options.root);
    this.compressThreshold = options.compressThresholdBytes ?? COMPRESS_THRESHOLD_BYTES;
  }

  /**
   * The directory a digest belongs in.
   *
   * Because {@link assertHash} has already proven the input is 64 hex characters, the
   * result cannot escape the root — there is no `..` to be had in `[0-9a-f]`. That is
   * why validation happens here rather than at the API edge: every path this class
   * builds passes through this one method.
   */
  private bucketOf(hash: string): string {
    assertHash(hash);
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4));
  }

  /** The raw (uncompressed) path for a digest. */
  rawPathOf(hash: string): string {
    return join(this.bucketOf(hash), hash);
  }

  /** The gzipped path for a digest. */
  gzPathOf(hash: string): string {
    return `${this.rawPathOf(hash)}.gz`;
  }

  /**
   * Locates a stored blob, probing raw before gzip.
   *
   * Returns `null` rather than throwing, because "is this content already here?" is the
   * question every capture asks first and a miss is the ordinary answer, not a fault.
   */
  async locate(
    hash: string,
  ): Promise<{ path: string; compressed: boolean; storedSize: number } | null> {
    const raw = this.rawPathOf(hash);
    const rawStat = await statOrNull(raw);
    if (rawStat !== null) {
      return { path: raw, compressed: false, storedSize: rawStat.size };
    }
    const gz = this.gzPathOf(hash);
    const gzStat = await statOrNull(gz);
    if (gzStat !== null) {
      return { path: gz, compressed: true, storedSize: gzStat.size };
    }
    return null;
  }

  async has(hash: string): Promise<boolean> {
    return (await this.locate(hash)) !== null;
  }

  /**
   * Stores the contents of a file, returning its digest.
   *
   * The file is read twice — once to hash, once to copy — and that is deliberate. The
   * alternative is to buffer the whole file to avoid the second read, which on a Pi
   * syncing 512 MB programs is exactly the memory blow-up the streaming design exists to
   * prevent. The second read is also usually free: it comes straight from page cache,
   * having just been read.
   *
   * The hash-first ordering is what makes dedup cheap — content already in the store
   * costs one read and no write at all.
   */
  async putFile(sourcePath: string): Promise<StoredBlob> {
    const { size } = await stat(sourcePath);
    const { digest } = await hashStream(createReadStream(sourcePath), 'sha256');

    const existing = await this.locate(digest);
    if (existing !== null) {
      return {
        hash: digest,
        size,
        storedSize: existing.storedSize,
        compressed: existing.compressed,
        created: false,
      };
    }

    const compress = this.compressThreshold > 0 && size >= this.compressThreshold;
    const target = compress ? this.gzPathOf(digest) : this.rawPathOf(digest);
    const storedSize = await this.writeAtomically(
      target,
      () => createReadStream(sourcePath),
      compress,
    );

    return { hash: digest, size, storedSize, compressed: compress, created: true };
  }

  /**
   * Stores bytes held in memory. For callers that already have the content — a restore's
   * pre-image, a test fixture — and would otherwise write a temp file just to read it back.
   */
  async putBuffer(content: Uint8Array): Promise<StoredBlob> {
    const { digest } = await hashStream([content], 'sha256');
    const size = content.byteLength;

    const existing = await this.locate(digest);
    if (existing !== null) {
      return {
        hash: digest,
        size,
        storedSize: existing.storedSize,
        compressed: existing.compressed,
        created: false,
      };
    }

    const compress = this.compressThreshold > 0 && size >= this.compressThreshold;
    const target = compress ? this.gzPathOf(digest) : this.rawPathOf(digest);
    const storedSize = await this.writeAtomically(target, () => Readable.from([content]), compress);

    return { hash: digest, size, storedSize, compressed: compress, created: true };
  }

  /**
   * Opens a blob for reading, transparently decompressing.
   *
   * The caller receives uncompressed content whether or not the blob was gzipped, which
   * is the whole point of keeping compression out of the address.
   */
  async openRead(hash: string): Promise<NodeJS.ReadableStream> {
    const found = await this.locate(hash);
    if (found === null) {
      throw new BlobNotFoundError(hash);
    }
    const raw = createReadStream(found.path);
    return found.compressed ? raw.pipe(createGunzip()) : raw;
  }

  /** Reads a blob fully into memory. Only for content already known to be small. */
  async readAll(hash: string): Promise<Buffer> {
    const stream = await this.openRead(hash);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(toBuffer(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Writes a blob out to `destination`, atomically and with its digest verified.
   *
   * Verification is not optional here. This is the restore path: handing back silently
   * wrong bytes for an NC program is the single worst failure this subsystem could have,
   * so the content is re-hashed as it is written and the destination is only created if
   * it matches.
   */
  async extractTo(hash: string, destination: string): Promise<number> {
    const found = await this.locate(hash);
    if (found === null) {
      throw new BlobNotFoundError(hash);
    }

    await mkdir(dirname(destination), { recursive: true });
    const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;

    try {
      // One traversal, in `copyAndHash`: the digest it checks describes exactly the bytes
      // it wrote. Hashing in a second pass would leave a window where the two could differ.
      const written = await this.copyAndHash(found.path, found.compressed, temp, hash);
      await rename(temp, destination);
      return written;
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Copies a blob to `temp` while hashing the same bytes, and throws unless the digest
   * matches. One traversal: the hash describes exactly what was written, not a second
   * read that could differ.
   */
  private async copyAndHash(
    sourcePath: string,
    compressed: boolean,
    temp: string,
    expected: string,
  ): Promise<number> {
    const source = createReadStream(sourcePath);
    const decoded: NodeJS.ReadableStream = compressed ? source.pipe(createGunzip()) : source;

    const handle = await open(temp, 'w');
    let written = 0;
    try {
      const hasher = await createHasher('sha256');
      const sink = createWriteStream('', { fd: handle.fd, autoClose: false });
      await pipeline(
        (async function* () {
          for await (const chunk of decoded) {
            const buf = toBuffer(chunk);
            hasher.update(buf);
            written += buf.length;
            yield buf;
          }
        })(),
        sink,
      );
      const actual = hasher.digest('hex');
      if (actual !== expected) {
        throw new BlobCorruptError(expected, actual);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return written;
  }

  /** Re-hashes a stored blob and reports whether it still matches its own address. */
  async verify(hash: string): Promise<boolean> {
    const found = await this.locate(hash);
    if (found === null) {
      return false;
    }
    const source = createReadStream(found.path);
    const decoded: ByteSource = (
      found.compressed ? source.pipe(createGunzip()) : source
    ) as ByteSource;
    const { digest } = await hashStream(decoded, 'sha256');
    return digest === hash;
  }

  /**
   * Removes a blob. Returns false when it was already gone.
   *
   * Callers must have proven no `file_versions` row still references the digest — this
   * class has no view of the metadata and cannot check for them.
   */
  async delete(hash: string): Promise<boolean> {
    const found = await this.locate(hash);
    if (found === null) {
      return false;
    }
    await unlink(found.path);
    // Prune the two fan-out levels if they are now empty, so a store that shrinks does
    // not leave 65 536 empty directories behind forever.
    await removeIfEmpty(dirname(found.path));
    await removeIfEmpty(dirname(dirname(found.path)));
    return true;
  }

  /** Every digest currently in the store. Used by the orphan sweep in T39. */
  async list(): Promise<string[]> {
    const digests: string[] = [];
    for (const level1 of await readdirOrEmpty(this.root)) {
      for (const level2 of await readdirOrEmpty(join(this.root, level1))) {
        for (const name of await readdirOrEmpty(join(this.root, level1, level2))) {
          const digest = name.endsWith('.gz') ? name.slice(0, -3) : name;
          if (SHA256_PATTERN.test(digest)) {
            digests.push(digest);
          }
        }
      }
    }
    return digests;
  }

  /** Blob count and total bytes on disk. Feeds the `maxStoreGb` ceiling and the metrics. */
  async stats(): Promise<BlobStoreStats> {
    let blobs = 0;
    let bytesOnDisk = 0;
    for (const level1 of await readdirOrEmpty(this.root)) {
      for (const level2 of await readdirOrEmpty(join(this.root, level1))) {
        const dir = join(this.root, level1, level2);
        for (const name of await readdirOrEmpty(dir)) {
          const info = await statOrNull(join(dir, name));
          if (info !== null) {
            blobs += 1;
            bytesOnDisk += info.size;
          }
        }
      }
    }
    return { blobs, bytesOnDisk };
  }

  /** Deletes temp files left by a crash mid-write. Safe to run at any time. */
  async sweepTemp(): Promise<number> {
    let removed = 0;
    for (const level1 of await readdirOrEmpty(this.root)) {
      for (const level2 of await readdirOrEmpty(join(this.root, level1))) {
        const dir = join(this.root, level1, level2);
        for (const name of await readdirOrEmpty(dir)) {
          if (name.endsWith('.tmp')) {
            await unlink(join(dir, name)).catch(() => undefined);
            removed += 1;
          }
        }
      }
    }
    return removed;
  }

  /**
   * Temp file, fsync, rename. The ordering is the durability guarantee: `rename` within
   * a directory is atomic on ext4, so the blob either does not exist or is complete.
   */
  private async writeAtomically(
    target: string,
    openSource: () => NodeJS.ReadableStream,
    compress: boolean,
  ): Promise<number> {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;

    const handle = await open(temp, 'w');
    try {
      const sink = createWriteStream('', { fd: handle.fd, autoClose: false });
      if (compress) {
        await pipeline(openSource(), createGzip(), sink);
      } else {
        await pipeline(openSource(), sink);
      }
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw err;
    }
    await handle.close();

    await rename(temp, target);
    const info = await stat(target);
    return info.size;
  }

  /** The absolute store root, for callers that report on disk usage. */
  get rootPath(): string {
    return this.root;
  }
}

/**
 * Normalises a stream chunk to a Buffer.
 *
 * A Node readable yields `string | Buffer` depending on its encoding. Every stream in
 * this file is opened without one, so chunks are always Buffers in practice — but the
 * type does not say so, and hashing a string as UTF-8 when it was really latin1 would
 * silently produce the wrong digest. Handling the string case explicitly costs nothing
 * and removes the possibility.
 */
function toBuffer(chunk: string | Buffer): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

async function statOrNull(path: string): Promise<{ size: number } | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size } : null;
  } catch {
    return null;
  }
}

async function readdirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) {
      await rm(dir, { recursive: false });
    }
  } catch {
    // A non-empty directory or a concurrent writer; either way there is nothing to do.
  }
}

/** Exposed for tests that need to reason about the on-disk layout. */
export const blobLayout = { sep, SHA256_PATTERN } as const;
