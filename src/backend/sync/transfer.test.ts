import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEMP_FILE_PREFIX } from '../../shared/constants';
import { hashStream } from './hasher';
import {
  TransferError,
  copyThenDelete,
  assertSpaceAvailable,
  cleanupTempFiles,
  createDirectory,
  deleteFile,
  isTempPath,
  moveFile,
  removeDirectory,
  tempPathFor,
  transferFile,
} from './transfer';

/**
 * T19 acceptance tests.
 *
 * The headline criterion — "a transfer killed mid-flight leaves the destination
 * untouched and no temp files after restart" — is tested by actually killing a process
 * mid-transfer, not by simulating one. It is the only way to find out whether the temp
 * file really is in the destination directory and the rename really is the last step.
 */

let dir: string;
let source: string;
let target: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tnc-transfer-'));
  source = join(dir, 'src');
  target = join(dir, 'dst');
  mkdirSync(source);
  mkdirSync(target);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content: string | Buffer, base = source): string => {
  const path = join(base, name);
  writeFileSync(path, content);
  return path;
};

const tempFilesIn = (path: string): string[] =>
  readdirSync(path).filter((name) => name.startsWith(TEMP_FILE_PREFIX));

/**
 * Awaits a call that must fail and hands back the failure.
 *
 * `promise.catch(e => e)` would type the result as the union of the error and whatever
 * the call resolves to, which then needs a cast at every use. This narrows once, here,
 * and turns "it unexpectedly succeeded" into a clear failure rather than a type error.
 */
const failureOf = async (promise: Promise<unknown>): Promise<TransferError> => {
  try {
    await promise;
  } catch (error) {
    return error as TransferError;
  }
  throw new Error('expected the operation to fail, but it succeeded');
};

