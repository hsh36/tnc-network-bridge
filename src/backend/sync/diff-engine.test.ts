import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ConflictMode } from '../../shared/schemas/config';
import { type FileSide } from '../../shared/schemas/file-index';
import {
  DEFAULT_DIFF_CONFIG,
  HEIDENHAIN_EXTENSIONS,
  VERDICT_ACTIONS,
  classifySide,
  decide,
  destroysData,
  type DiffConfig,
  type DiffInput,
  type Side,
  isCp850Encodable,
  needsCapture,
  sameContent,
  validateHeidenhainName,
} from './diff-engine';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A valid xxhash64 digest built from one hex nibble, so fixtures read at a glance. */
const h = (nibble: string): string => nibble.repeat(16);

const side = (size: number, mtime: number, hash: string | null = null): FileSide => ({
  size,
  mtime,
  hash,
});

const cfg = (over: Partial<DiffConfig> = {}): DiffConfig => ({
  ...DEFAULT_DIFF_CONFIG,
  relPath: 'PROG.H',
  ...over,
});

const run = (
  local: Side,
  remote: Side,
  base: Side,
  over: Partial<DiffConfig> = {},
): ReturnType<typeof decide> => decide({ local, remote, base, config: cfg(over) });

// ---------------------------------------------------------------------------
// Comparison primitives
// ---------------------------------------------------------------------------

describe('sameContent', () => {
  it('lets hashes decide when both sides have one, ignoring size and mtime', () => {
    // Same hash but wildly different metadata: the hash is authoritative.
    expect(sameContent(side(10, 100, h('a')), side(999, 5_000, h('a')))).toBe(true);
    expect(sameContent(side(10, 100, h('a')), side(10, 100, h('b')))).toBe(false);
  });

  it('falls back to (size, mtime) when either hash is missing', () => {
    expect(sameContent(side(10, 100, null), side(10, 100, h('a')))).toBe(true);
    expect(sameContent(side(10, 100, h('a')), side(10, 100, null))).toBe(true);
    expect(sameContent(side(10, 100), side(10, 100))).toBe(true);
  });

  it('treats a differing size or mtime as different content', () => {
    expect(sameContent(side(10, 100), side(11, 100))).toBe(false);
    expect(sameContent(side(10, 100), side(10, 101))).toBe(false);
  });

  it('compares mtime exactly, so an edit inside the tie tolerance is still a change', () => {
    // The tolerance breaks conflict ties; using it here would silently swallow an edit.
    expect(sameContent(side(10, 100), side(10, 100 + 1_999))).toBe(false);
  });
});

describe('classifySide', () => {
  it('reports absent when neither the side nor the base exists', () => {
    expect(classifySide(null, null)).toBe('absent');
  });

  it('reports created when there is no base', () => {
    expect(classifySide(side(1, 1), null)).toBe('created');
  });

  it('reports deleted when a base existed and the side does not', () => {
    expect(classifySide(null, side(1, 1))).toBe('deleted');
  });

  it('reports unchanged and changed against the base', () => {
    expect(classifySide(side(1, 1), side(1, 1))).toBe('unchanged');
    expect(classifySide(side(2, 1), side(1, 1))).toBe('changed');
  });
});

