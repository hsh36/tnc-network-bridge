import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { BlobStore } from './blob-store';
import {
  PathTraversalError,
  VersionNotFoundError,
  VersionStore,
  resolveWithinRoot,
} from './version-store';

let db: Db;
let store: VersionStore;
let blobs: BlobStore;
let cacheRoot: string;
let shareId: number;
let clock: number;

async function writeCacheFile(relPath: string, content: string): Promise<string> {
  const absolute = join(cacheRoot, relPath);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
  return absolute;
}

beforeEach(async () => {
  db = tmpDb();
  runMigrations(db);
  clock = 1_700_000_000;

  const base = tmpDir('tnc-versions-');
  cacheRoot = join(base, 'cache');
  await mkdir(cacheRoot, { recursive: true });
  blobs = new BlobStore({ root: join(base, 'versions') });
  store = new VersionStore({ db, blobs, now: () => clock });

  shareId = Number(
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES ('programs', '//fs/cnc$', '/mnt/tnc-server/programs', @cache, @now, @now)`,
      { now: clock, cache: cacheRoot },
    ).lastInsertRowid,
  );
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('resolveWithinRoot', () => {
  it('resolves an ordinary relative path', () => {
    expect(resolveWithinRoot('/srv/tnc/programs', 'PGM/PART1.H')).toContain('PART1.H');
  });

  it('refuses a path that escapes via ..', () => {
    expect(() => resolveWithinRoot('/srv/tnc/programs', '../../etc/passwd')).toThrow(
      PathTraversalError,
    );
  });

  it('refuses an escape that normalises out of the root without a leading ..', () => {
    // `a/../../b` contains no leading `..` yet still escapes — which is why the check is
    // on the resolved path, not on the text.
    expect(() => resolveWithinRoot('/srv/tnc/programs', 'a/../../b')).toThrow(PathTraversalError);
  });

  it('refuses an absolute path', () => {
    expect(() => resolveWithinRoot('/srv/tnc/programs', '/etc/passwd')).toThrow(PathTraversalError);
  });

  it('refuses a NUL byte', () => {
    expect(() => resolveWithinRoot('/srv/tnc/programs', 'ok\0.h')).toThrow(PathTraversalError);
  });

  it('allows a path that merely mentions .. inside a filename', () => {
    expect(() => resolveWithinRoot('/srv/tnc/programs', 'PGM/..keep.H')).not.toThrow();
  });
});

describe('capture', () => {
  it('stores the bytes and records the metadata together', async () => {
    const source = await writeCacheFile('PART1.H', 'BEGIN PGM PART1 MM');

    const { version, deduplicated } = await store.capture({
      shareId,
      relPath: 'PART1.H',
      sourcePath: source,
      origin: 'server',
      reason: 'initial import',
    });

    expect(version.shareId).toBe(shareId);
    expect(version.relPath).toBe('PART1.H');
    expect(version.size).toBe(18);
    expect(version.origin).toBe('server');
    expect(version.reason).toBe('initial import');
    expect(version.pinned).toBe(false);
    expect(deduplicated).toBe(false);
    await expect(blobs.has(version.hash)).resolves.toBe(true);
  });

  it('shares one blob between repeated captures of unchanged content', async () => {
    const source = await writeCacheFile('PART1.H', 'UNCHANGED');

    const first = await store.capture({
      shareId,
      relPath: 'PART1.H',
      sourcePath: source,
      origin: 'server',
    });
    clock += 60;
    const second = await store.capture({
      shareId,
      relPath: 'PART1.H',
      sourcePath: source,
      origin: 'tnc',
    });

    // Two rows of genuine history, one blob.
    expect(second.version.id).not.toBe(first.version.id);
    expect(second.version.hash).toBe(first.version.hash);
    expect(second.deduplicated).toBe(true);
    await expect(blobs.stats()).resolves.toMatchObject({ blobs: 1 });
  });

  it('never leaves a row whose blob is absent', async () => {
    const source = await writeCacheFile('PART1.H', 'CONTENT');
    const { version } = await store.capture({
      shareId,
      relPath: 'PART1.H',
      sourcePath: source,
      origin: 'server',
    });

    const rows = db.all<{ hash: string }>('SELECT hash FROM file_versions');
    for (const row of rows) {
      await expect(blobs.has(row.hash)).resolves.toBe(true);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hash).toBe(version.hash);
  });
});

describe('list', () => {
  it('returns history newest first', async () => {
    const source = await writeCacheFile('P.H', 'V1');
    await store.capture({ shareId, relPath: 'P.H', sourcePath: source, origin: 'server' });
    clock += 100;
    await writeFile(source, 'V2');
    await store.capture({ shareId, relPath: 'P.H', sourcePath: source, origin: 'tnc' });

    const page = store.list({ shareId, relPath: 'P.H' });

    expect(page.total).toBe(2);
    expect(page.items[0]?.origin).toBe('tnc');
    expect(page.items[1]?.origin).toBe('server');
  });

  it('narrows by share and by path', async () => {
    const a = await writeCacheFile('A.H', 'A');
    const b = await writeCacheFile('B.H', 'B');
    await store.capture({ shareId, relPath: 'A.H', sourcePath: a, origin: 'server' });
    await store.capture({ shareId, relPath: 'B.H', sourcePath: b, origin: 'server' });

    expect(store.list({ shareId }).total).toBe(2);
    expect(store.list({ shareId, relPath: 'A.H' }).total).toBe(1);
  });

  it('paginates without losing the total', async () => {
    const source = await writeCacheFile('P.H', 'X');
    for (let i = 0; i < 5; i += 1) {
      await writeFile(source, `V${String(i)}`);
      clock += 10;
      await store.capture({ shareId, relPath: 'P.H', sourcePath: source, origin: 'server' });
    }

    const page = store.list({ shareId, limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
  });
});

describe('pinning', () => {
  it('pins and unpins', async () => {
    const source = await writeCacheFile('P.H', 'PIN ME');
    const { version } = await store.capture({
      shareId,
      relPath: 'P.H',
      sourcePath: source,
      origin: 'server',
    });

    expect(store.setPinned(version.id, true).pinned).toBe(true);
    expect(store.setPinned(version.id, false).pinned).toBe(false);
  });
});

describe('restore', () => {
  it('writes the old content back and captures the pre-image first', async () => {
    const source = await writeCacheFile('P.H', 'ORIGINAL');
    const { version } = await store.capture({
      shareId,
      relPath: 'P.H',
      sourcePath: source,
      origin: 'server',
    });

    clock += 100;
    await writeFile(source, 'EDITED ON THE MACHINE');

    const result = await store.restore(version.id, { cacheRoot });

    expect(result.restoredTo).toBe('P.H');
    await expect(readFile(source, 'utf8')).resolves.toBe('ORIGINAL');

    // The pre-image makes the restore itself reversible.
    expect(result.preRestoreVersionId).toBeGreaterThan(0);
    const preImage = store.require(result.preRestoreVersionId);
    expect(preImage.origin).toBe('restore');
    await expect(blobs.readAll(preImage.hash)).resolves.toEqual(
      Buffer.from('EDITED ON THE MACHINE'),
    );
  });

  it('restores to an alternate path, leaving the original untouched', async () => {
    const source = await writeCacheFile('P.H', 'ORIGINAL');
    const { version } = await store.capture({
      shareId,
      relPath: 'P.H',
      sourcePath: source,
      origin: 'server',
    });
    await writeFile(source, 'CURRENT');

    const result = await store.restore(version.id, { cacheRoot, targetPath: 'P.RESTORED.H' });

    expect(result.restoredTo).toBe('P.RESTORED.H');
    await expect(readFile(join(cacheRoot, 'P.RESTORED.H'), 'utf8')).resolves.toBe('ORIGINAL');
    await expect(readFile(source, 'utf8')).resolves.toBe('CURRENT');
  });

  it('restores a deleted file, with no pre-image to capture', async () => {
    const source = await writeCacheFile('GONE.H', 'CONTENT');
    const { version } = await store.capture({
      shareId,
      relPath: 'GONE.H',
      sourcePath: source,
      origin: 'server',
    });
    const { rm } = await import('node:fs/promises');
    await rm(source);

    const result = await store.restore(version.id, { cacheRoot });

    expect(result.preRestoreVersionId).toBe(0);
    await expect(readFile(source, 'utf8')).resolves.toBe('CONTENT');
  });

  it('refuses a target path that escapes the cache root', async () => {
    const source = await writeCacheFile('P.H', 'X');
    const { version } = await store.capture({
      shareId,
      relPath: 'P.H',
      sourcePath: source,
      origin: 'server',
    });

    await expect(
      store.restore(version.id, { cacheRoot, targetPath: '../../etc/cron.d/evil' }),
    ).rejects.toThrow(PathTraversalError);
  });

  it('throws for an unknown version', async () => {
    await expect(store.restore(9999, { cacheRoot })).rejects.toThrow(VersionNotFoundError);
  });
});

describe('delete', () => {
  it('drops the blob once the last row referencing it is gone', async () => {
    const source = await writeCacheFile('P.H', 'ONLY COPY');
    const { version } = await store.capture({
      shareId,
      relPath: 'P.H',
      sourcePath: source,
      origin: 'server',
    });

    await expect(store.delete(version.id)).resolves.toEqual({ blobDeleted: true });
    await expect(blobs.has(version.hash)).resolves.toBe(false);
  });

  it('keeps the blob while another version still shares the content', async () => {
    const source = await writeCacheFile('P.H', 'SHARED');
    const first = await store.capture({
      shareId,
      relPath: 'P.H',
      sourcePath: source,
      origin: 'server',
    });
    clock += 10;
    const second = await store.capture({
      shareId,
      relPath: 'OTHER.H',
      sourcePath: source,
      origin: 'server',
    });

    expect(second.version.hash).toBe(first.version.hash);

    await expect(store.delete(first.version.id)).resolves.toEqual({ blobDeleted: false });
    // The surviving version must still be restorable.
    await expect(blobs.has(second.version.hash)).resolves.toBe(true);
    await expect(blobs.readAll(second.version.hash)).resolves.toEqual(Buffer.from('SHARED'));
  });
});

describe('reference tracking', () => {
  it('reports version ids cited by a conflict row', async () => {
    const source = await writeCacheFile('P.H', 'LOSER');
    const { version } = await store.capture({
      shareId,
      relPath: 'P.H',
      sourcePath: source,
      origin: 'conflict_loser',
    });

    db.run(
      `INSERT INTO conflicts (ts, share_id, rel_path, mode_applied, winner, loser_version_id)
       VALUES (@ts, @shareId, 'P.H', 'last_write_wins', 'remote', @versionId)`,
      { ts: clock, shareId, versionId: version.id },
    );

    expect(store.referencedVersionIds()).toEqual(new Set([version.id]));
  });

  it('reports the live digest set for the orphan sweep', async () => {
    const source = await writeCacheFile('P.H', 'LIVE');
    const { version } = await store.capture({
      shareId,
      relPath: 'P.H',
      sourcePath: source,
      origin: 'server',
    });

    expect(store.liveHashes()).toEqual(new Set([version.hash]));
  });
});

describe('lookup performance', () => {
  it('answers a per-file history query in well under 100ms with a large store', async () => {
    const source = await writeCacheFile('HOT.H', 'seed');
    // 2000 rows across 200 paths; the index prefix pins both filter columns, so the
    // query is a range scan rather than a table scan.
    db.transaction(() => {
      for (let i = 0; i < 2000; i += 1) {
        db.run(
          `INSERT INTO file_versions (share_id, rel_path, hash, size, mtime, origin, created_at, pinned)
           VALUES (@shareId, @relPath, @hash, 10, 0, 'server', @createdAt, 0)`,
          {
            shareId,
            relPath: `PGM/P${String(i % 200)}.H`,
            hash: String(i).padStart(64, '0'),
            createdAt: clock - i,
          },
        );
      }
    });
    expect(source).toContain('HOT.H');

    const started = performance.now();
    const page = store.list({ shareId, relPath: 'PGM/P7.H' });
    const elapsed = performance.now() - started;

    expect(page.total).toBe(10);
    expect(elapsed).toBeLessThan(100);
  });
});
