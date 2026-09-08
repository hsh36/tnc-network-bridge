import { syncPoliciesSchema, type SyncPolicies } from '../../shared';
import {
  DEFAULT_PRIORITY,
  isWithinWindow,
  normalize,
  parseTimeOfDay,
  SyncPolicyEngine,
} from './policies';

const policies = (over: Partial<SyncPolicies> = {}): SyncPolicies =>
  syncPoliciesSchema.parse({
    bandwidthWindows: [],
    priorityRules: [],
    excludeRules: [],
    readOnlyRules: [],
    ...over,
  });

/** A local-time Date, which is the zone the windows are expressed in. */
const at = (day: number, hour: number, minute = 0): Date => {
  // 2026-09-06 is a Sunday, so `day` maps directly onto getDay().
  const date = new Date(2026, 8, 6 + day, hour, minute, 0, 0);
  return date;
};

describe('parseTimeOfDay', () => {
  it('converts to minutes since midnight', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('06:30')).toBe(390);
    expect(parseTimeOfDay('23:59')).toBe(1439);
  });
});

describe('normalize', () => {
  it('accepts the separators a rule might be written with', () => {
    expect(normalize('PGM\\PART1.H')).toBe('PGM/PART1.H');
    expect(normalize('./PGM/PART1.H')).toBe('PGM/PART1.H');
    expect(normalize('/PGM/PART1.H')).toBe('PGM/PART1.H');
  });
});

describe('isWithinWindow', () => {
  const window = (over: Record<string, unknown> = {}) => ({
    label: '',
    days: [] as number[],
    from: '09:00',
    to: '17:00',
    limitKbps: 1000,
    ...over,
  });

  it('matches inside an ordinary window', () => {
    expect(isWithinWindow(window(), at(1, 12))).toBe(true);
  });

  it('excludes the moment the window ends', () => {
    // Half-open, so two adjacent windows do not both claim 17:00.
    expect(isWithinWindow(window(), at(1, 17))).toBe(false);
    expect(isWithinWindow(window(), at(1, 16, 59))).toBe(true);
  });

  it('includes the moment the window starts', () => {
    expect(isWithinWindow(window(), at(1, 9))).toBe(true);
  });

  it('is false outside the window', () => {
    expect(isWithinWindow(window(), at(1, 8))).toBe(false);
    expect(isWithinWindow(window(), at(1, 20))).toBe(false);
  });

  describe('windows that wrap past midnight', () => {
    const night = window({ from: '22:00', to: '06:00' });

    it('matches late in the evening', () => {
      // A naive `from <= t && t < to` is false all day for this window.
      expect(isWithinWindow(night, at(1, 23))).toBe(true);
    });

    it('matches early the next morning', () => {
      expect(isWithinWindow(night, at(2, 2))).toBe(true);
    });

    it('does not match the middle of the day', () => {
      expect(isWithinWindow(night, at(1, 12))).toBe(false);
    });

    it('excludes the moment it ends', () => {
      expect(isWithinWindow(night, at(2, 6))).toBe(false);
      expect(isWithinWindow(night, at(2, 5, 59))).toBe(true);
    });
  });

  describe('day filtering', () => {
    it('applies every day when no days are given', () => {
      const w = window({ days: [] });
      for (let day = 0; day < 7; day += 1) {
        expect(isWithinWindow(w, at(day, 12))).toBe(true);
      }
    });

    it('restricts to the listed days', () => {
      const weekdays = window({ days: [1, 2, 3, 4, 5] });
      expect(isWithinWindow(weekdays, at(1, 12))).toBe(true); // Monday
      expect(isWithinWindow(weekdays, at(0, 12))).toBe(false); // Sunday
      expect(isWithinWindow(weekdays, at(6, 12))).toBe(false); // Saturday
    });

    it('credits a wrapped window to the day it started on', () => {
      // "Friday night" means Friday 22:00 through Saturday 06:00.
      const fridayNight = window({ days: [5], from: '22:00', to: '06:00' });

      expect(isWithinWindow(fridayNight, at(5, 23))).toBe(true);
      expect(isWithinWindow(fridayNight, at(6, 2))).toBe(true);
      // Saturday night is not Friday night.
      expect(isWithinWindow(fridayNight, at(6, 23))).toBe(false);
      // Friday 02:00 belongs to Thursday night, which was not configured.
      expect(isWithinWindow(fridayNight, at(5, 2))).toBe(false);
    });
  });

  it('treats a zero-length window as the whole day', () => {
    const allDay = window({ from: '00:00', to: '00:00', days: [0] });
    expect(isWithinWindow(allDay, at(0, 3))).toBe(true);
    expect(isWithinWindow(allDay, at(0, 18))).toBe(true);
    expect(isWithinWindow(allDay, at(1, 18))).toBe(false);
  });
});

