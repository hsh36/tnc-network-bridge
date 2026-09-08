import { type NextFunction, type Request, type Response } from 'express';
import { HttpError } from '../web/envelope';

/**
 * Rate limiting for the config API (T43).
 *
 * A fixed window would let a caller send `2 * limit` requests across a window boundary —
 * `limit` at the very end of one and `limit` at the start of the next — which for a
 * "10 per minute" rule means 20 in a two-second span. This uses a **sliding window**:
 * timestamps within the trailing interval are counted, so the limit holds over every
 * possible interval rather than only the ones that happen to align with the clock.
 *
 * ## Why not `express-rate-limit` here
 *
 * It is already a dependency and is used for the login route, where its store abstraction
 * and standard headers earn their keep. This limiter exists for a different job: it keys
 * on the *authenticated principal* rather than the IP, and it has to feed the audit log
 * when it denies something. Both of those are the reason a denial is interesting at all —
 * "someone hit the config API 200 times in a minute" is a security event, and it needs to
 * name who.
 *
 * ## Memory
 *
 * Entries are pruned on access and by a periodic sweep, so a burst of distinct keys
 * cannot grow the map without bound. The sweep is `unref`'d: a rate limiter must never
 * be the reason the process will not exit.
 */

export interface RateLimitOptions {
  /** Requests permitted per window. */
  readonly limit: number;
  readonly windowMs: number;
  /**
   * Identifies the caller. Defaults to the session id, falling back to the token name
   * and then the IP — in that order, because an authenticated principal is the thing
   * worth limiting and worth naming in the audit log.
   */
  readonly keyOf?: (req: Request) => string;
  /** Called when a request is refused, for the audit log. */
  readonly onDenied?: (key: string, req: Request) => void;
  readonly now?: () => number;
}

export interface RateLimitState {
  readonly key: string;
  readonly hits: number;
  readonly resetInMs: number;
}

const DEFAULT_KEY = (req: Request): string => {
  if (req.session !== undefined) {
    return `session:${req.session.id}`;
  }
  if (req.apiToken !== undefined) {
    return `token:${String(req.apiToken.id)}`;
  }
  return `ip:${req.ip ?? 'unknown'}`;
};

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(options: { limit: number; windowMs: number; now?: () => number }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Records a hit and reports whether it is allowed.
   *
   * A denied request is *not* recorded. Recording it would mean a caller hammering the
   * endpoint keeps their own window permanently full and never recovers — a self-inflicted
   * lockout that outlasts the burst that caused it.
   */
  check(key: string): { allowed: boolean; state: RateLimitState } {
    const now = this.now();
    const cutoff = now - this.windowMs;

    const timestamps = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);

    if (timestamps.length >= this.limit) {
      this.hits.set(key, timestamps);
      const oldest = timestamps[0] ?? now;
      return {
        allowed: false,
        state: {
          key,
          hits: timestamps.length,
          resetInMs: Math.max(0, oldest + this.windowMs - now),
        },
      };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return {
      allowed: true,
      state: { key, hits: timestamps.length, resetInMs: this.windowMs },
    };
  }

  /** Forgets one key. Used when an operator's session is deliberately reset. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  resetAll(): void {
    this.hits.clear();
  }

  /** Drops keys with no hits inside the window. */
  prune(): number {
    const cutoff = this.now() - this.windowMs;
    let removed = 0;
    for (const [key, timestamps] of this.hits) {
      const live = timestamps.filter((ts) => ts > cutoff);
      if (live.length === 0) {
        this.hits.delete(key);
        removed += 1;
      } else {
        this.hits.set(key, live);
      }
    }
    return removed;
  }

  startSweeper(intervalMs = 60_000): void {
    if (this.sweeper !== undefined) {
      return;
    }
    this.sweeper = setInterval(() => this.prune(), intervalMs);
    this.sweeper.unref();
  }

  stopSweeper(): void {
    if (this.sweeper !== undefined) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

/**
 * Express middleware wrapping a {@link SlidingWindowLimiter}.
 *
 * Sets `Retry-After` and the `RateLimit-*` headers, because a client that is told to
 * back off can, and one that is only told "429" retries immediately and makes it worse.
 */
export function rateLimit(options: RateLimitOptions) {
  const limiter = new SlidingWindowLimiter({
    limit: options.limit,
    windowMs: options.windowMs,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  limiter.startSweeper();
  const keyOf = options.keyOf ?? DEFAULT_KEY;

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const key = keyOf(req);
    const { allowed, state } = limiter.check(key);

    res.setHeader('RateLimit-Limit', String(options.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, options.limit - state.hits)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(state.resetInMs / 1000)));

    if (!allowed) {
      const retryAfter = Math.ceil(state.resetInMs / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      options.onDenied?.(key, req);
      next(
        new HttpError(
          429,
          'RATE_LIMITED',
          'Too many requests — slow down and try again shortly',
          undefined,
          retryAfter,
        ),
      );
      return;
    }
    next();
  };

  // Exposed so a test can drive the limiter directly and the service can stop its sweeper.
  middleware.limiter = limiter;
  return middleware;
}
