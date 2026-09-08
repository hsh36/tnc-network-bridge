import picomatch from 'picomatch';
import {
  type BandwidthWindow,
  type PathRule,
  type PriorityRule,
  type SyncPolicies,
} from '../../shared';

/**
 * Advanced sync policies (T40): time-aware throttling, priority ordering, and path rules.
 *
 * All four policies are *decisions about a path or a moment*, with no I/O of their own.
 * Keeping them pure is what lets the whole matrix be tested exhaustively — including the
 * midnight-wrapping window and the precedence between overlapping rules — without a
 * filesystem, a clock, or a running sync engine.
 *
 * ## Matchers are compiled once
 *
 * A policy is consulted once per file per scan, which on a 10 000-file share is 10 000
 * evaluations of every rule. Recompiling a glob or a `RegExp` at each call would dominate
 * the scan; they are compiled when the policy set is installed and reused thereafter.
 *
 * ## An invalid regex disables its rule, loudly
 *
 * An operator can type a regex that does not compile. Throwing at match time would take
 * down the scan for every file; silently matching everything would be worse still. The
 * rule is dropped, and the reason is reported through {@link SyncPolicyEngine.problems}
 * so the UI can show it rather than leaving an exclusion that quietly does nothing.
 */

/** The default when no priority rule matches. Middle of the range, so rules can go either way. */
export const DEFAULT_PRIORITY = 50;

export interface PolicyProblem {
  readonly kind: 'exclude' | 'readOnly' | 'priority';
  readonly rule: string;
  readonly message: string;
}

interface CompiledRule {
  readonly source: string;
  readonly test: (relPath: string) => boolean;
}

interface CompiledPriorityRule extends CompiledRule {
  readonly priority: number;
}

