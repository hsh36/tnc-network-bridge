import { createReadStream } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TEMP_FILE_PREFIX } from '../../shared/constants';
import { createHasher, hashStream, type HashAlgorithm } from './hasher';

/**
 * The transfer executor (T19) — IMPLEMENTATION_PLAN §3.2.
 *
 * Everything here exists to uphold one promise: **a destination file is either the old
 * content or the new content, never a mixture, and never a truncation.** A CNC program
 * that is half-written is not a damaged file, it is a crash into a fixture, so the
 * failure mode this module refuses to have is "partially transferred".
 *
 * The mechanism is the standard one and it is not negotiable:
 *
 * 1. write to `<dir>/.tnc-tmp-<random>` in the **destination directory**, so the final
 *    step is a rename within one filesystem and therefore atomic;
 * 2. `fsync` the file, so the bytes are on the medium and not merely in the page cache;
 * 3. verify what actually landed by reading it back and hashing it;
 * 4. `rename()` over the destination, which is atomic — a reader sees one or the other;
 * 5. `fsync` the directory, so the rename itself survives a power cut.
 *
 * Writing in place would skip all five and is why this module has no code path that
 * opens the destination for writing.
 *
 * ## Why the readback
 *
 * Hashing the bytes as they stream past proves the *source* was read correctly. It says
 * nothing about what the filesystem stored — and the interesting failures here are a
 * flaky SD card and a CIFS mount that reports a short write as success. So the temp file
 * is read back and hashed before the rename. It costs one extra read of the file and it
 * is the only check that can actually catch a bad write.
 *
 * ## What is retried and what is not
 *
 * A transient fault (a share that blinked, a busy file, a hash mismatch that may be a
 * one-off) is retried three times with 1 s / 5 s / 25 s backoff. A permanent one — no
 * space, no permission, no source — fails immediately, because retrying it 3 times just
 * delays the operator seeing a problem only they can fix.
 */

/** Bytes kept free after any transfer, so a full disk cannot wedge the whole bridge. */
const FREE_SPACE_MARGIN_BYTES = 16 * 1024 * 1024;

/** §3.2: three attempts, 1 s / 5 s / 25 s. */
const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 25_000] as const;

const DEFAULT_CHUNK_SIZE = 256 * 1024;

/**
 * Errno values that describe a condition a retry cannot change.
 *
 * The list is a denylist rather than an allowlist on purpose: an unrecognised error is
 * treated as transient and retried, which wastes at most 31 seconds. Treating an
 * unrecognised error as permanent would abandon a file for a fault that had already
 * cleared.
 */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'ENOSPC', // the disk is full
  'EDQUOT', // the quota is exhausted
  'EACCES', // no permission
  'EPERM',
  'EROFS', // the target is read-only
  'ENOENT', // the source is gone
  'EISDIR',
  'ENOTDIR',
  'EFBIG', // larger than the filesystem allows
  'ENAMETOOLONG',
]);

export type TransferFailureKind =
  | 'disk_full'
  | 'permission_denied'
  | 'source_missing'
  | 'read_only'
  | 'verification_failed'
  | 'io_error';

export class TransferError extends Error {
  readonly kind: TransferFailureKind;
  readonly retryable: boolean;
  readonly path: string;
  readonly attempts: number;

  constructor(
    message: string,
    options: {
      kind: TransferFailureKind;
      retryable: boolean;
      path: string;
      attempts?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'TransferError';
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.path = options.path;
    this.attempts = options.attempts ?? 1;
  }
}

export interface TransferOptions {
  /** Hash used for verification. xxhash64 unless a version blob is being written. */
  readonly algorithm?: HashAlgorithm;
  /** Copy buffer. */
  readonly chunkSize?: number;
  /** Backoff schedule. An empty array disables retrying entirely. */
  readonly retryDelaysMs?: readonly number[];
  /** Injected so tests do not wait 31 seconds to prove the schedule. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Free space required beyond the file itself. */
  readonly freeSpaceMarginBytes?: number;
  /** Copy mtime and mode from the source. On by default. */
  readonly preserveMetadata?: boolean;
  /**
   * Test seam, run after the temp file is written and synced but before it is verified.
   * It is how the corruption path is exercised without waiting for a failing SD card.
   */
  readonly afterWrite?: (tempPath: string) => Promise<void>;
}

export interface TransferResult {
  readonly bytesWritten: number;
  readonly digest: string;
  readonly algorithm: HashAlgorithm;
  /** 1 when it worked first time. */
  readonly attempts: number;
  readonly durationMs: number;
  /** True when the file was moved rather than copied. */
  readonly renamed: boolean;
}

const isErrnoCode = (error: unknown): string | null => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code?: unknown };
    return typeof code === 'string' ? code : null;
  }
  return null;
};

const kindForCode = (code: string | null): TransferFailureKind => {
  switch (code) {
    case null:
      // No errno at all: something threw that was not a filesystem error.
      return 'io_error';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'disk_full';
    case 'EACCES':
    case 'EPERM':
      return 'permission_denied';
    case 'EROFS':
      return 'read_only';
    case 'ENOENT':
      return 'source_missing';
    default:
      return 'io_error';
  }
};