describe('needsCapture', () => {
  it('captures nothing when the victim does not exist', () => {
    expect(needsCapture(null, side(1, 1))).toBe(false);
    expect(needsCapture(null, null)).toBe(false);
  });

  it('captures when the victim exists and the survivor does not', () => {
    expect(needsCapture(side(1, 1), null)).toBe(true);
  });

  it('captures only when the two actually differ', () => {
    expect(needsCapture(side(1, 1), side(1, 1))).toBe(false);
    expect(needsCapture(side(2, 1), side(1, 1))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HEIDENHAIN name validation
// ---------------------------------------------------------------------------

describe('isCp850Encodable', () => {
  it('accepts ASCII and Western European accented letters', () => {
    expect(isCp850Encodable('PROG1.H')).toBe(true);
    expect(isCp850Encodable('MESSDÜSE.H')).toBe(true);
  });

  it('rejects codepoints above CP850, including astral ones', () => {
    expect(isCp850Encodable('ПРОГ.H')).toBe(false);
    expect(isCp850Encodable('プログラム.H')).toBe(false);
    // The `u` flag matters: an emoji is two surrogate halves that both sit below 0xff.
    expect(isCp850Encodable('PROG🙂.H')).toBe(false);
    expect(isCp850Encodable('PROG’S.H')).toBe(false);
  });
});

describe('validateHeidenhainName', () => {
  it('passes a conforming name with no warnings', () => {
    expect(validateHeidenhainName('sub/dir/PROG1.H')).toEqual([]);
  });

  it('accepts every documented HEIDENHAIN extension, in either case', () => {
    for (const extension of HEIDENHAIN_EXTENSIONS) {
      expect(validateHeidenhainName(`PROG${extension}`)).toEqual([]);
      expect(validateHeidenhainName(`PROG${extension.toLowerCase()}`)).toEqual([]);
    }
  });

  it('returns nothing for a path with an empty final segment', () => {
    expect(validateHeidenhainName('sub/dir/')).toEqual([]);
    expect(validateHeidenhainName('')).toEqual([]);
  });

  it('warns about the SMB-illegal punctuation', () => {
    for (const name of ['A<B.H', 'A>B.H', 'A:B.H', 'A"B.H', 'A|B.H', 'A?B.H', 'A*B.H', 'A\\B.H']) {
      expect(validateHeidenhainName(name)).toEqual([
        expect.stringContaining('cannot use in a filename'),
      ]);
    }
  });

  it('warns about every C0 control character', () => {
    // These are the bytes a mangled transfer or a hostile name injects; a control
    // character in a filename is never legitimate.
    for (const code of [0, 1, 9, 10, 13, 31]) {
      const name = `A${String.fromCharCode(code)}B.H`;
      expect(validateHeidenhainName(name)).toEqual([
        expect.stringContaining('cannot use in a filename'),
      ]);
    }
    // 0x20 is the first legal codepoint — the range must stop below it.
    expect(validateHeidenhainName(`A${String.fromCharCode(32)}B.H`)).toEqual([]);
  });

  it('permits spaces and hyphens, which are legal on the control', () => {
    // Guards against a plausible over-tightening of the forbidden set.
    expect(validateHeidenhainName('MY PROG.H')).toEqual([]);
    expect(validateHeidenhainName('PART-1.H')).toEqual([]);
  });

  it('warns about names outside CP850', () => {
    expect(validateHeidenhainName('ПРОГ.H')).toEqual([expect.stringContaining('outside CP850')]);
  });

  it('warns above the 80-character limit but not at it', () => {
    const at = `${'A'.repeat(78)}.H`;
    expect(at).toHaveLength(80);
    expect(validateHeidenhainName(at)).toEqual([]);
    expect(validateHeidenhainName(`${'A'.repeat(79)}.H`)).toEqual([
      expect.stringContaining('80-character'),
    ]);
  });

  it('warns about an extension controls do not open', () => {
    expect(validateHeidenhainName('README.TXT')).toEqual([
      expect.stringContaining('extension .TXT'),
    ]);
  });

  it('does not warn about an extension when there is no dot at all', () => {
    expect(validateHeidenhainName('MAKEFILE')).toEqual([]);
  });

  it('accumulates every applicable warning at once', () => {
    const warnings = validateHeidenhainName(`ПРОГ?${'X'.repeat(90)}.TXT`);
    expect(warnings).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Path-intrinsic overrides
// ---------------------------------------------------------------------------

describe('decide — path-intrinsic overrides', () => {
  it('excludes a matching path before anything else is considered', () => {
    const result = run(side(1, 1), null, null, {
      excluded: true,
      caseCollision: true,
      maxFileSizeBytes: 0,
      serverOffline: true,
      locked: true,
    });
    expect(result.action).toBe('EXCLUDE');
    expect(result.reason).toBe('excluded');
    expect(result.nextState).toBe('excluded');
    expect(result.captureVersion).toBeNull();
  });

  it('errors on a case collision rather than letting one copy win at random', () => {
    const result = run(side(1, 1), side(2, 2), null, { caseCollision: true });
    expect(result.action).toBe('ERROR');
    expect(result.reason).toBe('case_collision');
    expect(result.nextState).toBe('error');
    expect(result.detail).toContain('differs only by case');
  });

  it('skips an oversized file and names the limit', () => {
    const result = run(side(2_000, 1), side(10, 1), null, { maxFileSizeBytes: 1_000 });
    expect(result.action).toBe('SKIP');
    expect(result.reason).toBe('oversized');
    expect(result.nextState).toBe('error');
    expect(result.detail).toContain('2000 bytes');
    expect(result.detail).toContain('1000');
  });

  it('measures the largest side, so an oversized remote is caught too', () => {
    expect(run(side(10, 1), side(2_000, 1), null, { maxFileSizeBytes: 1_000 }).action).toBe('SKIP');
    expect(run(null, side(2_000, 1), null, { maxFileSizeBytes: 1_000 }).action).toBe('SKIP');
    expect(run(side(2_000, 1), null, null, { maxFileSizeBytes: 1_000 }).action).toBe('SKIP');
  });

  it('allows a file exactly at the limit', () => {
    expect(run(side(1_000, 1), null, null, { maxFileSizeBytes: 1_000 }).action).toBe('PUSH');
  });

  it('does not defer an excluded or oversized path when the server is offline', () => {
    // Deferring these would re-queue them forever, or point an operator at the wrong fault.
    expect(run(side(1, 1), null, null, { excluded: true, serverOffline: true }).action).toBe(
      'EXCLUDE',
    );
    expect(
      run(side(9, 1), null, null, { maxFileSizeBytes: 1, serverOffline: true, locked: true })
        .action,
    ).toBe('SKIP');
  });
});

// ---------------------------------------------------------------------------
// The verdict table
// ---------------------------------------------------------------------------

describe('decide — verdict table without a base', () => {
  it('NOOPs when the path exists on neither side', () => {
    const result = run(null, null, null);
    expect(result.action).toBe('NOOP');
    expect(result.reason).toBe('in_sync');
    expect(result.nextState).toBe('synced');
  });

  it('pushes a file that is new locally', () => {
    const result = run(side(10, 100), null, null);
    expect(result.action).toBe('PUSH');
    expect(result.reason).toBe('local_created');
    expect(result.nextState).toBe('pending_push');
    expect(result.captureVersion).toBeNull();
  });

  it('pulls a file that is new on the server, validating its name', () => {
    const result = run(null, side(10, 100), null, { relPath: 'BAD?NAME.TXT' });
    expect(result.action).toBe('PULL');
    expect(result.reason).toBe('remote_created');
    expect(result.nextState).toBe('pending_pull');
    expect(result.warnings).toHaveLength(2);
  });

  it('converges when the same file appears on both sides', () => {
    const result = run(side(10, 100, h('a')), side(10, 500, h('a')), null);
    expect(result.action).toBe('CONVERGE');
    expect(result.reason).toBe('converged');
    expect(result.nextState).toBe('synced');
    expect(result.captureVersion).toBeNull();
  });

  it('treats differing new files on both sides as a conflict', () => {
    const result = run(side(10, 100, h('a')), side(20, 100, h('b')), null);
    expect(result.reason).toBe('conflict_resolved');
    expect(result.nextState).toBe('conflict');
    expect(result.detail).toContain('appeared on both sides differing');
  });
});

describe('decide — verdict table with a base', () => {
  const base = side(10, 100, h('a'));

  it('NOOPs when neither side moved', () => {
    const result = run(side(10, 100, h('a')), side(10, 100, h('a')), base);
    expect(result.action).toBe('NOOP');
    expect(result.reason).toBe('in_sync');
  });

  it('pushes a local edit and captures the server copy it will overwrite', () => {
    const result = run(side(11, 200, h('c')), side(10, 100, h('a')), base);
    expect(result.action).toBe('PUSH');
    expect(result.reason).toBe('local_changed');
    expect(result.captureVersion).toEqual({ side: 'remote', reason: 'overwrite' });
  });

  it('captures nothing on a push whose target already matches the new content', () => {
    // Remote is byte-identical to the incoming local copy: nothing would be destroyed.
    const result = run(side(11, 200, h('c')), side(11, 200, h('c')), side(10, 100, h('a')));
    // Both sides moved to the same content — that is a convergence, not a push.
    expect(result.action).toBe('CONVERGE');
    expect(result.captureVersion).toBeNull();
  });

  it('pulls a server edit, captures the local copy, and validates the name', () => {
    const result = run(side(10, 100, h('a')), side(12, 300, h('d')), base, {
      relPath: 'PROG.TXT',
    });
    expect(result.action).toBe('PULL');
    expect(result.reason).toBe('remote_changed');
    expect(result.captureVersion).toEqual({ side: 'local', reason: 'overwrite' });
    expect(result.warnings).toEqual([expect.stringContaining('extension .TXT')]);
  });

  it('NOOPs when both sides were deleted', () => {
    const result = run(null, null, base);
    expect(result.action).toBe('NOOP');
    expect(result.reason).toBe('both_deleted');
    expect(result.nextState).toBe('synced');
  });

  it('converges when both sides changed to identical content', () => {
    const result = run(side(20, 400, h('e')), side(20, 900, h('e')), base);
    expect(result.action).toBe('CONVERGE');
    expect(result.reason).toBe('converged');
  });
});

describe('decide — deletions and protect_deletes', () => {
  const base = side(10, 100, h('a'));
  const unchangedRemote = side(10, 100, h('a'));
  const unchangedLocal = side(10, 100, h('a'));

  it('restores a locally deleted file from the server when protection is on', () => {
    const result = run(null, unchangedRemote, base, { protectDeletes: true });
    expect(result.action).toBe('PULL');
    expect(result.reason).toBe('delete_protected');
    expect(result.nextState).toBe('pending_pull');
    expect(result.captureVersion).toBeNull();
  });

  it('propagates a local deletion when protection is off, capturing the server copy', () => {
    const result = run(null, unchangedRemote, base, { protectDeletes: false });
    expect(result.action).toBe('DELETE_REMOTE');
    expect(result.reason).toBe('local_deleted');
    expect(result.nextState).toBe('pending_push');
    expect(result.captureVersion).toEqual({ side: 'remote', reason: 'delete' });
  });

  it('restores a server-side deletion from the local copy when protection is on', () => {
    const result = run(unchangedLocal, null, base, { protectDeletes: true });
    expect(result.action).toBe('PUSH');
    expect(result.reason).toBe('delete_protected');
    expect(result.nextState).toBe('pending_push');
  });

  it('propagates a server deletion when protection is off, capturing the local copy', () => {
    const result = run(unchangedLocal, null, base, { protectDeletes: false });
    expect(result.action).toBe('DELETE_LOCAL');
    expect(result.reason).toBe('remote_deleted');
    expect(result.nextState).toBe('pending_pull');
    expect(result.captureVersion).toEqual({ side: 'local', reason: 'delete' });
  });
});

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

describe('decide — conflict resolution', () => {
  const base = side(10, 100, h('a'));
  const localNewer = side(11, 10_000, h('b'));
  const remoteOlder = side(12, 1_000, h('c'));

  it('tnc_wins always pushes the local copy and captures the server loser', () => {
    const result = run(localNewer, remoteOlder, base, { conflictMode: 'tnc_wins' });
    expect(result.action).toBe('PUSH');
    expect(result.reason).toBe('conflict_resolved');
    expect(result.nextState).toBe('conflict');
    expect(result.captureVersion).toEqual({ side: 'remote', reason: 'conflict_loser' });
    expect(result.conflict).toEqual({
      modeApplied: 'tnc_wins',
      winner: 'local',
      tieBroken: false,
      localMtime: 10_000,
      remoteMtime: 1_000,
    });
  });

  it('server_wins always pulls the server copy and captures the local loser', () => {
    const result = run(localNewer, remoteOlder, base, { conflictMode: 'server_wins' });
    expect(result.action).toBe('PULL');
    expect(result.captureVersion).toEqual({ side: 'local', reason: 'conflict_loser' });
    expect(result.conflict?.winner).toBe('remote');
    expect(result.conflict?.modeApplied).toBe('server_wins');
  });

  it('last_write_wins picks the newer side in each direction', () => {
    const localWins = run(localNewer, remoteOlder, base);
    expect(localWins.action).toBe('PUSH');
    expect(localWins.conflict?.winner).toBe('local');
    expect(localWins.conflict?.tieBroken).toBe(false);
    expect(localWins.detail).toContain('the local copy is newer');

    const remoteWins = run(side(11, 1_000, h('b')), side(12, 10_000, h('c')), base);
    expect(remoteWins.action).toBe('PULL');
    expect(remoteWins.conflict?.winner).toBe('remote');
    expect(remoteWins.detail).toContain('the remote copy is newer');
  });

  it('breaks a tie inside the tolerance in favour of the TNC side', () => {
    // R8: three clocks, no NTP guarantee — inside the window the mtimes say nothing.
    const inside = run(side(11, 1_500, h('b')), side(12, 1_000, h('c')), base, {
      mtimeToleranceMs: 2_000,
    });
    expect(inside.action).toBe('PUSH');
    expect(inside.conflict?.tieBroken).toBe(true);
    expect(inside.detail).toContain('within the 2000 ms tolerance');
  });

  it('treats the tolerance boundary itself as a tie, in both directions', () => {
    const exactlyAbove = run(side(11, 3_000, h('b')), side(12, 1_000, h('c')), base, {
      mtimeToleranceMs: 2_000,
    });
    expect(exactlyAbove.conflict?.tieBroken).toBe(true);

    const exactlyBelow = run(side(11, 1_000, h('b')), side(12, 3_000, h('c')), base, {
      mtimeToleranceMs: 2_000,
    });
    expect(exactlyBelow.conflict?.tieBroken).toBe(true);
    expect(exactlyBelow.conflict?.winner).toBe('local');

    const justOutside = run(side(11, 1_000, h('b')), side(12, 3_001, h('c')), base, {
      mtimeToleranceMs: 2_000,
    });
    expect(justOutside.conflict?.tieBroken).toBe(false);
    expect(justOutside.conflict?.winner).toBe('remote');
  });

  it('never lets a delete silently win under last_write_wins', () => {
    const localDeleted = run(null, side(12, 1_000, h('c')), base);
    expect(localDeleted.action).toBe('PULL');
    expect(localDeleted.conflict?.winner).toBe('remote');
    expect(localDeleted.conflict?.tieBroken).toBe(true);
    expect(localDeleted.conflict?.localMtime).toBeNull();
    expect(localDeleted.detail).toContain('a delete never silently wins');
    expect(localDeleted.captureVersion).toBeNull();

    const remoteDeleted = run(side(11, 1_000, h('b')), null, base);
    expect(remoteDeleted.action).toBe('PUSH');
    expect(remoteDeleted.conflict?.winner).toBe('local');
    expect(remoteDeleted.conflict?.remoteMtime).toBeNull();
    expect(remoteDeleted.captureVersion).toBeNull();
  });

  it('deletes the remote when tnc_wins backs a local deletion', () => {
    const result = run(null, side(12, 1_000, h('c')), base, { conflictMode: 'tnc_wins' });
    expect(result.action).toBe('DELETE_REMOTE');
    expect(result.captureVersion).toEqual({ side: 'remote', reason: 'conflict_loser' });
    expect(result.detail).toContain('deleted locally but changed on the server');
  });

  it('deletes the local copy when server_wins backs a server deletion', () => {
    const result = run(side(11, 1_000, h('b')), null, base, { conflictMode: 'server_wins' });
    expect(result.action).toBe('DELETE_LOCAL');
    expect(result.captureVersion).toEqual({ side: 'local', reason: 'conflict_loser' });
    expect(result.detail).toContain('changed locally but was deleted on the server');
  });

  it('validates the name only when the resolution results in a pull', () => {
    const pull = run(side(11, 1_000, h('b')), side(12, 10_000, h('c')), base, {
      relPath: 'PROG.TXT',
    });
    expect(pull.action).toBe('PULL');
    expect(pull.warnings).toEqual([expect.stringContaining('extension .TXT')]);

    const push = run(side(11, 10_000, h('b')), side(12, 1_000, h('c')), base, {
      relPath: 'PROG.TXT',
    });
    expect(push.action).toBe('PUSH');
    expect(push.warnings).toEqual([]);
  });

  it('captures the losing side in every mode where the loser holds content', () => {
    const modes: ConflictMode[] = ['tnc_wins', 'server_wins', 'last_write_wins'];
    for (const conflictMode of modes) {
      const result = run(localNewer, remoteOlder, base, { conflictMode });
      expect(result.captureVersion).not.toBeNull();
      expect(result.captureVersion?.reason).toBe('conflict_loser');
      expect(result.captureVersion?.side).not.toBe(result.conflict?.winner);
    }
  });
});

// ---------------------------------------------------------------------------
// Availability overrides
// ---------------------------------------------------------------------------

describe('decide — availability overrides', () => {
  const base = side(10, 100, h('a'));

  it('defers a push while the server share is unreachable, keeping the state', () => {
    const result = run(side(11, 200, h('b')), side(10, 100, h('a')), base, {
      serverOffline: true,
    });
    expect(result.action).toBe('DEFER');
    expect(result.reason).toBe('server_offline');
    expect(result.nextState).toBe('pending_push');
    expect(result.detail).toContain('unreachable');
  });

  it('defers a push while read-only, naming read-only rather than offline', () => {
    const result = run(side(11, 200, h('b')), side(10, 100, h('a')), base, { readOnly: true });
    expect(result.action).toBe('DEFER');
    expect(result.reason).toBe('read_only');
    expect(result.detail).toContain('read-only');
  });

  it('reports offline in preference to read-only when both are set', () => {
    const result = run(side(11, 200, h('b')), side(10, 100, h('a')), base, {
      serverOffline: true,
      readOnly: true,
    });
    expect(result.reason).toBe('server_offline');
  });

  it('defers a remote deletion too, since it also mutates the server', () => {
    const result = run(null, side(10, 100, h('a')), base, {
      protectDeletes: false,
      serverOffline: true,
    });
    expect(result.action).toBe('DEFER');
    expect(result.nextState).toBe('pending_push');
  });

  it('still pulls while the share is read-only, because a pull writes only locally', () => {
    const result = run(side(10, 100, h('a')), side(12, 300, h('d')), base, { readOnly: true });
    expect(result.action).toBe('PULL');
  });

  it('leaves a NOOP alone when the server is offline', () => {
    const result = run(side(10, 100, h('a')), side(10, 100, h('a')), base, {
      serverOffline: true,
    });
    expect(result.action).toBe('NOOP');
  });

  it('defers a pull while a TNC holds the file open', () => {
    // The hard safety rule: never overwrite a program a machine is running.
    const result = run(side(10, 100, h('a')), side(12, 300, h('d')), base, { locked: true });
    expect(result.action).toBe('DEFER');
    expect(result.reason).toBe('locked_by_tnc');
    expect(result.nextState).toBe('deferred_locked');
    expect(result.detail).toContain('holds PROG.H open');
  });

  it('defers a local deletion while locked', () => {
    const result = run(side(10, 100, h('a')), null, base, {
      protectDeletes: false,
      locked: true,
    });
    expect(result.action).toBe('DEFER');
    expect(result.reason).toBe('locked_by_tnc');
  });

  it('does not defer a push merely because the file is locked', () => {
    // A lock protects the local copy the machine is reading; sending it out is safe.
    const result = run(side(11, 200, h('b')), side(10, 100, h('a')), base, { locked: true });
    expect(result.action).toBe('PUSH');
  });

  it('lets the lock override win over the offline override when both apply', () => {
    // A conflict pull is server-agnostic, so only the lock should catch it.
    const result = run(side(11, 1_000, h('b')), side(12, 10_000, h('c')), base, {
      serverOffline: true,
      locked: true,
    });
    expect(result.action).toBe('DEFER');
    expect(result.reason).toBe('locked_by_tnc');
    expect(result.nextState).toBe('deferred_locked');
  });

  it('preserves the conflict record and warnings across a deferral', () => {
    const result = run(side(11, 1_000, h('b')), side(12, 10_000, h('c')), base, {
      locked: true,
      relPath: 'PROG.TXT',
    });
    expect(result.action).toBe('DEFER');
    expect(result.conflict?.winner).toBe('remote');
    expect(result.warnings).toEqual([expect.stringContaining('extension .TXT')]);
  });

  it('drops the version capture when the destructive action is not going to run', () => {
    const result = run(side(11, 200, h('b')), side(10, 100, h('a')), base, {
      serverOffline: true,
    });
    // Nothing is destroyed by a deferral, so nothing needs capturing yet.
    expect(result.action).toBe('DEFER');
    expect(result.captureVersion).toBeNull();
    expect(
      destroysData(
        { local: side(11, 200, h('b')), remote: side(10, 100, h('a')), base, config: cfg() },
        result,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// destroysData
// ---------------------------------------------------------------------------

describe('destroysData', () => {
  const input = (local: Side, remote: Side): DiffInput => ({
    local,
    remote,
    base: null,
    config: cfg(),
  });
  const asVerdict = (action: (typeof VERDICT_ACTIONS)[number]): ReturnType<typeof decide> => ({
    action,
    reason: 'in_sync',
    detail: '',
    captureVersion: null,
    conflict: null,
    nextState: 'synced',
    warnings: [],
  });

  it('reports a pull as destructive only when the local copy differs', () => {
    expect(destroysData(input(side(1, 1), side(2, 2)), asVerdict('PULL'))).toBe(true);
    expect(destroysData(input(side(1, 1), side(1, 1)), asVerdict('PULL'))).toBe(false);
    expect(destroysData(input(null, side(2, 2)), asVerdict('PULL'))).toBe(false);
  });

  it('reports a push as destructive only when the server copy differs', () => {
    expect(destroysData(input(side(1, 1), side(2, 2)), asVerdict('PUSH'))).toBe(true);
    expect(destroysData(input(side(1, 1), null), asVerdict('PUSH'))).toBe(false);
  });

  it('reports a delete as destructive whenever the target exists', () => {
    expect(destroysData(input(side(1, 1), null), asVerdict('DELETE_LOCAL'))).toBe(true);
    expect(destroysData(input(null, null), asVerdict('DELETE_LOCAL'))).toBe(false);
    expect(destroysData(input(null, side(1, 1)), asVerdict('DELETE_REMOTE'))).toBe(true);
    expect(destroysData(input(null, null), asVerdict('DELETE_REMOTE'))).toBe(false);
  });

  it('reports every non-transferring action as harmless', () => {
    for (const action of ['NOOP', 'CONVERGE', 'DEFER', 'EXCLUDE', 'SKIP', 'ERROR'] as const) {
      expect(destroysData(input(side(1, 1), side(2, 2)), asVerdict(action))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The invariant, over random triples
// ---------------------------------------------------------------------------

/** Deterministic PRNG, so a failure is reproducible from the seed printed below. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('property: no verdict discards data without capturing a version', () => {
  const MODES: ConflictMode[] = ['tnc_wins', 'server_wins', 'last_write_wins'];
  const HASHES = [h('a'), h('b'), h('c'), null];
  const SEED = 0x7f18;

  const seen = new Map<string, number>();

  it('holds over 20000 random triples', () => {
    const random = mulberry32(SEED);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const randomSide = (): Side =>
      random() < 0.2
        ? null
        : {
            size: Math.floor(random() * 4) * 10,
            mtime: Math.floor(random() * 5) * 1_000,
            hash: pick(HASHES),
          };

    for (let i = 0; i < 20_000; i += 1) {
      const local = randomSide();
      const remote = randomSide();
      const base = random() < 0.35 ? null : randomSide();
      const config = cfg({
        conflictMode: pick(MODES),
        protectDeletes: random() < 0.5,
        locked: random() < 0.2,
        serverOffline: random() < 0.2,
        readOnly: random() < 0.2,
        excluded: random() < 0.05,
        caseCollision: random() < 0.05,
        maxFileSizeBytes: random() < 0.05 ? 5 : DEFAULT_DIFF_CONFIG.maxFileSizeBytes,
        relPath: pick(['PROG.H', 'sub/PART 2.TXT', 'ПРОГ.NC']),
      });
      const input: DiffInput = { local, remote, base, config };
      const result = decide(input);

      seen.set(result.action, (seen.get(result.action) ?? 0) + 1);

      if (destroysData(input, result)) {
        expect({ i, action: result.action, captureVersion: result.captureVersion }).toEqual({
          i,
          action: result.action,
          captureVersion: expect.objectContaining({ side: expect.any(String) }),
        });
      }
    }
  });

  it('exercised every verdict action at least once', () => {
    // Guards the property test itself: an invariant only holds over what it reaches.
    for (const action of VERDICT_ACTIONS) {
      expect(seen.get(action) ?? 0).toBeGreaterThan(0);
    }
  });

  it('captures the side that is about to be lost, not the survivor', () => {
    const random = mulberry32(SEED ^ 0x1234);
    for (let i = 0; i < 5_000; i += 1) {
      const mk = (): Side =>
        random() < 0.25
          ? null
          : {
              size: Math.floor(random() * 3) * 7,
              mtime: Math.floor(random() * 4) * 900,
              hash: null,
            };
      const input: DiffInput = {
        local: mk(),
        remote: mk(),
        base: random() < 0.4 ? null : mk(),
        config: cfg({ protectDeletes: random() < 0.5 }),
      };
      const result = decide(input);
      if (result.captureVersion === null) {
        continue;
      }
      // A capture of the local side must never accompany an action that writes remotely.
      if (result.action === 'PUSH' || result.action === 'DELETE_REMOTE') {
        expect(result.captureVersion.side).toBe('remote');
      }
      if (result.action === 'PULL' || result.action === 'DELETE_LOCAL') {
        expect(result.captureVersion.side).toBe('local');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('imports nothing that can perform I/O', () => {
    const source = readFileSync(join(__dirname, 'diff-engine.ts'), 'utf8');
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)';/gm)].map(
      (match) => match[1],
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/^node:/);
      // Only the shared, dependency-free schema modules are permitted.
      expect(specifier).toMatch(/^\.\.\/\.\.\/shared\//);
    }
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it('returns an equal verdict for equal inputs and mutates nothing', () => {
    const local = side(11, 200, h('b'));
    const remote = side(10, 100, h('a'));
    const base = side(10, 100, h('a'));
    const input: DiffInput = { local, remote, base, config: cfg() };
    const first = decide(input);
    const second = decide(input);
    expect(first).toEqual(second);
    expect(local).toEqual(side(11, 200, h('b')));
    expect(remote).toEqual(side(10, 100, h('a')));
    expect(base).toEqual(side(10, 100, h('a')));
  });

  it('defaults to last_write_wins with deletes protected', () => {
    expect(DEFAULT_DIFF_CONFIG.conflictMode).toBe('last_write_wins');
    expect(DEFAULT_DIFF_CONFIG.protectDeletes).toBe(true);
    expect(DEFAULT_DIFF_CONFIG.mtimeToleranceMs).toBe(2_000);
  });
});
