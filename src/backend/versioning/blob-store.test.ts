import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobCorruptError, BlobNotFoundError, BlobStore, assertHash } from './blob-store';

describe('BlobStore', () => {
  let root: string;
  let work: string;
  let store: BlobStore;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'tnc-blobs-'));
    root = join(base, 'versions');
    work = join(base, 'work');
    await writeFile(join(base, '.keep'), '');
    store = new BlobStore({ root });
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  const writeSource = async (name: string, content: string | Buffer): Promise<string> => {
    const path = join(work, name);
    await rm(path, { force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(work, { recursive: true });
    await writeFile(path, content);
    return path;
  };

  describe('addressing', () => {
    it('rejects anything that is not a sha256 digest', () => {
      expect(() => assertHash('../../etc/passwd')).toThrow(/Not a SHA-256 digest/);
      expect(() => assertHash('ABCDEF')).toThrow();
      expect(() => assertHash('a'.repeat(63))).toThrow();
      expect(() => assertHash('a'.repeat(64))).not.toThrow();
    });

    it('fans out on the first two byte-pairs of the digest', async () => {
      const source = await writeSource('a.h', 'BEGIN PGM A MM');
      const blob = await store.putFile(source);

      const expected = join(root, blob.hash.slice(0, 2), blob.hash.slice(2, 4), blob.hash);
      await expect(readFile(expected, 'utf8')).resolves.toBe('BEGIN PGM A MM');
    });
  });

  describe('deduplication', () => {
    it('stores identical content exactly once', async () => {
      const first = await writeSource('one.h', 'IDENTICAL');
      const second = await writeSource('two.h', 'IDENTICAL');

      const a = await store.putFile(first);
      const b = await store.putFile(second);

      expect(a.hash).toBe(b.hash);
      expect(a.created).toBe(true);
      expect(b.created).toBe(false);
      await expect(store.stats()).resolves.toMatchObject({ blobs: 1 });
    });

    it('gives different content different addresses', async () => {
      const a = await store.putFile(await writeSource('a.h', 'ONE'));
      const b = await store.putFile(await writeSource('b.h', 'TWO'));

      expect(a.hash).not.toBe(b.hash);
      await expect(store.stats()).resolves.toMatchObject({ blobs: 2 });
    });
  });

  describe('compression', () => {
    it('leaves small blobs uncompressed', async () => {
      const blob = await store.putFile(await writeSource('small.h', 'tiny'));
      expect(blob.compressed).toBe(false);
    });

    it('compresses above the threshold and still reads back byte-identical', async () => {
      // Highly compressible, so the gzipped form is unambiguously smaller.
      const big = 'G01 X1 Y1\n'.repeat(200_000);
      const small = new BlobStore({ root, compressThresholdBytes: 1024 });
      const blob = await small.putFile(await writeSource('big.h', big));

      expect(blob.compressed).toBe(true);
      expect(blob.storedSize).toBeLessThan(blob.size);
      expect(blob.size).toBe(Buffer.byteLength(big));

      const readBack = await small.readAll(blob.hash);
      expect(readBack.toString('utf8')).toBe(big);
    });

    it('addresses a blob by its uncompressed digest regardless of compression', async () => {
      const content = 'X'.repeat(5000);
      const uncompressed = new BlobStore({ root: join(root, 'u'), compressThresholdBytes: 0 });
      const compressed = new BlobStore({ root: join(root, 'c'), compressThresholdBytes: 10 });

      const a = await uncompressed.putFile(await writeSource('x.h', content));
      const b = await compressed.putFile(await writeSource('x2.h', content));

      expect(a.compressed).toBe(false);
      expect(b.compressed).toBe(true);
      expect(a.hash).toBe(b.hash);
    });
  });

  describe('extractTo', () => {
    it('writes the original bytes back', async () => {
      const blob = await store.putFile(await writeSource('p.h', 'BEGIN PGM P MM\nEND PGM P MM\n'));
      const out = join(work, 'restored', 'p.h');

      const written = await store.extractTo(blob.hash, out);

      expect(written).toBe(blob.size);
      await expect(readFile(out, 'utf8')).resolves.toBe('BEGIN PGM P MM\nEND PGM P MM\n');
    });

    it('refuses to produce a file when the stored blob no longer matches its address', async () => {
      const blob = await store.putFile(await writeSource('t.h', 'ORIGINAL'));
      // Corrupt the blob in place, keeping its filename — the exact silent-corruption
      // case content addressing exists to catch.
      await writeFile(store.rawPathOf(blob.hash), 'TAMPERED');

      const out = join(work, 'out.h');
      await expect(store.extractTo(blob.hash, out)).rejects.toThrow(BlobCorruptError);
      await expect(readFile(out, 'utf8')).rejects.toThrow();
    });

    it('throws for an unknown digest', async () => {
      await expect(store.extractTo('a'.repeat(64), join(work, 'nope'))).rejects.toThrow(
        BlobNotFoundError,
      );
    });
  });

  describe('verify', () => {
    it('accepts an intact blob and rejects a tampered one', async () => {
      const blob = await store.putFile(await writeSource('v.h', 'CONTENT'));
      await expect(store.verify(blob.hash)).resolves.toBe(true);

      await writeFile(store.rawPathOf(blob.hash), 'DIFFERENT');
      await expect(store.verify(blob.hash)).resolves.toBe(false);
    });

    it('reports false for a missing blob rather than throwing', async () => {
      await expect(store.verify('b'.repeat(64))).resolves.toBe(false);
    });
  });

  describe('delete', () => {
    it('removes the blob and prunes the empty fan-out directories', async () => {
      const blob = await store.putFile(await writeSource('d.h', 'DELETE ME'));

      await expect(store.delete(blob.hash)).resolves.toBe(true);
      await expect(store.has(blob.hash)).resolves.toBe(false);
      await expect(store.stats()).resolves.toMatchObject({ blobs: 0 });
    });

    it('returns false when the blob was already gone', async () => {
      await expect(store.delete('c'.repeat(64))).resolves.toBe(false);
    });
  });

  describe('housekeeping', () => {
    it('lists every stored digest', async () => {
      const a = await store.putFile(await writeSource('l1.h', 'A'));
      const b = await store.putFile(await writeSource('l2.h', 'B'));

      await expect(store.list()).resolves.toEqual(expect.arrayContaining([a.hash, b.hash]));
    });

    it('sweeps temp files left behind by a crash mid-write', async () => {
      const blob = await store.putFile(await writeSource('s.h', 'KEEP'));
      const stray = `${store.rawPathOf(blob.hash)}.999.1.tmp`;
      await writeFile(stray, 'PARTIAL');

      await expect(store.sweepTemp()).resolves.toBe(1);
      await expect(store.has(blob.hash)).resolves.toBe(true);
    });

    it('reports an empty store rather than failing when the root does not exist', async () => {
      const missing = new BlobStore({ root: join(root, 'never-created') });
      await expect(missing.stats()).resolves.toEqual({ blobs: 0, bytesOnDisk: 0 });
      await expect(missing.list()).resolves.toEqual([]);
    });
  });

  describe('putBuffer', () => {
    it('agrees with putFile on the digest for the same content', async () => {
      const content = Buffer.from('SHARED CONTENT');
      const viaFile = await store.putFile(await writeSource('b1.h', content));
      const viaBuffer = await store.putBuffer(content);

      expect(viaBuffer.hash).toBe(viaFile.hash);
      expect(viaBuffer.created).toBe(false);
    });
  });
});