/** Wraps an unknown throwable as a classified, retry-aware transfer failure. */
function classify(error: unknown, path: string): TransferError {
  if (error instanceof TransferError) {
    return error;
  }
  const code = isErrnoCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return new TransferError(`${path}: ${message}`, {
    kind: kindForCode(code),
    retryable: code === null ? true : !PERMANENT_CODES.has(code),
    path,
    cause: error,
  });
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A temp name in the destination's own directory, so the rename cannot cross a device. */
export function tempPathFor(destination: string): string {
  return join(dirname(destination), `${TEMP_FILE_PREFIX}${randomBytes(9).toString('hex')}`);
}

export function isTempPath(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  return name.startsWith(TEMP_FILE_PREFIX);
}

/** Best-effort unlink. A missing temp file is the desired state, not a failure. */
async function discard(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Nothing to do: either it never existed or something else removed it. Reporting
    // this would replace a real error with a meaningless one on the way out.
  }
}

/**
 * Flushes the directory entry itself.
 *
 * Without this the rename can still be lost to a power cut even though the file's own
 * bytes were synced. Windows cannot open a directory as a file, so the failure is
 * expected there and ignored rather than papered over everywhere.
 */
async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // Not supported on this platform or filesystem.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Refuses the transfer before it starts if it would fill the disk.
 *
 * Checking up front matters more than it looks: without it, a large file fails at 99 %
 * having already evicted the page cache and left a temp file the size of the disk.
 */
export async function assertSpaceAvailable(
  directory: string,
  requiredBytes: number,
  marginBytes = FREE_SPACE_MARGIN_BYTES,
): Promise<void> {
  let available: number;
  try {
    const fs = await statfs(directory);
    available = Number(fs.bsize) * Number(fs.bavail);
  } catch {
    // A filesystem that cannot report its size is not a reason to refuse to write to it.
    return;
  }

  if (available < requiredBytes + marginBytes) {
    throw new TransferError(
      `not enough space in ${directory}: need ${requiredBytes + marginBytes} bytes ` +
        `(${requiredBytes} for the file plus a ${marginBytes} margin), ${available} available`,
      { kind: 'disk_full', retryable: false, path: directory },
    );
  }
}

/**
 * Copies one file atomically, verifying what landed.
 *
 * Retries are whole-attempt: a failed attempt leaves nothing behind and the next one
 * starts from an empty temp file. Resuming a partial copy would be faster and would also
 * mean trusting bytes written by an attempt that already demonstrated it could fail.
 */
export async function transferFile(
  source: string,
  destination: string,
  options: TransferOptions = {},
): Promise<TransferResult> {
  const algorithm = options.algorithm ?? 'xxhash64';
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? wait;
  const startedAt = Date.now();

  const sourceStats = await stat(source).catch((error: unknown) => {
    throw classify(error, source);
  });

  await mkdir(dirname(destination), { recursive: true });
  await assertSpaceAvailable(dirname(destination), sourceStats.size, options.freeSpaceMarginBytes);

  let lastError: TransferError | null = null;

  for (let attempt = 1; attempt <= delays.length + 1; attempt += 1) {
    try {
      const { bytesWritten, digest } = await attemptCopy(source, destination, {
        algorithm,
        chunkSize,
        preserveMetadata: options.preserveMetadata ?? true,
        ...(options.afterWrite === undefined ? {} : { afterWrite: options.afterWrite }),
      });

      return {
        bytesWritten,
        digest,
        algorithm,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
        renamed: false,
      };
    } catch (error) {
      const failure = classify(error, destination);
      lastError = new TransferError(failure.message, {
        kind: failure.kind,
        retryable: failure.retryable,
        path: failure.path,
        attempts: attempt,
        cause: failure.cause,
      });

      const delay = delays[attempt - 1];
      if (!failure.retryable || delay === undefined) {
        throw lastError;
      }
      await sleep(delay);
    }
  }

  /* istanbul ignore next -- the loop either returns or throws on its final iteration */
  throw (
    lastError ??
    new TransferError('transfer failed', {
      kind: 'io_error',
      retryable: false,
      path: destination,
    })
  );
}

interface AttemptOptions {
  algorithm: HashAlgorithm;
  chunkSize: number;
  preserveMetadata: boolean;
  afterWrite?: (tempPath: string) => Promise<void>;
}

