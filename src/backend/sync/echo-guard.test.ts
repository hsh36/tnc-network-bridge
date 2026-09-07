import {
  DEFAULT_MAX_SYNCS_PER_WINDOW,
  DEFAULT_TTL_MS,
  DEFAULT_WINDOW_MS,
  EchoGuard,
  type QuarantineEvent,
} from './echo-guard';

/**
 * T21 acceptance tests.
 *
 * Two criteria, and the first is the one that matters: **a full sync cycle generates zero
 * self-triggered follow-up syncs.** That is tested by simulating a whole cycle — the
 * engine declares its writes, the watcher and the scanner both report the events those
 * writes produce, and the guard must let none of them through. The second, an induced
 * loop tripping the quarantine inside a minute, is tested against an injected clock so it
 * takes no time at all to prove.
 */

/** Time under test control: nothing here should depend on how fast the host runs. */
class TestClock {
  private current = 1_700_000_000_000;

  readonly now = (): number => this.current;

  advance(ms: number): void {
    this.current += ms;
  }
}

// ---------------------------------------------------------------------------
// Expectation matching
// ---------------------------------------------------------------------------

describe('expectation matching', () => {
  it('drops the event its own write produced', () => {
    const guard = new EchoGuard();
    guard.expect({ path: 'PROG.H', size: 1024, mtimeMs: 5_000 });

    expect(guard.shouldDrop({ path: 'PROG.H', size: 1024, mtimeMs: 5_000 })).toBe(true);
  });

  it('lets a genuine edit through', () => {
    const guard = new EchoGuard();
    guard.expect({ path: 'PROG.H', size: 1024, mtimeMs: 5_000 });

    // Someone actually changed the file: different size, different time.
    expect(guard.shouldDrop({ path: 'PROG.H', size: 2048, mtimeMs: 9_000 })).toBe(false);
  });

  it('does not confuse one path with another', () => {
    const guard = new EchoGuard();
    guard.expect({ path: 'A.H', size: 1024, mtimeMs: 5_000 });

    expect(guard.shouldDrop({ path: 'B.H', size: 1024, mtimeMs: 5_000 })).toBe(false);
  });

  it('lets an event through when nothing was ever expected', () => {
    expect(new EchoGuard().shouldDrop({ path: 'NEW.H', size: 1, mtimeMs: 1 })).toBe(false);
  });

  it('tolerates the mtime resolution the filesystem actually reports', () => {
    const guard = new EchoGuard({ mtimeToleranceMs: 1_000 });
    guard.expect({ path: 'P.H', size: 10, mtimeMs: 5_000 });

    // The mount rounded our mtime; the size proves it is still our write.
    expect(guard.shouldDrop({ path: 'P.H', size: 10, mtimeMs: 5_400 })).toBe(true);
  });

  it('stops tolerating once the difference exceeds the window', () => {
    const guard = new EchoGuard({ mtimeToleranceMs: 1_000 });
    guard.expect({ path: 'P.H', size: 10, mtimeMs: 5_000 });

    expect(guard.shouldDrop({ path: 'P.H', size: 10, mtimeMs: 6_001 })).toBe(false);
  });

  it('requires the size to match exactly, whatever the mtime says', () => {
    const guard = new EchoGuard();
    guard.expect({ path: 'P.H', size: 10, mtimeMs: 5_000 });

    // A different size is a different file, and no clock tolerance can excuse it.
    expect(guard.shouldDrop({ path: 'P.H', size: 11, mtimeMs: 5_000 })).toBe(false);
  });

  it('keeps matching for as long as the expectation lives', () => {
    const guard = new EchoGuard();
    guard.expect({ path: 'P.H', size: 10, mtimeMs: 5_000 });

    // One write raises several events — a create and a change, or one per watcher when
    // a scan is running too. Consuming on first match would let the rest loop.
    for (let i = 0; i < 5; i += 1) {
      expect(guard.shouldDrop({ path: 'P.H', size: 10, mtimeMs: 5_000 })).toBe(true);
    }
    expect(guard.stats.dropped).toBe(5);
  });

  it('matches any of several outstanding writes to one path', () => {
    const guard = new EchoGuard();
    guard.expect({ path: 'P.H', size: 10, mtimeMs: 1_000 });
    guard.expect({ path: 'P.H', size: 20, mtimeMs: 2_000 });

    expect(guard.shouldDrop({ path: 'P.H', size: 20, mtimeMs: 2_000 })).toBe(true);
    expect(guard.shouldDrop({ path: 'P.H', size: 10, mtimeMs: 1_000 })).toBe(true);
    expect(guard.shouldDrop({ path: 'P.H', size: 30, mtimeMs: 3_000 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

describe('expiry', () => {
  it('forgets an expectation after its ten-second TTL', () => {
    const clock = new TestClock();
    const guard = new EchoGuard({ now: clock.now });
    guard.expect({ path: 'P.H', size: 10, mtimeMs: 5_000 });

    clock.advance(DEFAULT_TTL_MS + 1);

    // A file that genuinely looks like this ten seconds later is a real edit again.
    expect(guard.shouldDrop({ path: 'P.H', size: 10, mtimeMs: 5_000 })).toBe(false);
    expect(guard.stats.liveExpectations).toBe(0);
  });

  it('still matches just inside the TTL', () => {
    const clock = new TestClock();
    const guard = new EchoGuard({ now: clock.now });
    guard.expect({ path: 'P.H', size: 10, mtimeMs: 5_000 });

    clock.advance(DEFAULT_TTL_MS - 1);

    expect(guard.shouldDrop({ path: 'P.H', size: 10, mtimeMs: 5_000 })).toBe(true);
  });

  it('expires only the entries that are actually old', () => {
    const clock = new TestClock();
    const guard = new EchoGuard({ now: clock.now, ttlMs: 1_000 });
    guard.expect({ path: 'P.H', size: 10, mtimeMs: 1_000 });
    clock.advance(600);
    guard.expect({ path: 'P.H', size: 20, mtimeMs: 2_000 });
    clock.advance(600);

    guard.pruneExpired();

    expect(guard.stats.liveExpectations).toBe(1);
    expect(guard.shouldDrop({ path: 'P.H', size: 20, mtimeMs: 2_000 })).toBe(true);
  });

  it('does not grow without bound as expectations age out', () => {
    const clock = new TestClock();
    const guard = new EchoGuard({ now: clock.now, ttlMs: 100 });

    for (let i = 0; i < 1_000; i += 1) {
      guard.expect({ path: `FILE${i}.H`, size: i, mtimeMs: i });
      clock.advance(10);
    }
    guard.pruneExpired();

    // Only the last handful are still within the TTL.
    expect(guard.stats.liveExpectations).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// The acceptance criterion: a full cycle triggers nothing
// ---------------------------------------------------------------------------

describe('a full sync cycle generates zero self-triggered syncs', () => {
  it('drops every event its own writes produced, from watcher and scanner alike', () => {
    const guard = new EchoGuard();
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `sub/PROG${i}.H`,
      size: 1000 + i,
      mtimeMs: 1_700_000_000_000 + i * 10,
    }));

    // The engine declares every write before making it.
    for (const file of files) {
      guard.expect(file);
    }

    // The watcher reports each write, and so does the scanner running alongside it.
    const escaped: string[] = [];
    for (const file of files) {
      for (const _observer of ['watcher', 'scanner']) {
        if (!guard.shouldDrop(file)) {
          escaped.push(file.path);
        }
      }
    }

    // Nothing escaped, so nothing feeds back into the engine: no second cycle exists.
    expect(escaped).toEqual([]);
    expect(guard.stats.dropped).toBe(100);
    expect(guard.stats.passed).toBe(0);
  });

  it('still notices a real edit made during the same cycle', () => {
    const guard = new EchoGuard();
    guard.expect({ path: 'A.H', size: 100, mtimeMs: 1_000 });
    guard.expect({ path: 'B.H', size: 200, mtimeMs: 1_000 });

    const events = [
      { path: 'A.H', size: 100, mtimeMs: 1_000 }, // our echo
      { path: 'B.H', size: 200, mtimeMs: 1_000 }, // our echo
      { path: 'C.H', size: 300, mtimeMs: 2_000 }, // an operator at the machine
    ];
    const passed = events.filter((event) => !guard.shouldDrop(event));

    // Suppressing echoes must not suppress work.
    expect(passed.map((event) => event.path)).toEqual(['C.H']);
  });
});

// ---------------------------------------------------------------------------
// The acceptance criterion: an induced loop is quarantined
// ---------------------------------------------------------------------------

describe('loop quarantine', () => {
  it('trips within the minute when a path syncs in a loop', () => {
    const clock = new TestClock();
    const alerts: QuarantineEvent[] = [];
    const guard = new EchoGuard({ now: clock.now, onQuarantine: (e) => alerts.push(e) });

    // A loop syncing every two seconds: eleven syncs land inside the window.
    let trippedAfterMs: number | null = null;
    const startedAt = clock.now();
    for (let i = 0; i < 40 && trippedAfterMs === null; i += 1) {
      if (guard.recordSync('LOOPING.H')) {
        trippedAfterMs = clock.now() - startedAt;
      }
      clock.advance(2_000);
    }

    expect(trippedAfterMs).not.toBeNull();
    expect(trippedAfterMs).toBeLessThanOrEqual(DEFAULT_WINDOW_MS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ path: 'LOOPING.H', windowMs: DEFAULT_WINDOW_MS });
    expect(alerts[0]?.syncsInWindow).toBeGreaterThan(DEFAULT_MAX_SYNCS_PER_WINDOW);
  });

  it('allows exactly the permitted number of syncs before tripping', () => {
    const clock = new TestClock();
    const guard = new EchoGuard({ now: clock.now, maxSyncsPerWindow: 10, windowMs: 60_000 });

    for (let i = 0; i < 10; i += 1) {
      expect(guard.recordSync('BUSY.H')).toBe(false);
      clock.advance(100);
    }

    // The eleventh is the one that is no longer credible as work.
    expect(guard.recordSync('BUSY.H')).toBe(true);
  });

  it('does not trip on steady legitimate traffic spread across the window', () => {
    const clock = new TestClock();
    const guard = new EchoGuard({ now: clock.now, maxSyncsPerWindow: 10, windowMs: 60_000 });

    // One sync every ten seconds for an hour: busy, but never a loop.
    for (let i = 0; i < 360; i += 1) {
      expect(guard.recordSync('ACTIVE.H')).toBe(false);
      clock.advance(10_000);
    }

    expect(guard.isQuarantined('ACTIVE.H')).toBe(false);
  });

  it('counts each path separately', () => {
    const clock = new TestClock();
    const guard = new EchoGuard({ now: clock.now, maxSyncsPerWindow: 3, windowMs: 60_000 });

    for (let i = 0; i < 4; i += 1) {
      guard.recordSync('LOOP.H');
    }
    // A busy neighbour must not be quarantined for someone else's loop.
    expect(guard.isQuarantined('LOOP.H')).toBe(true);
    expect(guard.recordSync('CALM.H')).toBe(false);
    expect(guard.isQuarantined('CALM.H')).toBe(false);
  });

  it('keeps reporting a quarantined path as quarantined', () => {
    const guard = new EchoGuard({ maxSyncsPerWindow: 1 });

    guard.recordSync('L.H');
    expect(guard.recordSync('L.H')).toBe(true);

    // A caller that only reads the return value must not be able to resume the loop.
    expect(guard.recordSync('L.H')).toBe(true);
    expect(guard.recordSync('L.H')).toBe(true);
  });

  it('alerts once, not on every subsequent attempt', () => {
    const alerts: QuarantineEvent[] = [];
    const guard = new EchoGuard({ maxSyncsPerWindow: 1, onQuarantine: (e) => alerts.push(e) });

    for (let i = 0; i < 10; i += 1) {
      guard.recordSync('L.H');
    }

    expect(alerts).toHaveLength(1);
  });

  it('records what tripped it, so the log can explain itself', () => {
    const clock = new TestClock();
    const guard = new EchoGuard({ now: clock.now, maxSyncsPerWindow: 2, windowMs: 30_000 });

    for (let i = 0; i < 3; i += 1) {
      guard.recordSync('L.H');
    }
    const event = guard.quarantineFor('L.H');

    expect(event).toMatchObject({ path: 'L.H', syncsInWindow: 3, windowMs: 30_000 });
    expect(event?.at).toBe(clock.now());
  });

  it('reports nothing for a path that is fine', () => {
    expect(new EchoGuard().quarantineFor('OK.H')).toBeNull();
  });

  it('lists what is quarantined', () => {
    const guard = new EchoGuard({ maxSyncsPerWindow: 1 });
    guard.recordSync('A.H');
    guard.recordSync('A.H');
    guard.recordSync('B.H');
    guard.recordSync('B.H');

    expect(
      guard
        .listQuarantined()
        .map((e) => e.path)
        .sort(),
    ).toEqual(['A.H', 'B.H']);
  });

  it('releases a quarantine only when asked, and forgets the history with it', () => {
    const guard = new EchoGuard({ maxSyncsPerWindow: 2 });
    for (let i = 0; i < 3; i += 1) {
      guard.recordSync('L.H');
    }

    expect(guard.release('L.H')).toBe(true);
    expect(guard.isQuarantined('L.H')).toBe(false);
    // The history went too, so the path is not instantly re-quarantined by its past.
    expect(guard.recordSync('L.H')).toBe(false);
  });

  it('reports releasing a path that was not quarantined', () => {
    expect(new EchoGuard().release('never.H')).toBe(false);
  });

  it('never releases itself on a timer', () => {
    const clock = new TestClock();
    const guard = new EchoGuard({ now: clock.now, maxSyncsPerWindow: 1 });
    guard.recordSync('L.H');
    guard.recordSync('L.H');

    // An automatic release would restart the loop on a schedule, turning a stopped
    // fault into a periodic one that is harder to diagnose and no less damaging.
    clock.advance(24 * 60 * 60 * 1000);

    expect(guard.isQuarantined('L.H')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

describe('bookkeeping', () => {
  it('bounds the paths it tracks for rate limiting', () => {
    const guard = new EchoGuard({ maxTrackedPaths: 100 });

    for (let i = 0; i < 5_000; i += 1) {
      guard.recordSync(`FILE${i}.H`);
    }

    expect(guard.stats.trackedPaths).toBe(100);
  });

  it('forgets the least recently synced path first', () => {
    const guard = new EchoGuard({ maxTrackedPaths: 2, maxSyncsPerWindow: 1 });

    guard.recordSync('OLD.H');
    guard.recordSync('MID.H');
    // Touching OLD.H again makes MID.H the least recently seen.
    guard.recordSync('OLD.H');
    guard.recordSync('NEW.H');

    // OLD.H was synced twice and survived eviction, so its second sync tripped it.
    expect(guard.isQuarantined('OLD.H')).toBe(true);
    expect(guard.stats.trackedPaths).toBe(2);
  });

  it('reports what it has been doing', () => {
    const guard = new EchoGuard();
    guard.expect({ path: 'A.H', size: 1, mtimeMs: 1 });
    guard.shouldDrop({ path: 'A.H', size: 1, mtimeMs: 1 });
    guard.shouldDrop({ path: 'B.H', size: 1, mtimeMs: 1 });
    guard.recordSync('A.H');

    expect(guard.stats).toEqual({
      liveExpectations: 1,
      dropped: 1,
      passed: 1,
      trackedPaths: 1,
      quarantined: 0,
    });
  });

  it('clears everything for a full resync', () => {
    const guard = new EchoGuard({ maxSyncsPerWindow: 1 });
    guard.expect({ path: 'A.H', size: 1, mtimeMs: 1 });
    guard.shouldDrop({ path: 'A.H', size: 1, mtimeMs: 1 });
    guard.recordSync('A.H');
    guard.recordSync('A.H');

    guard.clear();

    expect(guard.stats).toEqual({
      liveExpectations: 0,
      dropped: 0,
      passed: 0,
      trackedPaths: 0,
      quarantined: 0,
    });
    expect(guard.isQuarantined('A.H')).toBe(false);
  });

  it('uses the real clock when none is injected', () => {
    const guard = new EchoGuard({ ttlMs: 0 });
    guard.expect({ path: 'A.H', size: 1, mtimeMs: 1 });

    // A zero TTL expires against whatever clock is in use, proving one is wired up.
    expect(guard.shouldDrop({ path: 'A.H', size: 1, mtimeMs: 1 })).toBe(false);
  });

  it('exposes the defaults the plan specifies', () => {
    expect(DEFAULT_TTL_MS).toBe(10_000);
    expect(DEFAULT_MAX_SYNCS_PER_WINDOW).toBe(10);
    expect(DEFAULT_WINDOW_MS).toBe(60_000);
  });
});
