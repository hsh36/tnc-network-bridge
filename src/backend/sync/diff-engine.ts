import { type ConflictMode } from '../../shared/schemas/config';
import { type FileSide, type FileState } from '../../shared/schemas/file-index';

/**
 * The diff and decision engine (T18) — IMPLEMENTATION_PLAN §3.1.
 *
 * **This module performs no I/O and imports nothing that can.** That is not a stylistic
 * preference; it is what makes the engine testable to exhaustion before the transfer
 * layer exists, and what lets a support engineer reproduce any sync decision the field
 * ever made from three tuples and a config. Every input is a value, every output is a
 * value. There is a test asserting the module's own source contains no `node:` import.
 *
 * ## Why three values and not two
 *
 * The engine reasons over `(base, local, remote)`. `base` is the last state both sides
 * were confirmed to agree on. Without it, "this file differs from that file" is all one
 * can say, and that cannot distinguish *one side changed* (safe: copy it over) from
 * *both sides changed* (a conflict: someone is about to lose work). A two-value
 * reconciler silently destroys edits, and does so most often exactly when two people are
 * busy on the same part.
 *
 * ## The invariant
 *
 * **No verdict may discard data without first capturing a version.** Every action that
 * overwrites or deletes content that differs from what will survive carries a
 * non-null {@link Verdict.captureVersion}. This is asserted by a property-based test
 * over randomly generated triples, not merely by the examples. If a future change breaks
 * it, that test fails — and it should, because a conflict mode that loses a program
 * irrecoverably is the one bug this product cannot ship.
 *
 * ## Asymmetry in "changed"
 *
 * When hashes are available they decide; when they are not, a difference in `(size,
 * mtime)` does. That comparison is deliberately *eager to call something changed*: a
 * false "changed" costs a hash check or a redundant copy, while a false "unchanged"
 * loses an edit permanently. Given the choice the engine always takes the recoverable
 * error. Clock skew therefore never decides *whether* something changed (R8) — only
 * which side wins once a conflict is already established.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One side of the triple. `null` means "absent here", which is a real input, not a gap. */
export type Side = FileSide | null;

export interface DiffInput {
  /** The local cache copy — which is also what the TNC sees over SMB. */
  readonly local: Side;
  /** The copy on the mounted server share. */
  readonly remote: Side;
  /** Last confirmed-synced state. `null` for a path this bridge has not synced before. */
  readonly base: Side;
  readonly config: DiffConfig;
}

export interface DiffConfig {
  readonly conflictMode: ConflictMode;
  /** Ties inside this window fall through to the tie-break rule. Default 2000 ms. */
  readonly mtimeToleranceMs: number;
  /** Converts a remote deletion into a local retain + version capture. Default on. */
  readonly protectDeletes: boolean;
  /** Files above this are skipped with a warning rather than transferred. */
  readonly maxFileSizeBytes: number;
  /** The path matches an exclude pattern (picomatch is applied by the caller). */
  readonly excluded: boolean;
  /** A TNC currently holds this file open. */
  readonly locked: boolean;
  /** The server share is unreachable. */
  readonly serverOffline: boolean;
  /** Operator- or failover-imposed read-only. */
  readonly readOnly: boolean;
  /**
   * Another indexed path differs from this one only by case. SMB is case-insensitive
   * and ext4 is not, so the two cannot coexist safely (§3.2).
   */
  readonly caseCollision: boolean;
  /** Relative path, used only to produce warnings and messages. */
  readonly relPath: string;
}

export const DEFAULT_DIFF_CONFIG: Omit<DiffConfig, 'relPath'> = {
  conflictMode: 'last_write_wins',
  mtimeToleranceMs: 2_000,
  protectDeletes: true,
  maxFileSizeBytes: 512 * 1024 * 1024,
  excluded: false,
  locked: false,
  serverOffline: false,
  readOnly: false,
  caseCollision: false,
};

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const VERDICT_ACTIONS = [
  'NOOP',
  'PUSH',
  'PULL',
  'DELETE_REMOTE',
  'DELETE_LOCAL',
  /** Both sides changed to the same content. Update base only; no transfer. */
  'CONVERGE',
  /** Correct action is known but cannot run yet. Re-evaluated on the next cycle. */
  'DEFER',
  'EXCLUDE',
  /** Oversized. Needs an operator decision, so it is surfaced rather than retried. */
  'SKIP',
  'ERROR',
] as const;