/** Minutes since midnight, from `HH:MM`. */
export function parseTimeOfDay(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Whether a moment falls inside a daily window, handling windows that wrap past midnight.
 *
 * The wrap is the whole difficulty. For `22:00`–`06:00`, `from > to`, and the naive
 * `from <= t && t < to` is false for every minute of the day — a night-shift limit that
 * silently never applies. Splitting into "after `from`" **or** "before `to`" is what
 * makes it work, and it is why this is a named function with its own tests rather than
 * an inline comparison.
 *
 * The day check uses the day the window *started*, so a Friday 22:00–06:00 window still
 * applies at 02:00 on Saturday — which is what an operator writing "Friday night" means.
 */
export function isWithinWindow(window: BandwidthWindow, at: Date): boolean {
  const from = parseTimeOfDay(window.from);
  const to = parseTimeOfDay(window.to);
  const minutes = at.getHours() * 60 + at.getMinutes();
  const today = at.getDay();

  const matchesDay = (day: number): boolean =>
    window.days.length === 0 || window.days.includes(day);

  if (from === to) {
    // A zero-length window would be a mistake; treat it as the whole day, which is the
    // only reading under which the operator's intent ("all of Sunday") is satisfiable.
    return matchesDay(today);
  }

  if (from < to) {
    return matchesDay(today) && minutes >= from && minutes < to;
  }

  // Wraps midnight. Before `to` belongs to the *previous* day's window.
  if (minutes >= from) {
    return matchesDay(today);
  }
  if (minutes < to) {
    const yesterday = (today + 6) % 7;
    return matchesDay(yesterday);
  }
  return false;
}

/** Compiles a glob or regex rule, or reports why it could not be compiled. */
function compileRule(
  rule: { glob?: string | undefined; regex?: string | undefined },
  kind: PolicyProblem['kind'],
  problems: PolicyProblem[],
): CompiledRule | null {
  if (rule.glob !== undefined) {
    try {
      const matcher = picomatch(rule.glob, { dot: true, nocase: true });
      return { source: rule.glob, test: (relPath) => matcher(normalize(relPath)) };
    } catch (err) {
      problems.push({
        kind,
        rule: rule.glob,
        message: err instanceof Error ? err.message : 'Invalid glob',
      });
      return null;
    }
  }
  if (rule.regex !== undefined) {
    try {
      // `i` because SMB is case-insensitive: a rule that excluded `*.H` but not `*.h`
      // would behave differently depending on which machine wrote the file.
      const compiled = new RegExp(rule.regex, 'i');
      return { source: rule.regex, test: (relPath) => compiled.test(normalize(relPath)) };
    } catch (err) {
      problems.push({
        kind,
        rule: rule.regex,
        message: err instanceof Error ? err.message : 'Invalid regular expression',
      });
      return null;
    }
  }
  return null;
}

/**
 * Normalises a path for matching: forward slashes, no leading separator.
 *
 * Rules are written the way an operator sees paths in the UI (`PGM/PART1.H`), while the
 * engine may hold `\PGM\PART1.H` from an SMB client or `./PGM/PART1.H` from a walker.
 * Without this, a rule that looks obviously correct matches nothing.
 */
export function normalize(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export class SyncPolicyEngine {
  private readonly windows: readonly BandwidthWindow[];
  private readonly excludes: readonly CompiledRule[];
  private readonly readOnly: readonly CompiledRule[];
  private readonly priorities: readonly CompiledPriorityRule[];
  private readonly issues: PolicyProblem[] = [];

  constructor(policies: SyncPolicies) {
    this.windows = policies.bandwidthWindows;

    this.excludes = compileAll(policies.excludeRules, 'exclude', this.issues);
    this.readOnly = compileAll(policies.readOnlyRules, 'readOnly', this.issues);

    this.priorities = policies.priorityRules
      .map((rule): CompiledPriorityRule | null => {
        const compiled = compileRule(rule, 'priority', this.issues);
        return compiled === null ? null : { ...compiled, priority: rule.priority };
      })
      .filter((rule): rule is CompiledPriorityRule => rule !== null);
  }

  /** Rules that could not be compiled, so the UI can show them instead of silently dropping them. */
  get problems(): readonly PolicyProblem[] {
    return this.issues;
  }

  /**
   * The bandwidth ceiling in effect at `at`, or `null` for unlimited.
   *
   * First match wins, in the order the operator wrote them — the firewall model. It is
   * the only precedence under which "unlimited during the maintenance hour" can be
   * expressed above a broader daytime limit; most-restrictive-wins would make that
   * override unreachable.
   *
   * `fallback` applies when no window matches, and is the plain `bandwidthLimitKbps`.
   */
  bandwidthLimitAt(at: Date, fallback: number | null = null): number | null {
    for (const window of this.windows) {
      if (isWithinWindow(window, at)) {
        return window.limitKbps;
      }
    }
    return fallback;
  }

  /** The window that decided {@link bandwidthLimitAt}, for showing "why" in the UI. */
  activeWindow(at: Date): BandwidthWindow | undefined {
    return this.windows.find((window) => isWithinWindow(window, at));
  }

  /** True when the path must not be synced at all. */
  isExcluded(relPath: string): boolean {
    return this.excludes.some((rule) => rule.test(relPath));
  }

  /** True when the path may only travel server → TNC. */
  isReadOnly(relPath: string): boolean {
    return this.readOnly.some((rule) => rule.test(relPath));
  }

  /**
   * The sync priority of a path — lower runs first.
   *
   * The *lowest* matching priority wins rather than the first. Priority is a number with
   * an inherent ordering, so "most urgent rule wins" needs no knowledge of rule order,
   * and an operator adding an urgent rule at the bottom of the list still gets what they
   * asked for.
   */
  priorityOf(relPath: string): number {
    let best = DEFAULT_PRIORITY;
    let matched = false;
    for (const rule of this.priorities) {
      if (rule.test(relPath) && (!matched || rule.priority < best)) {
        best = rule.priority;
        matched = true;
      }
    }
    return best;
  }

  /**
   * Orders paths for transfer: priority first, then original order.
   *
   * The sort is stable on the input order, so files of equal priority keep whatever
   * ordering the queue gave them (size-ordered, from T20) instead of being shuffled.
   */
  sortByPriority<T>(items: readonly T[], pathOf: (item: T) => string): T[] {
    return items
      .map((item, index) => ({ item, index, priority: this.priorityOf(pathOf(item)) }))
      .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.index - b.index))
      .map((entry) => entry.item);
  }

  /** One call answering everything the sync loop needs about a path. */
  evaluate(relPath: string): {
    excluded: boolean;
    readOnly: boolean;
    priority: number;
  } {
    return {
      excluded: this.isExcluded(relPath),
      readOnly: this.isReadOnly(relPath),
      priority: this.priorityOf(relPath),
    };
  }
}

function compileAll(
  rules: readonly PathRule[],
  kind: PolicyProblem['kind'],
  problems: PolicyProblem[],
): CompiledRule[] {
  return rules
    .map((rule) => compileRule(rule, kind, problems))
    .filter((rule): rule is CompiledRule => rule !== null);
}

/** Re-exported so callers do not need the shared package for the rule shapes. */
export type { BandwidthWindow, PathRule, PriorityRule, SyncPolicies };