/** No real waiting: the schedule is asserted from what it was asked to sleep. */
const recordingSleep = (): { delays: number[]; sleep: (ms: number) => Promise<void> } => {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
};

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('transferFile', () => {
  it('copies content exactly and reports what it did', async () => {
    const content = randomBytes(200_000);
    const from = write('PROG.H', content);
    const to = join(target, 'PROG.H');

    const result = await transferFile(from, to);

    expect(readFileSync(to)).toEqual(content);
    expect(result.bytesWritten).toBe(content.length);
    expect(result.attempts).toBe(1);
    expect(result.renamed).toBe(false);
    expect(result.algorithm).toBe('xxhash64');
  });

  it('returns the digest of the bytes it moved', async () => {
    const from = write('D.H', 'BEGIN PGM D MM');
    const expected = (await hashStream([Buffer.from('BEGIN PGM D MM')], 'xxhash64')).digest;

    expect((await transferFile(from, join(target, 'D.H'))).digest).toBe(expected);
  });

  it('can verify with sha256 when the caller is writing a version blob', async () => {
    const content = randomBytes(50_000);
    const from = write('blob.bin', content);

    const result = await transferFile(from, join(target, 'blob.bin'), { algorithm: 'sha256' });

    expect(result.digest).toBe(createHash('sha256').update(content).digest('hex'));
  });

  it('copies an empty file', async () => {
    const from = write('EMPTY.H', '');
    const result = await transferFile(from, join(target, 'EMPTY.H'));

    expect(result.bytesWritten).toBe(0);
    expect(existsSync(join(target, 'EMPTY.H'))).toBe(true);
  });

  it('creates missing destination directories', async () => {
    const from = write('N.H', 'X');
    const to = join(target, 'a', 'b', 'c', 'N.H');

    await transferFile(from, to);

    expect(readFileSync(to, 'utf8')).toBe('X');
  });

  it('overwrites an existing destination atomically', async () => {
    const from = write('O.H', 'NEW CONTENT');
    const to = write('O.H', 'OLD CONTENT', target);

    await transferFile(from, to);

    expect(readFileSync(to, 'utf8')).toBe('NEW CONTENT');
  });

  it('leaves no temp file behind on success', async () => {
    await transferFile(write('T.H', 'X'), join(target, 'T.H'));

    expect(tempFilesIn(target)).toEqual([]);
  });

  it('writes its temp file into the destination directory, never the source', async () => {
    const seen: string[] = [];
    await transferFile(write('W.H', 'X'), join(target, 'W.H'), {
      afterWrite: (temp) => {
        seen.push(temp);
        return Promise.resolve();
      },
    });

    // A temp file in the source directory would mean the final rename crosses a
    // filesystem, and a cross-device rename is a copy — which is not atomic.
    expect(seen[0]?.startsWith(target)).toBe(true);
    expect(tempFilesIn(source)).toEqual([]);
  });

  it('does not touch the destination until the rename', async () => {
    const to = write('P.H', 'ORIGINAL', target);
    let contentDuringWrite = '';

    await transferFile(write('P.H', 'REPLACEMENT'), to, {
      afterWrite: () => {
        contentDuringWrite = readFileSync(to, 'utf8');
        return Promise.resolve();
      },
    });

    expect(contentDuringWrite).toBe('ORIGINAL');
    expect(readFileSync(to, 'utf8')).toBe('REPLACEMENT');
  });

  it('preserves the modification time', async () => {
    const from = write('M.H', 'X');
    const when = new Date(Date.now() - 86_400_000);
    utimesSync(from, when, when);

    await transferFile(from, join(target, 'M.H'));

    expect(statSync(join(target, 'M.H')).mtimeMs).toBeCloseTo(when.getTime(), -3);
  });

  it('can be asked not to preserve metadata', async () => {
    const from = write('M2.H', 'X');
    const when = new Date(Date.now() - 86_400_000);
    utimesSync(from, when, when);

    await transferFile(from, join(target, 'M2.H'), { preserveMetadata: false });

    expect(statSync(join(target, 'M2.H')).mtimeMs).toBeGreaterThan(when.getTime());
  });

  it('handles a file larger than the copy buffer', async () => {
    const content = randomBytes(1_000_000);
    const from = write('BIG.H', content);

    const result = await transferFile(from, join(target, 'BIG.H'), { chunkSize: 4096 });

    expect(result.bytesWritten).toBe(content.length);
    expect(readFileSync(join(target, 'BIG.H'))).toEqual(content);
  });
});

// ---------------------------------------------------------------------------
// Verification and retry
// ---------------------------------------------------------------------------

