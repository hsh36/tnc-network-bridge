import { type ScheduleKind, type ScheduleTarget } from '../../shared';
import { type DbLogger } from '../config/db';

/**
 * The job registry (T36): what each {@link ScheduleKind} actually does.
 *
 * Separated from the cron machinery in `scheduler.ts` for one reason — the scheduler is
 * about *when*, and it should be testable without any of the subsystems that answer
 * *what*. A test can register a counting handler and prove firing behaviour without a
 * Samba service, a GitHub client or a filesystem anywhere near it.
 *
 * Handlers are registered by the composition root, so this module depends on nothing
 * heavier than the shared types. A kind with no registered handler is not an error at
 * startup: it means that subsystem is not wired in this process, and the scheduler
 * records the run as `skipped` rather than failing.
 */

export interface JobContext {
  /** Why this run happened. Distinguishes a cron firing from an operator's test click. */
  readonly trigger: 'cron' | 'manual' | 'catchup';
  readonly scheduleId: number;
  readonly scheduleName: string;
  readonly target: ScheduleTarget | null;
  /** Unix seconds at which the run was considered due. */
  readonly firedAt: number;
  readonly logger?: DbLogger;
  /** Resolves when the service is shutting down, so a long job can bail out early. */
  readonly signal?: AbortSignal;
}

export interface JobOutcome {
  /** Free-form summary shown in the schedule history, e.g. "locked 14 paths". */
  readonly detail?: string;
  /**
   * A job that decided there was nothing to do. Distinct from success: an operator
   * looking at "skipped — server unreachable" learns something that "ok" would hide.
   */
  readonly skipped?: boolean;
}

/**
 * A job may be synchronous.
 *
 * Several of these genuinely are — flipping a lock window open is a database write and
 * nothing else — and forcing them to be `async` would be ceremony that buys nothing. The
 * scheduler awaits the result either way, which works uniformly on a value or a promise.
 */
export type JobHandler = (ctx: JobContext) => Promise<JobOutcome | void> | JobOutcome | void;

/**
 * Handlers by kind.
 *
 * A `Map` rather than an object literal so registration is explicitly a runtime act by
 * the composition root — the set of available jobs genuinely differs between the full
 * service, the dev server and a test.
 */
export class JobRegistry {
  private readonly handlers = new Map<ScheduleKind, JobHandler>();

  register(kind: ScheduleKind, handler: JobHandler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  get(kind: ScheduleKind): JobHandler | undefined {
    return this.handlers.get(kind);
  }

  has(kind: ScheduleKind): boolean {
    return this.handlers.has(kind);
  }

  get registered(): ScheduleKind[] {
    return [...this.handlers.keys()];
  }
}
