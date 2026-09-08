import { Cron } from 'croner';
import {
  scheduleTargetSchema,
  type CreateScheduleRequest,
  type Schedule,
  type ScheduleKind,
  type ScheduleTarget,
} from '../../shared';
import { type Db, type DbLogger } from '../config/db';
import { type AuditLog } from '../security/audit-log';
import { type JobRegistry, type JobContext, type JobOutcome } from './jobs';

/**
 * The cron engine (T36).
 *
 * SQLite is the source of truth; croner is only the timer. Every schedule lives as a
 * `schedules` row, and the in-memory {@link Cron} objects are a cache rebuilt from those
 * rows — so a restart, a crash or an edit from another process all converge on the same
 * state without a reconciliation step.
 *
 * ## Overlap
 *
 * A job that is still running when its next tick arrives does **not** start a second
 * copy. This is not a performance concern, it is a correctness one: `prune` deleting
 * versions concurrently with itself, or two `scan` passes racing over the same file
 * index, produce interleavings no amount of downstream locking makes safe. croner's
 * `protect` option gives exactly this, and the skipped tick is recorded so the operator
 * can see a job is running longer than its interval.
 *
 * ## Missed runs
 *
 * A Pi that was powered off over the weekend wakes up with a `next_run_at` far in the
 * past. Firing every missed occurrence would be actively harmful — six nightly prunes at
 * once — so a missed schedule fires **once**, marked `catchup`, and then resumes its
 * normal cadence. Catch-up is opt-in per kind, because for `restart` even one is wrong.
 *
 * ## Timezone
 *
 * Cron expressions are evaluated in the host's local zone, which is what an operator
 * writing "22:00" means. Storing UTC and converting would be defensible, but a
 * maintenance window that silently shifts by an hour when the site moves to summer time
 * is the kind of surprise that gets a bridge unplugged.
 */

/** Kinds where firing a missed occurrence on startup is the right behaviour. */
const CATCHUP_KINDS: ReadonlySet<ScheduleKind> = new Set<ScheduleKind>(['prune', 'scan', 'backup']);

export type ScheduleResult = 'ok' | 'error' | 'skipped';

export interface SchedulerOptions {
  readonly db: Db;
  readonly jobs: JobRegistry;
  readonly logger?: DbLogger;
  readonly audit?: AuditLog;
  /** Unix seconds. Injected so tests can reason about `next_run_at` deterministically. */
  readonly now?: () => number;
  /**
   * Grace period, in seconds, before a stale `next_run_at` counts as a missed run worth
   * catching up. Ticks are never this precise; without a grace window an ordinary
   * restart would replay the run that fired seconds earlier.
   */
  readonly catchupGraceS?: number;
}

interface ScheduleRow {
  id: number;
  name: string;
  kind: string;
  cron: string;
  target: string | null;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  last_result: string | null;
  last_error: string | null;
}

export class InvalidCronError extends Error {
  constructor(
    readonly expression: string,
    cause?: string,
  ) {
    super(`Not a usable cron expression: ${expression}${cause === undefined ? '' : ` (${cause})`}`);
    this.name = 'InvalidCronError';
  }
}

/**
 * A partial update.
 *
 * Every field is explicitly `| undefined` rather than merely optional, because
 * `exactOptionalPropertyTypes` is on: the API hands us an object parsed from a
 * `.partial()` schema, where an absent field really is present-and-undefined. Declaring
 * that honestly is what lets the route pass its parsed body straight through.
 */
export interface ScheduleChanges {
  readonly name?: string | undefined;
  readonly cron?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly target?: ScheduleTarget | null | undefined;
}

export class ScheduleNotFoundError extends Error {
  constructor(readonly id: number) {
    super(`No schedule with id ${id}`);
    this.name = 'ScheduleNotFoundError';
  }
}

function parseTarget(raw: string | null): ScheduleTarget | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = scheduleTargetSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    // A row whose JSON no longer parses is data corruption, not a crash-worthy defect;
    // the job simply runs without a target rather than taking the scheduler down.
    return null;
  }
}

export function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ScheduleKind,
    cron: row.cron,
    target: parseTarget(row.target),
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastResult: row.last_result as 'ok' | 'error' | 'skipped' | null,
    lastError: row.last_error,
  };
}

/**
 * Validates a cron expression by actually asking croner for its next occurrence.
 *
 * A regex can confirm five fields; only the parser can confirm that `0 25 * * *` names
 * an hour that does not exist, or that `0 0 30 2 *` never fires at all. Both are
 * mistakes an operator makes in the UI, and both must be rejected at write time rather
 * than discovered as silence three weeks later.
 */
export function validateCron(expression: string): Date {
  let job: Cron;
  try {
    job = new Cron(expression, { paused: true });
  } catch (err) {
    throw new InvalidCronError(expression, err instanceof Error ? err.message : undefined);
  }
  const next = job.nextRun();
  job.stop();
  if (next === null) {
    throw new InvalidCronError(expression, 'it has no future occurrence');
  }
  return next;
}