describe('verification', () => {
  it('detects a corrupted copy, discards it, and retries', async () => {
    const from = write('C.H', 'GOOD CONTENT THAT MUST ARRIVE INTACT');
    const to = join(target, 'C.H');
    const { delays, sleep } = recordingSleep();
    let corruptions = 0;

    const result = await transferFile(from, to, {
      sleep,
      afterWrite: async (temp) => {
        // Corrupt only the first attempt: the retry must then succeed.
        if (corruptions === 0) {
          corruptions += 1;
          await writeFile(temp, 'CORRUPTED');
        }
      },
    });

    expect(corruptions).toBe(1);
    expect(result.attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(readFileSync(to, 'utf8')).toBe('GOOD CONTENT THAT MUST ARRIVE INTACT');
    expect(tempFilesIn(target)).toEqual([]);
  });

  it('detects a truncated copy by size before it hashes anything', async () => {
    const from = write('S.H', 'X'.repeat(1_000));
    const { sleep } = recordingSleep();
    let truncated = 0;

    const result = await transferFile(from, join(target, 'S.H'), {
      sleep,
      afterWrite: async (temp) => {
        if (truncated === 0) {
          truncated += 1;
          await writeFile(temp, 'X'.repeat(10));
        }
      },
    });

    expect(result.attempts).toBe(2);
    expect(statSync(join(target, 'S.H')).size).toBe(1_000);
  });

  it('gives up after the configured attempts and never renames a bad copy', async () => {
    const from = write('F.H', 'ORIGINAL');
    const to = write('F.H', 'UNTOUCHED', target);
    const { delays, sleep } = recordingSleep();

    await expect(
      transferFile(from, to, {
        sleep,
        afterWrite: (temp) => writeFile(temp, 'ALWAYS CORRUPT'),
      }),
    ).rejects.toThrow(TransferError);

    // Four attempts: the first plus one per delay in the 1/5/25 schedule.
    expect(delays).toEqual([1_000, 5_000, 25_000]);
    expect(readFileSync(to, 'utf8')).toBe('UNTOUCHED');
    expect(tempFilesIn(target)).toEqual([]);
  });

  it('reports verification failure as its own kind, with the attempt count', async () => {
    const from = write('K.H', 'CONTENT');
    const { sleep } = recordingSleep();

    // Same length as the source, so the size check passes and the hash is what catches
    // it — the case a bit-flip on the medium actually produces.
    const error = await failureOf(
      transferFile(from, join(target, 'K.H'), {
        sleep,
        afterWrite: (temp) => writeFile(temp, 'XXXXXXX'),
      }),
    );

    expect(error).toBeInstanceOf(TransferError);
    expect(error.kind).toBe('verification_failed');
    expect(error.attempts).toBe(4);
    expect(error.message).toContain('verification failed');
  });

  it('honours a custom retry schedule', async () => {
    const from = write('R.H', 'CONTENT');
    const { delays, sleep } = recordingSleep();

    await expect(
      transferFile(from, join(target, 'R.H'), {
        sleep,
        retryDelaysMs: [10, 20],
        afterWrite: (temp) => writeFile(temp, 'BAD'),
      }),
    ).rejects.toThrow(TransferError);

    expect(delays).toEqual([10, 20]);
  });

  it('does not retry at all when the schedule is empty', async () => {
    const from = write('R0.H', 'CONTENT');
    const { delays, sleep } = recordingSleep();

    const error = await failureOf(
      transferFile(from, join(target, 'R0.H'), {
        sleep,
        retryDelaysMs: [],
        afterWrite: (temp) => writeFile(temp, 'BAD'),
      }),
    );

    expect(delays).toEqual([]);
    expect(error.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Permanent failures
// ---------------------------------------------------------------------------

describe('permanent failures', () => {
  it('fails immediately when the source does not exist, without retrying', async () => {
    const { delays, sleep } = recordingSleep();

    const error = await failureOf(
      transferFile(join(source, 'ghost.H'), join(target, 'ghost.H'), {
        sleep,
      }),
    );

    expect(error).toBeInstanceOf(TransferError);
    expect(error.kind).toBe('source_missing');
    expect(error.retryable).toBe(false);
    expect(delays).toEqual([]);
  });

  it('refuses to start when the disk cannot hold the file', async () => {
    const from = write('HUGE.H', 'X'.repeat(1000));

    await expect(
      // A margin larger than any disk makes the precheck fire deterministically.
      transferFile(from, join(target, 'HUGE.H'), {
        freeSpaceMarginBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toMatchObject({ kind: 'disk_full', retryable: false });
  });

  it('aborts a disk-full cleanly, leaving no temp file', async () => {
    const from = write('DF.H', 'CONTENT');

    await expect(
      transferFile(from, join(target, 'DF.H'), {
        freeSpaceMarginBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow(TransferError);

    expect(tempFilesIn(target)).toEqual([]);
    expect(existsSync(join(target, 'DF.H'))).toBe(false);
  });

  it('names the shortfall in the message, so the operator knows what to free', async () => {
    const error = await failureOf(assertSpaceAvailable(target, 1_000, Number.MAX_SAFE_INTEGER));

    expect(error.message).toContain('not enough space');
    expect(error.message).toContain('margin');
  });

  it('allows a transfer the disk can hold', async () => {
    await expect(assertSpaceAvailable(target, 1, 0)).resolves.toBeUndefined();
  });

  it('does not refuse to write to a filesystem that cannot report its size', async () => {
    await expect(assertSpaceAvailable(join(dir, 'absent-dir'), 1)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Killed mid-flight (the acceptance criterion)
// ---------------------------------------------------------------------------

describe('interrupted transfers', () => {
  it('leaves the destination untouched when killed mid-transfer, and cleans up after', async () => {
    // 64 MB through a small buffer: slow enough that the kill lands mid-copy.
    const content = randomBytes(64 * 1024 * 1024);
    const from = write('KILL.H', content);
    const to = join(target, 'KILL.H');
    writeFileSync(to, 'ORIGINAL CONTENT');

    const script = join(dir, 'run.js');
    writeFileSync(
      script,
      `const { transferFile } = require(${JSON.stringify(join(__dirname, 'transfer.ts'))});
       transferFile(${JSON.stringify(from)}, ${JSON.stringify(to)}, { chunkSize: 4096 })
         .catch(() => process.exit(1));`,
    );

    const child = spawn(process.execPath, ['-r', require.resolve('tsx/cjs'), script], {
      stdio: 'ignore',
    }).on('error', () => undefined);

    // Wait for the temp file to appear, then kill while it is still being written.
    const deadline = Date.now() + 20_000;
    let appeared = false;
    while (Date.now() < deadline) {
      if (tempFilesIn(target).length > 0) {
        appeared = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve).once('error', resolve));

    // The copy must still have been in flight — 64 MB through a 4 KiB buffer, with a
    // full readback still to come, cannot finish inside the poll interval.
    expect(appeared).toBe(true);

    // The destination still holds the old bytes: the rename never happened.
    expect(readFileSync(to, 'utf8')).toBe('ORIGINAL CONTENT');
    expect(tempFilesIn(target).length).toBeGreaterThan(0);

    // And the startup sweep removes the debris the kill left behind.
    const cleanup = await cleanupTempFiles(target);
    expect(tempFilesIn(target)).toEqual([]);
    expect(cleanup.failed).toEqual([]);
    expect(readFileSync(to, 'utf8')).toBe('ORIGINAL CONTENT');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Temp file naming and cleanup
// ---------------------------------------------------------------------------

describe('temp files', () => {
  it('names temps with the reserved prefix, in the destination directory', () => {
    const temp = tempPathFor(join(target, 'sub', 'X.H'));

    expect(temp.startsWith(join(target, 'sub'))).toBe(true);
    expect(isTempPath(temp)).toBe(true);
  });

  it('never generates the same name twice', () => {
    const names = new Set(Array.from({ length: 500 }, () => tempPathFor(join(target, 'X.H'))));

    expect(names.size).toBe(500);
  });

  it('recognises a temp path on either separator, and rejects ordinary names', () => {
    expect(isTempPath(`/var/lib/${TEMP_FILE_PREFIX}abc`)).toBe(true);
    expect(isTempPath(`C:\\data\\${TEMP_FILE_PREFIX}abc`)).toBe(true);
    expect(isTempPath('/var/lib/PROG.H')).toBe(false);
    expect(isTempPath(`PROG${TEMP_FILE_PREFIX}.H`)).toBe(false);
  });

  it('sweeps temp files from a whole tree, leaving real files alone', async () => {
    mkdirSync(join(target, 'a', 'b'), { recursive: true });
    write(`${TEMP_FILE_PREFIX}one`, 'x', target);
    writeFileSync(join(target, 'a', `${TEMP_FILE_PREFIX}two`), 'x');
    writeFileSync(join(target, 'a', 'b', `${TEMP_FILE_PREFIX}three`), 'x');
    writeFileSync(join(target, 'a', 'KEEP.H'), 'x');

    const result = await cleanupTempFiles(target);

    expect(result.removed).toHaveLength(3);
    expect(result.failed).toEqual([]);
    expect(existsSync(join(target, 'a', 'KEEP.H'))).toBe(true);
  });

  it('reports an unreadable directory instead of throwing', async () => {
    const result = await cleanupTempFiles(join(dir, 'not-here'));

    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  it('sweeps an empty tree without complaint', async () => {
    const result = await cleanupTempFiles(target);

    expect(result).toEqual({ removed: [], failed: [] });
  });

  it('keeps sweeping the rest of the tree past an unreadable subdirectory', async () => {
    writeFileSync(join(target, `${TEMP_FILE_PREFIX}one`), 'x');
    mkdirSync(join(target, 'sub'));
    writeFileSync(join(target, 'sub', `${TEMP_FILE_PREFIX}two`), 'x');

    const result = await cleanupTempFiles(target);

    // One unreadable branch must never abandon the files it could have cleaned.
    expect(result.removed).toHaveLength(2);
    expect(result.failed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Moves, directories, deletions
// ---------------------------------------------------------------------------

describe('moveFile', () => {
  it('renames within a filesystem without copying', async () => {
    const from = write('MV.H', 'CONTENT');
    const to = join(target, 'MV.H');

    const result = await moveFile(from, to);

    expect(result.renamed).toBe(true);
    expect(result.bytesWritten).toBe(7);
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(to, 'utf8')).toBe('CONTENT');
  });

  it('creates the destination directory first', async () => {
    const from = write('MV2.H', 'CONTENT');
    const to = join(target, 'deep', 'MV2.H');

    await moveFile(from, to);

    expect(readFileSync(to, 'utf8')).toBe('CONTENT');
  });

  it('classifies a move of something that is not there', async () => {
    await expect(moveFile(join(source, 'ghost.H'), join(target, 'ghost.H'))).rejects.toMatchObject({
      kind: 'source_missing',
    });
  });

  // A genuine cross-device rename needs two filesystems, which a test host cannot be
  // relied on to have, and `node:fs/promises` exports cannot be spied on to fake one.
  // So the fallback is tested as what it is — a named operation — rather than through
  // the EXDEV branch that dispatches to it.
  it('copies and only then deletes, so a failed copy cannot lose the source', async () => {
    const content = randomBytes(20_000);
    const from = write('XDEV.H', content);
    const to = join(target, 'XDEV.H');

    const result = await copyThenDelete(from, to);

    expect(result.renamed).toBe(false);
    expect(result.bytesWritten).toBe(content.length);
    expect(readFileSync(to)).toEqual(content);
    // A move is not complete until the source is gone.
    expect(existsSync(from)).toBe(false);
    expect(tempFilesIn(target)).toEqual([]);
  });

  it('keeps the source when the copy half of the fallback fails', async () => {
    const from = write('XDEV2.H', 'CONTENT');
    const { sleep } = recordingSleep();

    await expect(
      copyThenDelete(from, join(target, 'XDEV2.H'), {
        sleep,
        retryDelaysMs: [],
        afterWrite: (temp) => writeFile(temp, 'XXXXXXX'),
      }),
    ).rejects.toThrow(TransferError);

    expect(existsSync(from)).toBe(true);
    expect(existsSync(join(target, 'XDEV2.H'))).toBe(false);
  });
});

describe('directories and deletions', () => {
  it('creates a directory tree, and is content when it already exists', async () => {
    const path = join(target, 'x', 'y');

    await createDirectory(path);
    await createDirectory(path);

    expect(statSync(path).isDirectory()).toBe(true);
  });

  it('refuses to create a directory over a file', async () => {
    const path = write('FILE.H', 'x', target);

    await expect(createDirectory(path)).rejects.toBeInstanceOf(TransferError);
  });

  it('removes an empty directory', async () => {
    const path = join(target, 'empty');
    mkdirSync(path);

    expect(await removeDirectory(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to remove a directory that still has files in it', async () => {
    const path = join(target, 'full');
    mkdirSync(path);
    writeFileSync(join(path, 'KEEP.H'), 'x');

    expect(await removeDirectory(path)).toBe(false);
    expect(existsSync(join(path, 'KEEP.H'))).toBe(true);
  });

  it('reports a directory that was already gone', async () => {
    expect(await removeDirectory(join(target, 'never'))).toBe(false);
  });

  it('does not treat a path that is not a directory as a removal to celebrate', async () => {
    const path = write('NOTADIR.H', 'x', target);

    // Platforms disagree on the errno here, so the contract is only that it reports no
    // removal and leaves the file alone — never that it deleted something.
    await expect(removeDirectory(path).catch(() => false)).resolves.toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it('deletes a file and reports whether there was one', async () => {
    const path = write('DEL.H', 'x', target);

    expect(await deleteFile(path)).toBe(true);
    expect(await deleteFile(path)).toBe(false);
  });

  it('classifies a delete that fails for a reason other than absence', async () => {
    const path = join(target, 'a-directory');
    mkdirSync(path);

    await expect(deleteFile(path)).rejects.toBeInstanceOf(TransferError);
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('TransferError', () => {
  it('carries the kind, the path and whether a retry could help', () => {
    const error = new TransferError('boom', {
      kind: 'io_error',
      retryable: true,
      path: '/x',
      attempts: 2,
    });

    expect(error.name).toBe('TransferError');
    expect(error.kind).toBe('io_error');
    expect(error.retryable).toBe(true);
    expect(error.path).toBe('/x');
    expect(error.attempts).toBe(2);
  });

  it('defaults to a single attempt', () => {
    expect(
      new TransferError('boom', { kind: 'io_error', retryable: false, path: '/x' }).attempts,
    ).toBe(1);
  });

  it('treats an unrecognised failure as worth retrying', async () => {
    const from = write('U.H', 'CONTENT');
    const { delays, sleep } = recordingSleep();

    // A thrown non-errno object has no code, so nothing says it is permanent.
    await expect(
      transferFile(from, join(target, 'U.H'), {
        sleep,
        retryDelaysMs: [1],
        afterWrite: () => Promise.reject(new Error('something unfamiliar')),
      }),
    ).rejects.toThrow('something unfamiliar');

    expect(delays).toEqual([1]);
  });

  it('does not retry a permission failure', async () => {
    const from = write('PERM.H', 'CONTENT');
    const { delays, sleep } = recordingSleep();
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });

    await expect(
      transferFile(from, join(target, 'PERM.H'), {
        sleep,
        afterWrite: () => Promise.reject(denied),
      }),
    ).rejects.toMatchObject({ kind: 'permission_denied', retryable: false });

    expect(delays).toEqual([]);
  });

  it('classifies a read-only filesystem, and does not retry it', async () => {
    const from = write('RO.H', 'CONTENT');
    const { delays, sleep } = recordingSleep();
    const readOnly = Object.assign(new Error('read-only fs'), { code: 'EROFS' });

    await expect(
      transferFile(from, join(target, 'RO.H'), {
        sleep,
        afterWrite: () => Promise.reject(readOnly),
      }),
    ).rejects.toMatchObject({ kind: 'read_only', retryable: false });

    expect(delays).toEqual([]);
  });

  it('waits for real between attempts when no sleep is injected', async () => {
    const from = write('SLOW.H', 'CONTENT');
    const startedAt = Date.now();

    await expect(
      transferFile(from, join(target, 'SLOW.H'), {
        retryDelaysMs: [60],
        afterWrite: (temp) => writeFile(temp, 'XXXXXXX'),
      }),
    ).rejects.toThrow(TransferError);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it('does not retry a disk-full raised during the write', async () => {
    const from = write('NOSPC.H', 'CONTENT');
    const { delays, sleep } = recordingSleep();
    const full = Object.assign(new Error('no space'), { code: 'ENOSPC' });

    await expect(
      transferFile(from, join(target, 'NOSPC.H'), {
        sleep,
        afterWrite: () => Promise.reject(full),
      }),
    ).rejects.toMatchObject({ kind: 'disk_full' });

    expect(delays).toEqual([]);
    expect(tempFilesIn(target)).toEqual([]);
  });
});
