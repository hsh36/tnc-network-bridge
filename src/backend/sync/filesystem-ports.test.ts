import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDir } from '../../../tests/support/tmp-db';

import { FilesystemSyncPorts } from './filesystem-ports';

/**
 * The ports are where the engine meets a filesystem, so what is worth testing is the
 * translation: what counts as present, what counts as absent, and which of those two an
 * unreachable mount is. Getting the last one wrong deletes a customer's files.
 */

let cachePath: string;
let mountPoint: string;

function ports(overrides: Partial<ConstructorParameters<typeof FilesystemSyncPorts>[0]> = {}) {
  return new FilesystemSyncPorts({
    shareId: 1,
    cachePath,
    mountPoint,
    excludePatterns: [],
    maxFileSizeMb: 512,
    serverOnline: () => true,
    ...overrides,
  });
}

function write(root: string, relPath: string, content: string): void {
  const absolute = join(root, relPath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

beforeEach(() => {
  cachePath = tmpDir('tnc-cache-');
  mountPoint = tmpDir('tnc-mount-');
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('listPaths', () => {
  it('unions both sides and reports POSIX-relative paths', async () => {
    write(cachePath, 'only-local.h', 'a');
    write(mountPoint, 'only-remote.h', 'b');
    write(cachePath, 'programs/shared.h', 'c');
    write(mountPoint, 'programs/shared.h', 'c');

    expect(await ports().listPaths()).toEqual([
      'only-local.h',
      'only-remote.h',
      'programs/shared.h',
    ]);
  });

  it('hides our own in-flight temp files', async () => {
    write(cachePath, '.tnc-tmp-part.h', 'half a file');
    write(cachePath, 'part.h', 'a');

    // A temp file is a transfer in progress. Listing it would make the engine try to
    // sync a partial copy of something it is already copying.
    expect(await ports().listPaths()).toEqual(['part.h']);
  });

  it('reports nothing from a mount point that does not exist', async () => {
    write(cachePath, 'part.h', 'a');

    const found = await ports({ mountPoint: join(mountPoint, 'not-mounted') }).listPaths();

    // An unreachable mount must look like "nothing to say". If it read as an empty
    // share, every local file would look server-deleted.
    expect(found).toEqual(['part.h']);
  });
});

describe('stat', () => {
  it('reports size and mtime for a file that is there', async () => {
    write(cachePath, 'part.h', 'hello');

    const side = await ports().statLocal('part.h');

    expect(side?.size).toBe(5);
    expect(side?.mtime).toBeGreaterThan(0);
  });

  it('reports null for a file that is not', async () => {
    expect(await ports().statLocal('missing.h')).toBeNull();
  });

  it('reports a directory as absent rather than as a file', async () => {
    mkdirSync(join(cachePath, 'programs'), { recursive: true });
    expect(await ports().statLocal('programs')).toBeNull();
  });

  it('treats a file over the size ceiling as absent', async () => {
    write(cachePath, 'huge.h', 'x'.repeat(2048));

    // Reporting it as present would make the diff want to copy it on every cycle, for
    // ever, against a rule that forbids copying it at all.
    expect(await ports({ maxFileSizeMb: 0.001 }).statLocal('huge.h')).toBeNull();
  });
});

describe('push and pull', () => {
  it('copies local to remote', async () => {
    write(cachePath, 'programs/part.h', 'from the machine');

    await ports().push('programs/part.h');

    expect(readFileSync(join(mountPoint, 'programs/part.h'), 'utf8')).toBe('from the machine');
  });

  it('copies remote to local, creating directories on the way', async () => {
    write(mountPoint, 'deep/nested/part.h', 'from the server');

    await ports().pull('deep/nested/part.h');

    expect(readFileSync(join(cachePath, 'deep/nested/part.h'), 'utf8')).toBe('from the server');
  });
});

describe('delete', () => {
  it('removes from the side it was asked about, and only that side', async () => {
    write(cachePath, 'part.h', 'a');
    write(mountPoint, 'part.h', 'a');

    await ports().deleteLocal('part.h');

    expect(await ports().statLocal('part.h')).toBeNull();
    expect(await ports().statRemote('part.h')).not.toBeNull();
  });

  it('is not an error when the file is already gone', async () => {
    await expect(ports().deleteLocal('never-existed.h')).resolves.toBeUndefined();
  });
});

describe('deleteRemote', () => {
  it('removes from the server side only', async () => {
    write(cachePath, 'part.h', 'a');
    write(mountPoint, 'part.h', 'a');

    await ports().deleteRemote('part.h');

    expect(await ports().statRemote('part.h')).toBeNull();
    expect(await ports().statLocal('part.h')).not.toBeNull();
  });
});

describe('captureVersion', () => {
  it('hands the versioning engine the side it was told about', async () => {
    write(cachePath, 'part.h', 'local copy');
    write(mountPoint, 'part.h', 'server copy');
    const seen: { relPath: string; sourcePath: string; side: string }[] = [];
    const versioning = {
      handleOrchestratorCapture: (
        _shareId: number,
        relPath: string,
        sourcePath: string,
        capture: { side: string },
      ) => {
        seen.push({ relPath, sourcePath, side: capture.side });
      },
    } as unknown as NonNullable<ConstructorParameters<typeof FilesystemSyncPorts>[0]['versioning']>;

    const p = ports({ versioning });
    await p.captureVersion('part.h', { side: 'local', reason: 'overwrite' });
    await p.captureVersion('part.h', { side: 'remote', reason: 'conflict_loser' });

    // The path matters as much as the side: capturing the wrong copy stores the file
    // that is about to survive rather than the one about to be lost.
    expect(seen[0]?.sourcePath).toBe(join(cachePath, 'part.h'));
    expect(seen[1]?.sourcePath).toBe(join(mountPoint, 'part.h'));
  });

  it('is a no-op when versioning is not configured', async () => {
    await expect(
      ports().captureVersion('part.h', { side: 'local', reason: 'delete' }),
    ).resolves.toBeUndefined();
  });
});

describe('isLocked', () => {
  it('reports false when there is no lock manager', () => {
    expect(ports().isLocked('part.h')).toBe(false);
  });

  it('asks the lock manager about the share it belongs to', () => {
    const locks = {
      list: () => ({ items: [{ relPath: 'held.h' }], total: 1 }),
    } as unknown as NonNullable<ConstructorParameters<typeof FilesystemSyncPorts>[0]['locks']>;

    const p = ports({ locks });

    // A file a machine holds open must not be overwritten under it.
    expect(p.isLocked('held.h')).toBe(true);
    expect(p.isLocked('free.h')).toBe(false);
  });
});

describe('hasCaseCollision', () => {
  it('reports none without an index to compare against', () => {
    // Claiming a collision with nothing to compare would stall every path.
    expect(ports().hasCaseCollision()).toBe(false);
  });
});

describe('isExcluded', () => {
  it('matches the share patterns', () => {
    const p = ports({ excludePatterns: ['**/*.bak', '**/Thumbs.db'] });

    expect(p.isExcluded('programs/part.bak')).toBe(true);
    expect(p.isExcluded('programs/Thumbs.db')).toBe(true);
    // `**/` matches zero directories too, so the pattern also covers the share root.
    // That is what the shipped defaults rely on: a Thumbs.db sitting at the top of a
    // share is exactly as unwanted as one in a subfolder.
    expect(p.isExcluded('Thumbs.db')).toBe(true);
    expect(p.isExcluded('programs/part.h')).toBe(false);
  });

  it('excludes nothing when no patterns are configured', () => {
    expect(ports().isExcluded('anything.h')).toBe(false);
  });
});

describe('isServerOnline', () => {
  it('reports what it was told, because only the mount knows', async () => {
    expect(await ports({ serverOnline: () => false }).isServerOnline()).toBe(false);
    expect(await ports({ serverOnline: () => true }).isServerOnline()).toBe(true);
  });
});
