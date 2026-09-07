import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { removeSidecar, sidecarAbsolutePath, sidecarRelPath, writeSidecar } from './sidecar';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tnc-sidecar-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sidecarRelPath', () => {
  it('names the marker after the basename, at the file root', () => {
    expect(sidecarRelPath('PART1.H')).toBe('.~lock.PART1.H#');
  });

  it('keeps the marker inside the same directory as the file', () => {
    expect(sidecarRelPath('programs/sub/PART1.H')).toBe('programs/sub/.~lock.PART1.H#');
  });
});

describe('writeSidecar / removeSidecar', () => {
  it('creates a readable marker file next to the target', () => {
    const result = writeSidecar(dir, 'PART1.H', 'locked\n');
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, '.~lock.PART1.H#'))).toBe(true);
    expect(readFileSync(join(dir, '.~lock.PART1.H#'), 'utf8')).toBe('locked\n');
  });

  it('removes the marker file', () => {
    writeSidecar(dir, 'PART1.H', 'locked\n');
    const result = removeSidecar(dir, 'PART1.H');
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, '.~lock.PART1.H#'))).toBe(false);
  });

  it('treats removing an absent marker as success', () => {
    const result = removeSidecar(dir, 'NEVER-LOCKED.H');
    expect(result.ok).toBe(true);
  });

  it('reports failure without throwing when the parent directory does not exist', () => {
    const result = writeSidecar(join(dir, 'missing-subdir'), 'PART1.H', 'locked\n');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('resolves the absolute path deterministically', () => {
    // Paths are always joined POSIX-style, matching the production target (the
    // bridge only ever runs on Raspberry Pi OS) regardless of the host running tests.
    expect(sidecarAbsolutePath(dir, 'a/b/FILE.I')).toBe(posix.join(dir, 'a/b/.~lock.FILE.I#'));
  });
});