describe('bandwidthLimitAt', () => {
  it('returns the fallback when no window matches', () => {
    const engine = new SyncPolicyEngine(policies());
    expect(engine.bandwidthLimitAt(at(1, 12), 500)).toBe(500);
  });

  it('returns null for unlimited when there is no fallback', () => {
    const engine = new SyncPolicyEngine(policies());
    expect(engine.bandwidthLimitAt(at(1, 12))).toBeNull();
  });

  it('applies a matching window', () => {
    const engine = new SyncPolicyEngine(
      policies({
        bandwidthWindows: [
          { label: 'shift', days: [], from: '07:00', to: '18:00', limitKbps: 2000 },
        ],
      }),
    );

    expect(engine.bandwidthLimitAt(at(1, 12), 9999)).toBe(2000);
    expect(engine.bandwidthLimitAt(at(1, 22), 9999)).toBe(9999);
  });

  it('lets an earlier window override a later, broader one', () => {
    // First match wins, so an "unlimited during maintenance" rule can sit above a
    // broad daytime limit. Most-restrictive-wins would make this inexpressible.
    const engine = new SyncPolicyEngine(
      policies({
        bandwidthWindows: [
          { label: 'maintenance', days: [], from: '02:00', to: '04:00', limitKbps: null },
          { label: 'always', days: [], from: '00:00', to: '00:00', limitKbps: 500 },
        ],
      }),
    );

    expect(engine.bandwidthLimitAt(at(1, 3))).toBeNull();
    expect(engine.bandwidthLimitAt(at(1, 12))).toBe(500);
  });

  it('throttles harder overnight when configured to', () => {
    const engine = new SyncPolicyEngine(
      policies({
        bandwidthWindows: [
          { label: 'night', days: [], from: '22:00', to: '06:00', limitKbps: 10_000 },
          { label: 'day', days: [], from: '06:00', to: '22:00', limitKbps: 1000 },
        ],
      }),
    );

    expect(engine.bandwidthLimitAt(at(1, 23))).toBe(10_000);
    expect(engine.bandwidthLimitAt(at(2, 3))).toBe(10_000);
    expect(engine.bandwidthLimitAt(at(2, 12))).toBe(1000);
  });

  it('reports which window decided the limit', () => {
    const engine = new SyncPolicyEngine(
      policies({
        bandwidthWindows: [
          { label: 'peak', days: [], from: '07:00', to: '18:00', limitKbps: 1000 },
        ],
      }),
    );

    expect(engine.activeWindow(at(1, 12))?.label).toBe('peak');
    expect(engine.activeWindow(at(1, 22))).toBeUndefined();
  });
});

describe('exclusion', () => {
  it('matches a glob rule', () => {
    const engine = new SyncPolicyEngine(policies({ excludeRules: [{ glob: '**/*.bak' }] }));

    expect(engine.isExcluded('PGM/PART1.bak')).toBe(true);
    expect(engine.isExcluded('PGM/PART1.H')).toBe(false);
  });

  it('matches a regex rule', () => {
    const engine = new SyncPolicyEngine(policies({ excludeRules: [{ regex: '^TEMP/.*' }] }));

    expect(engine.isExcluded('TEMP/scratch.H')).toBe(true);
    expect(engine.isExcluded('PGM/PART1.H')).toBe(false);
  });

  it('matches case-insensitively, because SMB is', () => {
    const engine = new SyncPolicyEngine(policies({ excludeRules: [{ glob: '**/*.BAK' }] }));
    // The same file must not be excluded or not depending on which machine wrote it.
    expect(engine.isExcluded('PGM/part1.bak')).toBe(true);
  });

  it('accepts backslash separators from an SMB client', () => {
    const engine = new SyncPolicyEngine(policies({ excludeRules: [{ glob: 'TEMP/**' }] }));
    expect(engine.isExcluded('TEMP\\scratch.H')).toBe(true);
  });

  it('excludes nothing when no rules are set', () => {
    const engine = new SyncPolicyEngine(policies());
    expect(engine.isExcluded('anything.H')).toBe(false);
  });
});