/** The next `count` occurrences, for the UI's "when will this run?" preview. */
export function previewRuns(expression: string, count = 5): Date[] {
  validateCron(expression);
  const job = new Cron(expression, { paused: true });
  const runs = job.nextRuns(count);
  job.stop();
  return runs;
}

export class Scheduler {
  private readonly db: Db;
  readonly jobs: JobRegistry;
  private readonly logger: DbLogger | undefined;
  private readonly audit: AuditLog | undefined;
  private readonly now: () => number;
  private readonly catchupGraceS: number;

  private readonly crons = new Map<number, Cron>();
  private readonly abort = new AbortController();
  private started = false;
  /** Resolves when every in-flight job has settled — the shutdown barrier. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.jobs = options.jobs;
    this.logger = options.logger;
    this.audit = options.audit;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.catchupGraceS = options.catchupGraceS ?? 300;
  }

  // -------------------------------------------------------------------------
  // CRUD — every mutation reprograms the timer, so the two never diverge
  // -------------------------------------------------------------------------

  list(options: { kind?: ScheduleKind; enabled?: boolean; limit?: number; offset?: number } = {}): {
    items: Schedule[];
    total: number;
  } {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (options.kind !== undefined) {
      where.push('kind = @kind');
      params.kind = options.kind;
    }
    if (options.enabled !== undefined) {
      where.push('enabled = @enabled');
      params.enabled = options.enabled ? 1 : 0;
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = this.db.pluck<number>(`SELECT count(*) FROM schedules ${clause}`, params) ?? 0;
    const rows = this.db.all<ScheduleRow>(
      `SELECT * FROM schedules ${clause} ORDER BY id LIMIT @limit OFFSET @offset`,
      { ...params, limit: options.limit ?? 100, offset: options.offset ?? 0 },
    );
    return { items: rows.map(rowToSchedule), total };
  }

  get(id: number): Schedule | undefined {
    const row = this.db.get<ScheduleRow>('SELECT * FROM schedules WHERE id = @id', { id });
    return row === undefined ? undefined : rowToSchedule(row);
  }

  require(id: number): Schedule {
    const schedule = this.get(id);
    if (schedule === undefined) {
      throw new ScheduleNotFoundError(id);
    }
    return schedule;
  }

  /** Creates a schedule. The cron expression is parsed before anything is written. */
  create(input: CreateScheduleRequest, actor = 'admin'): Schedule {
    const next = validateCron(input.cron);

    const result = this.db.run(
      `INSERT INTO schedules (name, kind, cron, target, enabled, next_run_at)
       VALUES (@name, @kind, @cron, @target, @enabled, @nextRunAt)`,
      {
        name: input.name,
        kind: input.kind,
        cron: input.cron,
        target: input.target === null ? null : JSON.stringify(input.target),
        enabled: input.enabled ? 1 : 0,
        nextRunAt: Math.floor(next.getTime() / 1000),
      },
    );

    const schedule = this.require(Number(result.lastInsertRowid));
    this.audit?.record({
      actor,
      action: 'schedule.create',
      target: schedule.name,
      detail: `${schedule.kind} on "${schedule.cron}"`,
    });
    this.program(schedule);
    return schedule;
  }

  update(id: number, changes: ScheduleChanges, actor = 'admin'): Schedule {
    const existing = this.require(id);
    const cron = changes.cron ?? existing.cron;
    const next = validateCron(cron);

    this.db.run(
      `UPDATE schedules
          SET name = @name, cron = @cron, target = @target,
              enabled = @enabled, next_run_at = @nextRunAt
        WHERE id = @id`,
      {
        id,
        name: changes.name ?? existing.name,
        cron,
        target:
          changes.target === undefined
            ? existing.target === null
              ? null
              : JSON.stringify(existing.target)
            : changes.target === null
              ? null
              : JSON.stringify(changes.target),
        enabled: (changes.enabled ?? existing.enabled) ? 1 : 0,
        nextRunAt: Math.floor(next.getTime() / 1000),
      },
    );

    const schedule = this.require(id);
    this.audit?.record({ actor, action: 'schedule.update', target: schedule.name });
    this.program(schedule);
    return schedule;
  }

  delete(id: number, actor = 'admin'): void {
    const existing = this.require(id);
    this.unprogram(id);
    this.db.run('DELETE FROM schedules WHERE id = @id', { id });
    this.audit?.record({ actor, action: 'schedule.delete', target: existing.name });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Programs every enabled schedule and fires any that were missed while stopped.
   *
   * Catch-up runs first and sequentially: a Pi that has been off for a week should scan
   * before it prunes, not both at once on a cold page cache.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    const { items } = this.list({ limit: 1000 });
    for (const schedule of items) {
      if (schedule.enabled) {
        this.program(schedule);
      }
    }

    await this.runMissed(items);
    this.logger?.info({ count: this.crons.size }, 'scheduler started');
  }