async function attemptCopy(
  source: string,
  destination: string,
  options: AttemptOptions,
): Promise<{ bytesWritten: number; digest: string }> {
  const temp = tempPathFor(destination);
  const sourceStats = await stat(source);

  try {
    const hasher = await createHasher(options.algorithm);
    let bytesWritten = 0;

    const handle = await open(temp, 'wx', sourceStats.mode);
    try {
      const reader = createReadStream(source, { highWaterMark: options.chunkSize });
      for await (const chunk of reader) {
        const buffer = chunk as Buffer;
        await handle.write(buffer);
        hasher.update(buffer);
        bytesWritten += buffer.length;
      }
      // The bytes are the filesystem's problem only once this returns.
      await handle.sync();
    } finally {
      await handle.close();
    }

    const sourceDigest = hasher.digest('hex');

    if (options.afterWrite !== undefined) {
      await options.afterWrite(temp);
    }

    // Read back what was actually stored. This is the check that catches a bad write,
    // as opposed to a bad read, and it is the reason the temp file is not simply renamed.
    const written = await stat(temp);
    if (written.size !== bytesWritten) {
      throw new TransferError(
        `${destination}: wrote ${bytesWritten} bytes but the file holds ${written.size}`,
        { kind: 'verification_failed', retryable: true, path: destination },
      );
    }

    const readback = await hashStream(
      createReadStream(temp, { highWaterMark: options.chunkSize }),
      options.algorithm,
    );
    if (readback.digest !== sourceDigest) {
      throw new TransferError(
        `${destination}: verification failed — read back ${readback.digest}, expected ` +
          `${sourceDigest}; the copy was discarded`,
        { kind: 'verification_failed', retryable: true, path: destination },
      );
    }

    if (options.preserveMetadata) {
      // Order matters: utimes after the last write, or the write would move mtime again.
      await chmod(temp, sourceStats.mode);
      await utimes(temp, sourceStats.atime, sourceStats.mtime);
    }

    await rename(temp, destination);
    await syncDirectory(dirname(destination));

    return { bytesWritten, digest: sourceDigest };
  } catch (error) {
    // Every failure path, without exception, takes the temp file with it.
    await discard(temp);
    throw error;
  }
}

/**
 * Moves a file, falling back to copy-then-delete across devices.
 *
 * This is the rename optimisation: when the scanner reports a path change rather than a
 * new file, moving it costs no I/O at all, where a copy would move the whole file over
 * the network to produce bytes that are already there.
 */
export async function moveFile(
  source: string,
  destination: string,
  options: TransferOptions = {},
): Promise<TransferResult> {
  const startedAt = Date.now();
  await mkdir(dirname(destination), { recursive: true });

  try {
    await rename(source, destination);
    await syncDirectory(dirname(destination));
    const moved = await stat(destination);
    return {
      bytesWritten: moved.size,
      digest: '',
      algorithm: options.algorithm ?? 'xxhash64',
      attempts: 1,
      durationMs: Date.now() - startedAt,
      renamed: true,
    };
  } catch (error) {
    const code = isErrnoCode(error);
    if (code !== 'EXDEV') {
      throw classify(error, destination);
    }
    // Different filesystems: there is no rename to make, so it becomes a real transfer.
    return copyThenDelete(source, destination, options);
  }
}

/**
 * The cross-device fallback: a verified copy, and only then the removal of the source.
 *
 * The order is the whole point. Deleting first would turn a failed copy into a lost file,
 * so the source outlives the destination until the destination is proven good — which is
 * the same reasoning that puts the rename last inside {@link transferFile}.
 */
export async function copyThenDelete(
  source: string,
  destination: string,
  options: TransferOptions = {},
): Promise<TransferResult> {
  const result = await transferFile(source, destination, options);
  await unlink(source);
  return result;
}

export async function createDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    throw classify(error, path);
  }
}

/**
 * Removes a directory, but only an empty one.
 *
 * Recursive deletion is deliberately not offered. The orchestrator deletes files it has
 * decided to delete, one verdict at a time; a recursive remove would let a single wrong
 * verdict take a whole tree with it.
 */
export async function removeDirectory(path: string): Promise<boolean> {
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    const code = isErrnoCode(error);
    if (code === 'ENOENT') {
      return false;
    }
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      return false;
    }
    throw classify(error, path);
  }
}

/** Deletes a file. Returns false when it was already gone, which is not an error. */
export async function deleteFile(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isErrnoCode(error) === 'ENOENT') {
      return false;
    }
    throw classify(error, path);
  }
}

export interface CleanupResult {
  readonly removed: readonly string[];
  /** Paths that could not be removed, with the reason. Never throws for these. */
  readonly failed: readonly { path: string; reason: string }[];
}

/**
 * Sweeps abandoned temp files from a tree.
 *
 * Run at startup. A temp file after a restart is by definition the debris of a transfer
 * that was interrupted, since a completed one renames its temp away and a failed one
 * unlinks it. Nothing else in the system is allowed to use this prefix, which is also
 * why `smb.conf` vetoes it (T12) and the sync excludes match it.
 */
export async function cleanupTempFiles(root: string): Promise<CleanupResult> {
  const removed: string[] = [];
  const failed: { path: string; reason: string }[] = [];

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      failed.push({
        path: directory,
        reason: error instanceof Error ? error.message : 'unreadable',
      });
      return;
    }

    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.startsWith(TEMP_FILE_PREFIX)) {
        continue;
      }
      try {
        await rm(full, { force: true });
        removed.push(full);
      } catch (error) {
        failed.push({ path: full, reason: error instanceof Error ? error.message : 'unknown' });
      }
    }
  };

  await walk(root);
  return { removed, failed };
}