describe('read-only rules', () => {
  it('marks matching paths as one-way', () => {
    const engine = new SyncPolicyEngine(policies({ readOnlyRules: [{ glob: 'REFERENCE/**' }] }));

    expect(engine.isReadOnly('REFERENCE/TOOLS.TAB')).toBe(true);
    expect(engine.isReadOnly('PGM/PART1.H')).toBe(false);
  });

  it('is independent of exclusion', () => {
    const engine = new SyncPolicyEngine(
      policies({
        excludeRules: [{ glob: '**/*.bak' }],
        readOnlyRules: [{ glob: 'REFERENCE/**' }],
      }),
    );

    expect(engine.evaluate('REFERENCE/T.TAB')).toEqual({
      excluded: false,
      readOnly: true,
      priority: DEFAULT_PRIORITY,
    });
  });
});

describe('priority', () => {
  it('defaults when nothing matches', () => {
    const engine = new SyncPolicyEngine(policies());
    expect(engine.priorityOf('PGM/PART1.H')).toBe(DEFAULT_PRIORITY);
  });

  it('applies a matching rule', () => {
    const engine = new SyncPolicyEngine(
      policies({ priorityRules: [{ glob: 'URGENT/**', priority: 0 }] }),
    );

    expect(engine.priorityOf('URGENT/NOW.H')).toBe(0);
    expect(engine.priorityOf('PGM/LATER.H')).toBe(DEFAULT_PRIORITY);
  });

  it('takes the most urgent of several matching rules, regardless of order', () => {
    const engine = new SyncPolicyEngine(
      policies({
        priorityRules: [
          { glob: '**/*.H', priority: 40 },
          { glob: 'URGENT/**', priority: 5 },
        ],
      }),
    );

    // An operator adding an urgent rule at the bottom still gets what they asked for.
    expect(engine.priorityOf('URGENT/NOW.H')).toBe(5);
  });

  it('orders a list, keeping the input order within a priority', () => {
    const engine = new SyncPolicyEngine(
      policies({ priorityRules: [{ glob: 'URGENT/**', priority: 0 }] }),
    );
    const files = ['a.H', 'URGENT/one.H', 'b.H', 'URGENT/two.H'];

    const sorted = engine.sortByPriority(files, (f) => f);

    expect(sorted).toEqual(['URGENT/one.H', 'URGENT/two.H', 'a.H', 'b.H']);
  });

  it('leaves a list untouched when no rule matches', () => {
    const engine = new SyncPolicyEngine(policies());
    const files = ['c.H', 'a.H', 'b.H'];
    // Stable, so the queue's own size ordering survives.
    expect(engine.sortByPriority(files, (f) => f)).toEqual(files);
  });
});

describe('invalid rules', () => {
  it('drops a regex that does not compile and reports why', () => {
    const engine = new SyncPolicyEngine(policies({ excludeRules: [{ regex: '([unclosed' }] }));

    // Throwing at match time would take down the scan for every file; matching
    // everything would be worse.
    expect(engine.isExcluded('anything.H')).toBe(false);
    expect(engine.problems).toHaveLength(1);
    expect(engine.problems[0]?.kind).toBe('exclude');
    expect(engine.problems[0]?.rule).toBe('([unclosed');
  });

  it('keeps the valid rules alongside a broken one', () => {
    const engine = new SyncPolicyEngine(
      policies({ excludeRules: [{ regex: '([bad' }, { glob: '**/*.bak' }] }),
    );

    expect(engine.isExcluded('x.bak')).toBe(true);
    expect(engine.problems).toHaveLength(1);
  });

  it('reports no problems for a valid policy set', () => {
    const engine = new SyncPolicyEngine(
      policies({ excludeRules: [{ glob: '**/*.bak' }], readOnlyRules: [{ regex: '^REF/' }] }),
    );
    expect(engine.problems).toHaveLength(0);
  });
});

describe('schema', () => {
  it('refuses a rule that is both a glob and a regex', () => {
    expect(() =>
      syncPoliciesSchema.parse({
        bandwidthWindows: [],
        priorityRules: [],
        excludeRules: [{ glob: '*.h', regex: '.*' }],
        readOnlyRules: [],
      }),
    ).toThrow();
  });

  it('refuses a rule that is neither', () => {
    expect(() =>
      syncPoliciesSchema.parse({
        bandwidthWindows: [],
        priorityRules: [],
        excludeRules: [{}],
        readOnlyRules: [],
      }),
    ).toThrow();
  });

  it('refuses a malformed time', () => {
    expect(() =>
      syncPoliciesSchema.parse({
        bandwidthWindows: [{ from: '25:00', to: '06:00', limitKbps: 100 }],
        priorityRules: [],
        excludeRules: [],
        readOnlyRules: [],
      }),
    ).toThrow();
  });

  it('accepts an empty policy set', () => {
    expect(() => policies()).not.toThrow();
  });
});