  /** Fires each schedule whose due time passed while the service was down — once only. */
  private async runMissed(schedules: readonly Schedule[]): Promise<void> {
    const cutoff = this.now() - this.catchupGraceS;
    for (const schedule of schedules) {
      if (
        !schedule.enabled ||
        schedule.nextRunAt === null ||
        schedule.nextRunAt >= cutoff ||
        !CATCHUP_KINDS.has(schedule.kind)
      ) {
        continue;
      }
      this.logger?.info(
        { scheduleId: schedule.id, name: schedule.name, dueAt: schedule.nextRunAt },
        'running a schedule missed while the service was stopped',
      );
      await this.execute(schedule.id, 'catchup');
    }
  }

  /**
   * Stops all timers and waits for in-flight jobs.
   *
   * Waiting matters: a `prune` interrupted between deleting a blob and deleting its row
   * would leave the store inconsistent, and the abort signal lets a cooperative job
   * finish its current unit rather than being cut mid-write.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    for (const cron of this.crons.values()) {
      cron.stop();
    }
    this.crons.clear();
    this.abort.abort();
    await Promise.allSettled([...this.inFlight]);
    this.logger?.info({}, 'scheduler stopped');
  }

  /** Installs (or replaces) the timer for one schedule. */
  private program(schedule: Schedule): void {
    this.unprogram(schedule.id);
    if (!this.started || !schedule.enabled) {
      return;
    }

    const cron = new Cron(
      schedule.cron,
      {
        // `protect` is the overlap guarantee: a tick arriving while the previous run is
        // still going is dropped rather than queued or run concurrently.
        protect: () => {
          this.logger?.warn(
            { scheduleId: schedule.id, name: schedule.name },
            'schedule tick skipped — the previous run is still going',
          );
          this.recordResult(schedule.id, 'skipped', 'previous run still in progress');
        },
      },
      () => {
        void this.execute(schedule.id, 'cron');
      },
    );

    this.crons.set(schedule.id, cron);
    this.refreshNextRun(schedule.id, cron);
  }

  private unprogram(id: number): void {
    const existing = this.crons.get(id);
    if (existing !== undefined) {
      existing.stop();
      this.crons.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /**
   * Runs one schedule now, recording the outcome.
   *
   * Never rejects. A job that throws is recorded as `error` with its message and the
   * scheduler carries on — one broken job must not stop every other schedule on the box,
   * which is exactly what an unhandled rejection out of a timer callback would do.
   */
  async execute(id: number, trigger: JobContext['trigger'] = 'manual'): Promise<ScheduleResult> {
    const schedule = this.get(id);
    if (schedule === undefined) {
      return 'skipped';
    }

    const handler = this.jobs.get(schedule.kind);
    if (handler === undefined) {
      this.recordResult(id, 'skipped', `no handler registered for "${schedule.kind}"`);
      return 'skipped';
    }

    const firedAt = this.now();
    const ctx: JobContext = {
      trigger,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      target: schedule.target,
      firedAt,
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
      signal: this.abort.signal,
    };

    const run = (async (): Promise<ScheduleResult> => {
      try {
        const outcome: JobOutcome | void = await handler(ctx);
        const result: ScheduleResult = outcome?.skipped === true ? 'skipped' : 'ok';
        this.recordResult(id, result, outcome?.detail ?? null);
        this.audit?.record({
          actor: `schedule:${String(id)}`,
          action: `schedule.run.${schedule.kind}`,
          target: schedule.name,
          // This branch cannot have failed — a throw is handled below — so the audit
          // result is always 'ok' here, whether or not the job chose to skip its work.
          result: 'ok',
          ...(outcome?.detail !== undefined ? { detail: outcome.detail } : {}),
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.error({ err, scheduleId: id, name: schedule.name }, 'scheduled job failed');
        this.recordResult(id, 'error', message);
        this.audit?.record({
          actor: `schedule:${String(id)}`,
          action: `schedule.run.${schedule.kind}`,
          target: schedule.name,
          result: 'error',
          detail: message,
        });
        return 'error';
      }
    })();

    // Tracked so `stop()` can wait for it; the void-typed copy keeps the set homogeneous.
    const tracked = run.then(() => undefined);
    this.inFlight.add(tracked);
    try {
      return await run;
    } finally {
      this.inFlight.delete(tracked);
    }
  }

  /** Writes the outcome and recomputes the next occurrence. */
  private recordResult(id: number, result: ScheduleResult, detail: string | null): void {
    this.db.run(
      `UPDATE schedules
          SET last_run_at = @now, last_result = @result, last_error = @error
        WHERE id = @id`,
      {
        id,
        now: this.now(),
        result,
        error: result === 'error' ? detail : null,
      },
    );
    const cron = this.crons.get(id);
    if (cron !== undefined) {
      this.refreshNextRun(id, cron);
    }
  }

  private refreshNextRun(id: number, cron: Cron): void {
    const next = cron.nextRun();
    this.db.run('UPDATE schedules SET next_run_at = @next WHERE id = @id', {
      id,
      next: next === null ? null : Math.floor(next.getTime() / 1000),
    });
  }

  /** Whether a schedule currently has a live timer. Exposed for the status endpoint. */
  isProgrammed(id: number): boolean {
    return this.crons.has(id);
  }

  get programmedCount(): number {
    return this.crons.size;
  }
}
