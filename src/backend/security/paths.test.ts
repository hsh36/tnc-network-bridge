import { join, resolve, sep } from 'node:path';
import {
  isSuspiciousName,
  isWithin,
  PathTraversalError,
  safeResolve,
  trySafeResolve,
} from './paths';

const ROOT = resolve(sep, 'srv', 'tnc', 'programs');

describe('isWithin', () => {
  it('accepts the root itself', () => {
    expect(isWithin(ROOT, ROOT)).toBe(true);
  });

  it('accepts a path beneath the root', () => {
    expect(isWithin(ROOT, join(ROOT, 'PGM', 'PART1.H'))).toBe(true);
  });

  it('rejects a sibling directory', () => {
    expect(isWithin(ROOT, resolve(sep, 'srv', 'tnc', 'other'))).toBe(false);
  });

  it('rejects a sibling whose name merely starts with the root', () => {
    // The classic prefix bug: "/srv/tnc/programs-backup" starts with the root string
    // but is not inside it. Requiring the separator is what catches this.
    expect(isWithin(ROOT, `${ROOT}-backup`)).toBe(false);
  });
});

describe('safeResolve', () => {
  it('resolves an ordinary relative path', () => {
    expect(safeResolve(ROOT, 'PGM/PART1.H')).toBe(join(ROOT, 'PGM', 'PART1.H'));
  });

  it('resolves a nested path', () => {
    expect(safeResolve(ROOT, 'A/B/C/D.H')).toBe(join(ROOT, 'A', 'B', 'C', 'D.H'));
  });

  it('allows .. that stays inside the root', () => {
    expect(safeResolve(ROOT, 'A/../B.H')).toBe(join(ROOT, 'B.H'));
  });

  describe('traversal', () => {
    it('rejects a leading ..', () => {
      expect(() => safeResolve(ROOT, '../../etc/passwd')).toThrow(PathTraversalError);
    });

    it('rejects an escape that normalises out without a leading ..', () => {
      // Starts with an ordinary segment, still escapes. A textual check for a leading
      // ".." passes this straight through.
      expect(() => safeResolve(ROOT, 'a/../../b')).toThrow(PathTraversalError);
    });

    it('rejects an absolute path', () => {
      expect(() => safeResolve(ROOT, resolve(sep, 'etc', 'passwd'))).toThrow(PathTraversalError);
    });

    it('rejects a NUL byte', () => {
      // A NUL truncates at the syscall boundary, so the string checked and the path
      // opened would be different things.
      expect(() => safeResolve(ROOT, 'safe.h\0../../etc/passwd')).toThrow(PathTraversalError);
    });

    it('rejects a Windows drive-relative path', () => {
      // `C:foo` resolves against that drive's current directory, not the root.
      expect(() => safeResolve(ROOT, 'C:evil.h')).toThrow(PathTraversalError);
    });

    it('rejects an empty path', () => {
      expect(() => safeResolve(ROOT, '')).toThrow(PathTraversalError);
    });

    it('rejects a deep chain of ..', () => {
      expect(() => safeResolve(ROOT, '../'.repeat(20) + 'etc/passwd')).toThrow(PathTraversalError);
    });
  });

  describe('paths that only look dangerous', () => {
    it('allows a filename beginning with dots', () => {
      // `..keep.H` is an ordinary filename; a textual ".." check would refuse it.
      expect(() => safeResolve(ROOT, 'PGM/..keep.H')).not.toThrow();
    });

    it('allows a hidden file', () => {
      expect(() => safeResolve(ROOT, '.tnc-index')).not.toThrow();
    });

    it('allows a filename containing the word etc', () => {
      expect(() => safeResolve(ROOT, 'etcetera.H')).not.toThrow();
    });
  });

  it('names the offending path in the error', () => {
    try {
      safeResolve(ROOT, '../escape');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PathTraversalError);
      expect((err as PathTraversalError).attempted).toBe('../escape');
    }
  });
});

describe('trySafeResolve', () => {
  it('returns the path when it is safe', () => {
    expect(trySafeResolve(ROOT, 'A.H')).toBe(join(ROOT, 'A.H'));
  });

  it('returns null instead of throwing for a bad path', () => {
    // Bulk callers skip and count rather than raising one exception per file.
    expect(trySafeResolve(ROOT, '../../etc/passwd')).toBeNull();
  });
});

describe('isSuspiciousName', () => {
  it('accepts ordinary NC filenames', () => {
    for (const name of ['PART1.H', 'part1.h', 'TOOL_TABLE.TAB', '1234.I', '..keep.H']) {
      expect(isSuspiciousName(name)).toBe(false);
    }
  });

  it('rejects the directory entries', () => {
    expect(isSuspiciousName('.')).toBe(true);
    expect(isSuspiciousName('..')).toBe(true);
  });

  it('rejects an empty name', () => {
    expect(isSuspiciousName('')).toBe(true);
  });

  it('rejects a NUL byte', () => {
    expect(isSuspiciousName('a\0b')).toBe(true);
  });

  it('rejects Windows reserved device names', () => {
    // Legal on Linux, but writing one to a Windows client can hang it on open — a
    // denial of service delivered by filename.
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1', 'CON.H']) {
      expect(isSuspiciousName(name)).toBe(true);
    }
  });

  it('allows a name that merely starts with a reserved word', () => {
    expect(isSuspiciousName('CONTROL.H')).toBe(false);
    expect(isSuspiciousName('COMPANY.H')).toBe(false);
  });

  it('rejects trailing dots and spaces', () => {
    // Windows strips these silently, so two distinct Linux names collide into one.
    expect(isSuspiciousName('PART1.H ')).toBe(true);
    expect(isSuspiciousName('PART1.')).toBe(true);
  });
});
