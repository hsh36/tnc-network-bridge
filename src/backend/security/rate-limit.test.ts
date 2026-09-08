import { SlidingWindowLimiter } from './rate-limit';

let clock: number;
let limiter: SlidingWindowLimiter;

beforeEach(() => {
  clock = 1_700_000_000_000;
  limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000, now: () => clock });
});

afterEach(() => {
  limiter.stopSweeper();
});

describe('SlidingWindowLimiter', () => {
  it('allows up to the limit', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check('a').allowed).toBe(true);
    }
  });

  it('refuses the request past the limit', () => {
    for (let i = 0; i < 3; i += 1) {
      limiter.check('a');
    }
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('keeps keys independent', () => {
    for (let i = 0; i < 3; i += 1) {
      limiter.check('a');
    }
    expect(limiter.check('b').allowed).toBe(true);
  });

  it('lets requests through again once they age out', () => {
    for (let i = 0; i < 3; i += 1) {
      limiter.check('a');
    }
    expect(limiter.check('a').allowed).toBe(false);

    clock += 60_001;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('slides rather than resetting on a boundary', () => {
    // The fixed-window bug: `limit` requests at the end of one window and `limit` more
    // at the start of the next would allow 2*limit in a moment. A sliding window must
    // not do that.
    limiter.check('a');
    limiter.check('a');
    clock += 59_000;
    limiter.check('a');

    // Three in the trailing window already, so the fourth is refused even though a
    // fixed window would have just rolled over.
    expect(limiter.check('a').allowed).toBe(false);

    // Only after the first two age out does capacity return.
    clock += 1500;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('does not count a refused request against the window', () => {
    for (let i = 0; i < 3; i += 1) {
      limiter.check('a');
    }
    // Hammering while blocked must not extend the block indefinitely.
    for (let i = 0; i < 50; i += 1) {
      limiter.check('a');
    }

    clock += 60_001;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('reports how long until capacity returns', () => {
    limiter.check('a');
    clock += 10_000;
    limiter.check('a');
    limiter.check('a');

    const { state } = limiter.check('a');
    // The oldest hit was 10s ago, so ~50s remain on it.
    expect(state.resetInMs).toBeGreaterThan(49_000);
    expect(state.resetInMs).toBeLessThanOrEqual(50_000);
  });

  it('reports the current hit count', () => {
    expect(limiter.check('a').state.hits).toBe(1);
    expect(limiter.check('a').state.hits).toBe(2);
  });

  describe('memory', () => {
    it('drops keys with no hits inside the window', () => {
      limiter.check('a');
      limiter.check('b');
      expect(limiter.size).toBe(2);

      clock += 60_001;
      expect(limiter.prune()).toBe(2);
      expect(limiter.size).toBe(0);
    });

    it('keeps keys that are still active', () => {
      limiter.check('a');
      clock += 30_000;
      limiter.check('b');

      clock += 31_000;
      limiter.prune();

      // `a` has aged out; `b` has not.
      expect(limiter.size).toBe(1);
    });

    it('does not grow without bound across many distinct keys', () => {
      for (let i = 0; i < 500; i += 1) {
        limiter.check(`key-${String(i)}`);
      }
      expect(limiter.size).toBe(500);

      clock += 60_001;
      limiter.prune();
      expect(limiter.size).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears one key', () => {
      for (let i = 0; i < 3; i += 1) {
        limiter.check('a');
      }
      limiter.reset('a');
      expect(limiter.check('a').allowed).toBe(true);
    });

    it('clears everything', () => {
      limiter.check('a');
      limiter.check('b');
      limiter.resetAll();
      expect(limiter.size).toBe(0);
    });
  });

  describe('sweeper', () => {
    it('starts and stops idempotently', () => {
      limiter.startSweeper(1000);
      limiter.startSweeper(1000);
      limiter.stopSweeper();
      limiter.stopSweeper();
      // Reaching here without a hang is the assertion: the timer is unref'd, so it
      // cannot be the reason the process refuses to exit.
      expect(limiter.size).toBe(0);
    });
  });
});
