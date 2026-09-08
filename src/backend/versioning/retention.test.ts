import { type FileVersion } from '../../shared';
import { planRetention, type RetentionPolicy } from './retention';

const DAY = 86_400;
const NOW = 1_700_000_000;

let nextId = 1;

function version(overrides: Partial<FileVersion> = {}): FileVersion {
  return {
    id: nextId++,
    shareId: 1,
    relPath: 'PGM/PART1.H',
    hash: 'a'.repeat(64),
    size: 1000,
    mtime: NOW * 1000,
    origin: 'server',
    reason: null,
    createdAt: NOW,
    pinned: false,
    ...overrides,
  };
}

/** Ages a version by whole days, which is the unit the policy is expressed in. */
const daysAgo = (days: number, overrides: Partial<FileVersion> = {}): FileVersion =>
  version({ createdAt: NOW - days * DAY, ...overrides });

const policy = (over: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  keepCount: 5,
  keepDays: 30,
  ...over,
});

beforeEach(() => {
  nextId = 1;
});

const idsOf = (versions: readonly { id: number }[]): number[] =>
  versions.map((v) => v.id).sort((a, b) => a - b);

describe('planRetention', () => {
  describe('count rule', () => {
    it('keeps the newest keepCount versions of a path', () => {
      const versions = [0, 1, 2, 3, 4, 5, 6, 7].map((d) => daysAgo(d));

      const plan = planRetention({ versions, policy: policy({ keepCount: 5 }), now: NOW });

      expect(plan.keep).toHaveLength(5);
      expect(plan.prune).toHaveLength(3);
      // The three oldest are the ones dropped.
      expect(idsOf(plan.prune.map((p) => p.version))).toEqual([6, 7, 8]);
      expect(plan.prune.every((p) => p.reason === 'over_count')).toBe(true);
    });

    it('applies the count per file, not across the whole store', () => {
      const busy = [0, 1, 2, 3, 4, 5].map((d) => daysAgo(d, { relPath: 'BUSY.H' }));
      const dormant = [0, 1].map((d) => daysAgo(d, { relPath: 'DORMANT.H' }));

      const plan = planRetention({
        versions: [...busy, ...dormant],
        policy: policy({ keepCount: 3, keepDays: 0 }),
        now: NOW,
      });

      // The dormant file keeps both of its versions; churn on BUSY.H does not evict them.
      const keptDormant = plan.keep.filter((v) => v.relPath === 'DORMANT.H');
      expect(keptDormant).toHaveLength(2);
      expect(plan.prune.every((p) => p.version.relPath === 'BUSY.H')).toBe(true);
    });

    it('separates identical paths belonging to different shares', () => {
      const shareOne = [0, 1, 2].map((d) => daysAgo(d, { shareId: 1 }));
      const shareTwo = [0, 1, 2].map((d) => daysAgo(d, { shareId: 2 }));

      const plan = planRetention({
        versions: [...shareOne, ...shareTwo],
        policy: policy({ keepCount: 3, keepDays: 0 }),
        now: NOW,
      });

      expect(plan.prune).toHaveLength(0);
      expect(plan.keep).toHaveLength(6);
    });
  });

  describe('age rule', () => {
    it('prunes versions older than keepDays', () => {
      const versions = [daysAgo(0), daysAgo(10), daysAgo(45), daysAgo(90)];

      const plan = planRetention({
        versions,
        policy: policy({ keepCount: 10, keepDays: 30 }),
        now: NOW,
      });

      expect(plan.prune.map((p) => p.reason)).toEqual(['too_old', 'too_old']);
      expect(idsOf(plan.prune.map((p) => p.version))).toEqual([3, 4]);
    });

    it('keeps the newest version of a path even when it is older than keepDays', () => {
      // A file untouched for a year: its history is the most likely to still be wanted,
      // so ageing it out entirely would be exactly backwards.
      const versions = [daysAgo(400), daysAgo(500)];

      const plan = planRetention({
        versions,
        policy: policy({ keepCount: 10, keepDays: 30 }),
        now: NOW,
      });

      expect(plan.keep).toHaveLength(1);
      expect(plan.keep[0]?.id).toBe(1);
      expect(plan.prune).toHaveLength(1);
    });

    it('disables the age rule when keepDays is 0', () => {
      const versions = [daysAgo(0), daysAgo(1000)];

      const plan = planRetention({
        versions,
        policy: policy({ keepCount: 10, keepDays: 0 }),
        now: NOW,
      });

      expect(plan.prune).toHaveLength(0);
    });
  });

  describe('protection', () => {
    it('never prunes a pinned version', () => {
      const versions = [daysAgo(0), daysAgo(100, { pinned: true }), daysAgo(200), daysAgo(300)];

      const plan = planRetention({
        versions,
        policy: policy({ keepCount: 1, keepDays: 30 }),
        now: NOW,
      });

      expect(plan.keep.map((v) => v.id)).toContain(2);
      expect(plan.prune.map((p) => p.version.id)).not.toContain(2);
    });

    it('does not let a pin consume a keepCount slot', () => {
      const pinnedOld = daysAgo(500, { pinned: true });
      const recent = [0, 1, 2].map((d) => daysAgo(d));

      const plan = planRetention({
        versions: [pinnedOld, ...recent],
        policy: policy({ keepCount: 3, keepDays: 0 }),
        now: NOW,
      });

      // All three recent versions survive alongside the pin, rather than the pin
      // displacing the oldest of them.
      expect(plan.prune).toHaveLength(0);
      expect(plan.keep).toHaveLength(4);
    });

    it('never prunes a version referenced by a conflict', () => {
      const versions = [daysAgo(0), daysAgo(100), daysAgo(200)];
      const referenced = new Set([2]);

      const plan = planRetention({
        versions,
        policy: policy({ keepCount: 1, keepDays: 30 }),
        referencedIds: referenced,
        now: NOW,
      });

      expect(plan.prune.map((p) => p.version.id)).not.toContain(2);
      expect(plan.prune.map((p) => p.version.id)).toContain(3);
    });
  });

  describe('reporting', () => {
    it('sums the sizes of pruned versions', () => {
      const versions = [
        daysAgo(0, { size: 100 }),
        daysAgo(100, { size: 250 }),
        daysAgo(200, { size: 400 }),
      ];

      const plan = planRetention({
        versions,
        policy: policy({ keepCount: 1, keepDays: 30 }),
        now: NOW,
      });

      expect(plan.reclaimableBytes).toBe(650);
    });

    it('produces a reproducible plan when versions share a timestamp', () => {
      const sameSecond = [1, 2, 3, 4].map(() => version({ createdAt: NOW }));

      const first = planRetention({
        versions: sameSecond,
        policy: policy({ keepCount: 2 }),
        now: NOW,
      });
      const second = planRetention({
        versions: [...sameSecond].reverse(),
        policy: policy({ keepCount: 2 }),
        now: NOW,
      });

      expect(idsOf(first.prune.map((p) => p.version))).toEqual(
        idsOf(second.prune.map((p) => p.version)),
      );
    });

    it('handles an empty input', () => {
      const plan = planRetention({ versions: [], policy: policy(), now: NOW });
      expect(plan).toEqual({ prune: [], keep: [], reclaimableBytes: 0 });
    });
  });
});