export type VerdictAction = (typeof VERDICT_ACTIONS)[number];

export type VerdictReason =
  | 'in_sync'
  | 'local_changed'
  | 'remote_changed'
  | 'local_created'
  | 'remote_created'
  | 'local_deleted'
  | 'remote_deleted'
  | 'both_deleted'
  | 'converged'
  | 'conflict_resolved'
  | 'delete_protected'
  | 'excluded'
  | 'oversized'
  | 'case_collision'
  | 'server_offline'
  | 'read_only'
  | 'locked_by_tnc';

/** Which side must be written to the version store before the action runs. */
export interface VersionCapture {
  readonly side: 'local' | 'remote';
  readonly reason: 'overwrite' | 'delete' | 'conflict_loser';
}

export interface ConflictOutcome {
  readonly modeApplied: ConflictMode;
  readonly winner: 'local' | 'remote';
  /** True when the mtime comparison fell inside the tolerance and the tie-break decided. */
  readonly tieBroken: boolean;
  readonly localMtime: number | null;
  readonly remoteMtime: number | null;
}

export interface Verdict {
  readonly action: VerdictAction;
  readonly reason: VerdictReason;
  /** Human-readable, and written to the sync log so a decision can be reconstructed. */
  readonly detail: string;
  /** Non-null whenever the action destroys content that differs from what survives. */
  readonly captureVersion: VersionCapture | null;
  /** Populated only when a genuine conflict was resolved. */
  readonly conflict: ConflictOutcome | null;
  /** The `file_index.state` to persist. */
  readonly nextState: FileState;
  /** Non-fatal observations, surfaced in the UI beside the file. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Comparison primitives
// ---------------------------------------------------------------------------

export type SideChange = 'absent' | 'created' | 'unchanged' | 'changed' | 'deleted';

/**
 * Whether two sides hold the same content.
 *
 * Hashes decide when both are known — that is the authoritative answer and the only one
 * immune to clock skew. Otherwise `(size, mtime)` decides, with **exact** mtime
 * equality: the tolerance exists to break ties between two clocks in a conflict, and
 * using it here would let a file that changed within the tolerance window be declared
 * unchanged, which loses the edit.
 */
export function sameContent(a: FileSide, b: FileSide): boolean {
  if (a.hash !== null && b.hash !== null) {
    return a.hash === b.hash;
  }
  return a.size === b.size && a.mtime === b.mtime;
}

/** Classifies one side against the base. */
export function classifySide(side: Side, base: Side): SideChange {
  if (base === null) {
    return side === null ? 'absent' : 'created';
  }
  if (side === null) {
    return 'deleted';
  }
  return sameContent(side, base) ? 'unchanged' : 'changed';
}

// ---------------------------------------------------------------------------
// HEIDENHAIN filename validation (§3.2)
// ---------------------------------------------------------------------------

/** Extensions HEIDENHAIN controls open. Anything else is a warning, never a refusal. */
export const HEIDENHAIN_EXTENSIONS = [
  '.H',
  '.I',
  '.NC',
  '.T',
  '.TAB',
  '.PNT',
  '.CDT',
  '.DEP',
  '.PGM',
  '.CMA',
] as const;

/**
 * Characters a control cannot use in a filename: the SMB-illegal punctuation set plus
 * every C0 control code.
 *
 * The control codes are written as escapes deliberately. They were once literal bytes
 * embedded in this source, which made the class unreadable in review and its boundary
 * impossible to check by eye.
 *
 * The space and the hyphen are **not** here. Both are legal on the control, and warning
 * about them would put a yellow triangle beside a large share of real programs — which
 * is how operators learn to ignore the warnings that matter.
 */
// Matching control characters is the point: they are exactly what a mangled transfer
// or a hostile name puts into a filename.
// eslint-disable-next-line no-control-regex
const HEIDENHAIN_FORBIDDEN = /[<>:"|?*\\\u0000-\u001f]/;

/**
 * Checks a name against the constraints of the target control.
 *
 * These are warnings, not verdict changes. A program the control cannot open is worse
 * than one that never arrived — but refusing the transfer outright would be worse still,
 * because the operator would have no file *and* no explanation. So it arrives, with the
 * problem named.
 */
export function validateHeidenhainName(relPath: string): string[] {
  const warnings: string[] = [];
  // `slice(lastIndexOf + 1)` rather than `split('/').pop()`: it needs no fallback for a
  // case that cannot occur, and an unreachable fallback is an untestable branch.
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  if (name === '') {
    return warnings;
  }

  if (HEIDENHAIN_FORBIDDEN.test(name)) {
    warnings.push(`"${name}" contains a character HEIDENHAIN controls cannot use in a filename`);
  }
  if (!isCp850Encodable(name)) {
    // R7: the control speaks CP850. A name it cannot represent arrives mangled.
    warnings.push(`"${name}" contains characters outside CP850 and may appear corrupted`);
  }
  if (name.length > 80) {
    warnings.push(`"${name}" exceeds the 80-character filename limit of older controls`);
  }

  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot).toUpperCase();
  if (extension !== '' && !(HEIDENHAIN_EXTENSIONS as readonly string[]).includes(extension)) {
    warnings.push(`"${name}" has extension ${extension}, which controls do not open directly`);
  }

  return warnings;
}

/**
 * CP850 covers ASCII plus most Western European accented letters.
 *
 * The check is a codepoint-range approximation rather than a full table: the aim is to
 * catch the cases that actually occur — Cyrillic, CJK, emoji, and the typographic
 * quotes a Windows editor inserts — without shipping an encoding table for a warning.
 */
export function isCp850Encodable(text: string): boolean {
  // The `u` flag matters: without it an astral character (an emoji) is two surrogate
  // halves, both of which sit below 0xff, and the check would wrongly pass.
  // The range starts at NUL by definition: CP850 encodes the C0 controls, so
  // excluding them here would report a problem that is not one.
  // eslint-disable-next-line no-control-regex
  return /^[\u0000-\u00ff]*$/u.test(text);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const verdict = (
  action: VerdictAction,
  reason: VerdictReason,
  detail: string,
  nextState: FileState,
  extras: Partial<Pick<Verdict, 'captureVersion' | 'conflict' | 'warnings'>> = {},
): Verdict => ({
  action,
  reason,
  detail,
  nextState,
  captureVersion: extras.captureVersion ?? null,
  conflict: extras.conflict ?? null,
  warnings: extras.warnings ?? [],
});

/** Actions that write to or delete from the server share. */
const SERVER_MUTATING: ReadonlySet<VerdictAction> = new Set<VerdictAction>([
  'PUSH',
  'DELETE_REMOTE',
]);

/** Actions that write to or delete from the local cache the TNC is reading. */
const LOCAL_MUTATING: ReadonlySet<VerdictAction> = new Set<VerdictAction>(['PULL', 'DELETE_LOCAL']);

/**
 * Computes the verdict for one path.
 *
 * Pure: the same inputs always produce the same output, and nothing outside is touched.
 */
export function decide(input: DiffInput): Verdict {
  const { local, remote, base, config } = input;

  // -- Path-intrinsic overrides ---------------------------------------------
  //
  // These come before the verdict table, which is a deliberate departure from the
  // literal numbering in IMPLEMENTATION_PLAN §3.1 (where "server offline" is listed
  // first). Exclusion and size are properties of the path itself and are true whatever
  // the server is doing; deferring an excluded file would re-queue it on every cycle
  // forever, and reporting an oversized file as "waiting for the server" would send an
  // operator to diagnose the wrong thing. The plan's remaining order — offline before
  // lock — is preserved below.

  if (config.excluded) {
    return verdict(
      'EXCLUDE',
      'excluded',
      `${config.relPath} matches an exclude pattern`,
      'excluded',
    );
  }

  if (config.caseCollision) {
    // §3.2: never a silent overwrite. SMB would treat PROG.H and prog.H as one file
    // while ext4 keeps both, so whichever synced last would win at random.
    return verdict(
      'ERROR',
      'case_collision',
      `${config.relPath} collides with another indexed path that differs only by case; ` +
        `SMB cannot distinguish them and one would silently overwrite the other`,
      'error',
    );
  }

  const largest = Math.max(local?.size ?? 0, remote?.size ?? 0);
  if (largest > config.maxFileSizeBytes) {
    return verdict(
      'SKIP',
      'oversized',
      `${config.relPath} is ${largest} bytes, above the configured limit of ` +
        `${config.maxFileSizeBytes}; raise the limit or exclude the path`,
      // The state enum has no "skipped" member, and `error` is the honest mapping: it
      // needs an operator decision and must be visible, not quietly retried forever.
      'error',
    );
  }

  const base_ = classifySide(local, base);
  const remote_ = classifySide(remote, base);
  const raw = decideCore(local, remote, base_, remote_, config);

  return applyAvailabilityOverrides(raw, config);
}

/** The verdict table itself, before availability is considered. */
function decideCore(
  local: Side,
  remote: Side,
  localChange: SideChange,
  remoteChange: SideChange,
  config: DiffConfig,
): Verdict {
  const path = config.relPath;

  // --- No base: the path is new to this bridge -----------------------------

  if (localChange === 'absent' && remoteChange === 'absent') {
    return verdict('NOOP', 'in_sync', `${path} exists on neither side`, 'synced');
  }

  if (localChange === 'created' && remoteChange === 'absent') {
    return verdict('PUSH', 'local_created', `${path} is new locally`, 'pending_push');
  }

  if (localChange === 'absent' && remoteChange === 'created') {
    return verdict('PULL', 'remote_created', `${path} is new on the server`, 'pending_pull', {
      warnings: validateHeidenhainName(path),
    });
  }

  if (localChange === 'created' && remoteChange === 'created') {
    // Both sides have a file we have never synced. Identical content is the common case
    // — an operator copied the same program to both — and needs no transfer at all.
    if (local !== null && remote !== null && sameContent(local, remote)) {
      return verdict(
        'CONVERGE',
        'converged',
        `${path} appeared on both sides with identical content`,
        'synced',
      );
    }
    return resolveConflict(local, remote, config, `${path} appeared on both sides differing`);
  }

  // --- With a base ---------------------------------------------------------

  if (localChange === 'unchanged' && remoteChange === 'unchanged') {
    return verdict('NOOP', 'in_sync', `${path} is unchanged on both sides`, 'synced');
  }

  if (localChange === 'changed' && remoteChange === 'unchanged') {
    return verdict('PUSH', 'local_changed', `${path} changed locally`, 'pending_push', {
      // The server copy is about to be overwritten by different content.
      captureVersion: needsCapture(remote, local) ? { side: 'remote', reason: 'overwrite' } : null,
    });
  }

  if (localChange === 'unchanged' && remoteChange === 'changed') {
    return verdict('PULL', 'remote_changed', `${path} changed on the server`, 'pending_pull', {
      captureVersion: needsCapture(local, remote) ? { side: 'local', reason: 'overwrite' } : null,
      warnings: validateHeidenhainName(path),
    });
  }

  if (localChange === 'deleted' && remoteChange === 'unchanged') {
    if (config.protectDeletes) {
      // A deletion in the cache is most often a TNC operator tidying their own view, or
      // our own failure to see a file. Restoring from the server is recoverable; wiping
      // the server copy is not.
      return verdict(
        'PULL',
        'delete_protected',
        `${path} was deleted locally; protect_deletes restores it from the server ` +
          `instead of deleting there`,
        'pending_pull',
      );
    }
    return verdict(
      'DELETE_REMOTE',
      'local_deleted',
      `${path} was deleted locally`,
      'pending_push',
      // `remote` is non-null by construction here: this arm requires remoteChange to be
      // 'unchanged', which only classifies a side that exists. The capture is therefore
      // unconditional rather than guarded by a branch no input can reach.
      { captureVersion: { side: 'remote', reason: 'delete' } },
    );
  }

  if (localChange === 'unchanged' && remoteChange === 'deleted') {
    if (config.protectDeletes) {
      // §3.2: a mis-click on the server must not wipe programs off the shop floor.
      return verdict(
        'PUSH',
        'delete_protected',
        `${path} was deleted on the server; protect_deletes keeps the local copy and ` +
          `restores it there`,
        'pending_push',
      );
    }
    return verdict(
      'DELETE_LOCAL',
      'remote_deleted',
      `${path} was deleted on the server`,
      'pending_pull',
      // `local` is non-null here for the mirror-image reason.
      { captureVersion: { side: 'local', reason: 'delete' } },
    );
  }

  if (localChange === 'deleted' && remoteChange === 'deleted') {
    return verdict('NOOP', 'both_deleted', `${path} was deleted on both sides`, 'synced');
  }

  if (localChange === 'changed' && remoteChange === 'changed') {
    if (local !== null && remote !== null && sameContent(local, remote)) {
      // Converged independently — the same edit made twice, or the same file copied to
      // both sides. Update base and move on; transferring would be pure waste.
      return verdict(
        'CONVERGE',
        'converged',
        `${path} changed on both sides to identical content`,
        'synced',
      );
    }
    return resolveConflict(local, remote, config, `${path} changed on both sides`);
  }

  // Delete versus change. §3.1: a delete never silently wins.
  if (localChange === 'deleted' && remoteChange === 'changed') {
    return resolveConflict(
      local,
      remote,
      config,
      `${path} was deleted locally but changed on the server`,
    );
  }

  if (localChange === 'changed' && remoteChange === 'deleted') {
    return resolveConflict(
      local,
      remote,
      config,
      `${path} changed locally but was deleted on the server`,
    );
  }

  /* istanbul ignore next -- every reachable combination is handled above */
  return verdict(
    'ERROR',
    'in_sync',
    `unreachable state for ${path}: local=${localChange} remote=${remoteChange}`,
    'error',
  );
}

/**
 * True when `victim` holds content that differs from `survivor` and would be lost.
 *
 * Exported for its own sake: it is the single predicate behind every version capture the
 * engine emits, and the "survivor is absent" case is reachable through the transfer layer
 * (which asks the same question about a file it is about to replace) even though no
 * verdict currently routes into it. Testing it directly is cheaper than reasoning about
 * which arm might one day reach it.
 */
export function needsCapture(victim: Side, survivor: Side): boolean {
  if (victim === null) {
    return false;
  }
  if (survivor === null) {
    return true;
  }
  return !sameContent(victim, survivor);
}

/**
 * Resolves a conflict according to the configured mode.
 *
 * The losing side is **always** version-captured before it is overwritten. That is the
 * non-negotiable rule from ARCHITECTURE §3.3: no conflict mode may destroy data
 * irrecoverably, so a wrong automatic choice is always an annoyance rather than a loss.
 */
function resolveConflict(local: Side, remote: Side, config: DiffConfig, context: string): Verdict {
  const mode = config.conflictMode;
  const localMtime = local?.mtime ?? null;
  const remoteMtime = remote?.mtime ?? null;

  let winner: 'local' | 'remote';
  let tieBroken = false;
  let rationale: string;

  if (mode === 'tnc_wins') {
    winner = 'local';
    rationale = 'conflict mode is tnc_wins';
  } else if (mode === 'server_wins') {
    winner = 'remote';
    rationale = 'conflict mode is server_wins';
  } else if (local === null || remote === null) {
    // A deletion has no meaningful mtime, so "last write" cannot be evaluated against
    // it. The surviving content wins, which is the same principle as protect_deletes:
    // the recoverable outcome is preferred over the irrecoverable one. Testing the two
    // sides directly (rather than via a boolean) also narrows them for the branch below,
    // where both are known to exist and no null-coalescing fallback is reachable.
    winner = local === null ? 'remote' : 'local';
    tieBroken = true;
    rationale =
      'last_write_wins cannot compare a deletion against an edit, so the surviving ' +
      'content wins — a delete never silently wins';
  } else {
    const difference = local.mtime - remote.mtime;
    if (Math.abs(difference) <= config.mtimeToleranceMs) {
      // R8: three clocks are involved and NTP is not a guarantee. Inside the tolerance
      // the mtimes carry no information, so the tie-break decides — in favour of the
      // operator standing at the machine, who is the more authoritative actor.
      winner = 'local';
      tieBroken = true;
      rationale =
        `mtimes are within the ${config.mtimeToleranceMs} ms tolerance, so the tie ` +
        `breaks to the TNC side`;
    } else {
      winner = difference > 0 ? 'local' : 'remote';
      rationale = `last_write_wins: the ${winner} copy is newer`;
    }
  }

  const loser = winner === 'local' ? 'remote' : 'local';
  const loserSide = loser === 'local' ? local : remote;

  const action: VerdictAction =
    winner === 'local'
      ? local === null
        ? 'DELETE_REMOTE'
        : 'PUSH'
      : remote === null
        ? 'DELETE_LOCAL'
        : 'PULL';

  return verdict(
    action,
    'conflict_resolved',
    `${context}; ${rationale}, so the ${winner} copy wins`,
    'conflict',
    {
      // Non-null whenever the loser actually holds content. When the loser is a
      // deletion there is nothing to capture, and nothing is lost by proceeding.
      captureVersion: loserSide === null ? null : { side: loser, reason: 'conflict_loser' },
      conflict: { modeApplied: mode, winner, tieBroken, localMtime, remoteMtime },
      warnings: action === 'PULL' ? validateHeidenhainName(config.relPath) : [],
    },
  );
}

/**
 * Applies the availability overrides, in the plan's order: server state first, then
 * locks.
 *
 * Deferral preserves the verdict's `nextState` where the plan calls for it (§3.4: "sync
 * queue paused, state kept"), so a share that comes back online resumes with its
 * pending work intact rather than rediscovering it.
 */
function applyAvailabilityOverrides(input: Verdict, config: DiffConfig): Verdict {
  let current = input;

  if ((config.serverOffline || config.readOnly) && SERVER_MUTATING.has(current.action)) {
    const reason: VerdictReason = config.serverOffline ? 'server_offline' : 'read_only';
    current = verdict(
      'DEFER',
      reason,
      `${current.detail} — deferred because the server share is ` +
        `${config.serverOffline ? 'unreachable' : 'read-only'}`,
      // State is kept so the queue resumes where it left off.
      current.nextState,
      { conflict: current.conflict, warnings: current.warnings },
    );
  }

  if (config.locked && LOCAL_MUTATING.has(current.action)) {
    // The hard safety rule (ARCHITECTURE §3.1): never overwrite a program a machine is
    // actively running. The pull is re-queued, not abandoned.
    current = verdict(
      'DEFER',
      'locked_by_tnc',
      `${current.detail} — deferred because a TNC holds ${config.relPath} open`,
      'deferred_locked',
      { conflict: current.conflict, warnings: current.warnings },
    );
  }

  return current;
}

/**
 * Whether a verdict will destroy content, and therefore must carry a version capture.
 *
 * Exported because it is the predicate the property-based test asserts over random
 * triples — stating the invariant in code rather than only in prose means a future
 * change to the engine has something to fail against.
 */
export function destroysData(input: DiffInput, result: Verdict): boolean {
  const { local, remote } = input;
  switch (result.action) {
    case 'PULL':
      return needsCapture(local, remote);
    case 'PUSH':
      return needsCapture(remote, local);
    case 'DELETE_LOCAL':
      return local !== null;
    case 'DELETE_REMOTE':
      return remote !== null;
    case 'NOOP':
    case 'CONVERGE':
    case 'DEFER':
    case 'EXCLUDE':
    case 'SKIP':
    case 'ERROR':
      return false;
  }
}
