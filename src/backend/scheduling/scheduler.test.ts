import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { AuditLog, installAuditGuards } from '../security/audit-log';
import { JobRegistry, type JobContext } from './jobs';
import {
  InvalidCronError,
  ScheduleNotFoundError,
  Scheduler,
  previewRuns,
  validateCron,
} from './scheduler';

let db: Db;
let jobs: JobRegistry;
let scheduler: Scheduler;
let clock: number;

/** Every minute — the shortest standard cron interval, used where firing is the point. */
const EVERY_MINUTE = '* * * * *';
const NIGHTLY = '0 3 * * *';

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  installAuditGuards(db);
  clock = 1_700_000_000;
  jobs = new JobRegistry();
  scheduler = new Scheduler({ db, jobs, now: () => clock });
});

afterEach(async () => {
  await scheduler.stop();
  cleanupTmpDbs();
});

const create = (over: Partial<Parameters<Scheduler['create']>[0]> = {}) =>
  scheduler.create({
    name: 'nightly prune',
    kind: 'prune',
    cron: NIGHTLY,
    target: null,
    enabled: true,
    ...over,
  });

describe('validateCron', () => {
  it('accepts a well-formed expression and returns its next run', () => {
    expect(validateCron(NIGHTLY)).toBeInstanceOf(Date);
  });

  it('rejects an expression the parser cannot understand', () => {
    expect(() => validateCron('not a cron')).toThrow(InvalidCronError);
    // An hour that does not exist is the mistake a regex would happily pass through.
    expect(() => validateCron('0 25 * * *')).toThrow(InvalidCronError);
  });

  it('rejects an expression that can never fire', () => {
    // 30 February: syntactically fine, semantically silence forever.
    expect(() => validateCron('0 0 30 2 *')).toThrow(/no future occurrence/);
  });
});

describe('previewRuns', () => {
  it('returns the requested number of upcoming occurrences in order', () => {
    const runs = previewRuns(NIGHTLY, 5);
    expect(runs).toHaveLength(5);
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]!.getTime()).toBeGreaterThan(runs[i - 1]!.getTime());
    }
  });
});

describe('CRUD', () => {
  it('creates a schedule and computes its next run', () => {
    const schedule = create();

    expect(schedule.id).toBeGreaterThan(0);
    expect(schedule.kind).toBe('prune');
    expect(schedule.enabled).toBe(true);
    expect(schedule.nextRunAt).toBeGreaterThan(0);
    expect(schedule.lastRunAt).toBeNull();
  });

  it('refuses to store an invalid cron expression', () => {
    expect(() => create({ cron: '0 99 * * *' })).toThrow(InvalidCronError);
    expect(scheduler.list().total).toBe(0);
  });

  it('round-trips a JSON target', () => {
    const schedule = create({
      kind: 'lock',
      target: { shareId: 3, pathGlob: '**/*.H', durationMinutes: 480 },
    });

    expect(scheduler.require(schedule.id).target).toEqual({
      shareId: 3,
      pathGlob: '**/*.H',
      durationMinutes: 480,
    });
  });

  it('updates only the fields supplied', () => {
    const schedule = create({ name: 'original' });

    const updated = scheduler.update(schedule.id, { name: 'renamed' });

    expect(updated.name).toBe('renamed');
    expect(updated.cron).toBe(NIGHTLY);
    expect(updated.kind).toBe('prune');
  });

  it('recomputes the next run when the cron changes', () => {
    const schedule = create({ cron: '0 3 * * *' });
    const before = schedule.nextRunAt;

    const updated = scheduler.update(schedule.id, { cron: '30 14 * * *' });

    expect(updated.nextRunAt).not.toBe(before);
  });

  it('rejects an invalid cron on update, leaving the row untouched', () => {
    const schedule = create();
    expect(() => scheduler.update(schedule.id, { cron: 'nonsense' })).toThrow(InvalidCronError);
    expect(scheduler.require(schedule.id).cron).toBe(NIGHTLY);
  });

  it('filters by kind and enabled', () => {
    create({ name: 'a', kind: 'prune' });
    create({ name: 'b', kind: 'scan' });
    create({ name: 'c', kind: 'scan', enabled: false });

    expect(scheduler.list({ kind: 'scan' }).total).toBe(2);
    expect(scheduler.list({ enabled: false }).total).toBe(1);
  });

  it('deletes a schedule', () => {
    const schedule = create();
    scheduler.delete(schedule.id);
    expect(scheduler.get(schedule.id)).toBeUndefined();
  });

  it('throws for an unknown id', () => {
    expect(() => scheduler.require(999)).toThrow(ScheduleNotFoundError);
  });
});

describe('execution', () => {
  it('runs the registered handler and records success', async () => {
    const seen: JobContext[] = [];
    jobs.register('prune', (ctx) => {
      seen.push(ctx);
      return { detail: 'freed 3 blobs' };
    });
    const schedule = create();

    await expect(scheduler.execute(schedule.id, 'manual')).resolves.toBe('ok');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.trigger).toBe('manual');
    expect(seen[0]?.scheduleName).toBe('nightly prune');

    const after = scheduler.require(schedule.id);
    expect(after.lastResult).toBe('ok');
    expect(after.lastRunAt).toBe(clock);
    expect(after.lastError).toBeNull();
  });

  it('passes the target through to the handler', async () => {
    let received: JobContext['target'] | 'never ran' = 'never ran';
    jobs.register('lock', (ctx) => {
      received = ctx.target;
    });
    const schedule = create({ kind: 'lock', target: { pathGlob: '**/*.H', durationMinutes: 60 } });

    await scheduler.execute(schedule.id);

    expect(received).toEqual({ pathGlob: '**/*.H', durationMinutes: 60 });
  });

  it('records a job that throws as an error, without rejecting', async () => {
    jobs.register('prune', () => {
      throw new Error('disk went away');
    });
    const schedule = create();

    // Never rejects: one broken job must not stop every other schedule on the box.
    await expect(scheduler.execute(schedule.id)).resolves.toBe('error');

    const after = scheduler.require(schedule.id);
    expect(after.lastResult).toBe('error');
    expect(after.lastError).toBe('disk went away');
  });

  it('records a deliberate skip distinctly from success', async () => {
    jobs.register('prune', () => ({ skipped: true, detail: 'server unreachable' }));
    const schedule = create();

    await expect(scheduler.execute(schedule.id)).resolves.toBe('skipped');
    expect(scheduler.require(schedule.id).lastResult).toBe('skipped');
  });

  it('skips a kind with no registered handler rather than failing', async () => {
    const schedule = create({ kind: 'backup' });

    await expect(scheduler.execute(schedule.id)).resolves.toBe('skipped');
    expect(scheduler.require(schedule.id).lastError).toBeNull();
  });

  it('is a no-op for a schedule that has been deleted', async () => {
    await expect(scheduler.execute(4242)).resolves.toBe('skipped');
  });

  it('writes an audit entry naming the schedule', async () => {
    const audit = new AuditLog(db, undefined, () => clock);
    const audited = new Scheduler({ db, jobs, audit, now: () => clock });
    jobs.register('prune', () => ({ detail: 'ok' }));
    const schedule = audited.create({
      name: 'audited prune',
      kind: 'prune',
      cron: NIGHTLY,
      target: null,
      enabled: true,
    });

    await audited.execute(schedule.id);

    const entries = audit.query({ action: 'schedule' });
    expect(entries.items.map((e) => e.action)).toContain('schedule.run.prune');
    await audited.stop();
  });
});

describe('firing on a timer', () => {
  it('fires a due schedule once started', async () => {
    let runs = 0;
    jobs.register('scan', () => {
      runs += 1;
    });
    create({ name: 'frequent', kind: 'scan', cron: EVERY_MINUTE });

    await scheduler.start();
    expect(scheduler.programmedCount).toBe(1);

    // Rather than waiting a real minute, drive the same path the timer callback uses.
    const [schedule] = scheduler.list().items;
    await scheduler.execute(schedule!.id, 'cron');
    expect(runs).toBe(1);
  });

  it('does not program a disabled schedule', async () => {
    create({ enabled: false });
    await scheduler.start();
    expect(scheduler.programmedCount).toBe(0);
  });

  it('stops programming when a schedule is disabled', async () => {
    const schedule = create({ cron: EVERY_MINUTE });
    await scheduler.start();
    expect(scheduler.isProgrammed(schedule.id)).toBe(true);

    scheduler.update(schedule.id, { enabled: false });
    expect(scheduler.isProgrammed(schedule.id)).toBe(false);
  });

  it('drops the timer when a schedule is deleted', async () => {
    const schedule = create({ cron: EVERY_MINUTE });
    await scheduler.start();
    scheduler.delete(schedule.id);
    expect(scheduler.isProgrammed(schedule.id)).toBe(false);
  });

  it('clears every timer on stop', async () => {
    create({ name: 'a', cron: EVERY_MINUTE });
    create({ name: 'b', kind: 'scan', cron: EVERY_MINUTE });
    await scheduler.start();
    expect(scheduler.programmedCount).toBe(2);

    await scheduler.stop();
    expect(scheduler.programmedCount).toBe(0);
  });
});

describe('missed runs', () => {
  it('fires a catch-up-eligible schedule whose due time passed while stopped', async () => {
    let runs = 0;
    const triggers: string[] = [];
    jobs.register('prune', (ctx) => {
      runs += 1;
      triggers.push(ctx.trigger);
    });
    const schedule = create({ kind: 'prune' });

    // The Pi was off: the due time is now well in the past.
    db.run('UPDATE schedules SET next_run_at = @past WHERE id = @id', {
      past: clock - 86_400,
      id: schedule.id,
    });

    await scheduler.start();

    // Exactly once — not once per missed occurrence.
    expect(runs).toBe(1);
    expect(triggers).toEqual(['catchup']);
  });

  it('does not catch up a kind where even one extra run would be wrong', async () => {
    let runs = 0;
    jobs.register('restart', () => {
      runs += 1;
    });
    const schedule = create({ kind: 'restart', name: 'weekly restart' });
    db.run('UPDATE schedules SET next_run_at = @past WHERE id = @id', {
      past: clock - 86_400,
      id: schedule.id,
    });

    await scheduler.start();

    expect(runs).toBe(0);
  });

  it('does not treat a run that just fired as missed', async () => {
    let runs = 0;
    jobs.register('prune', () => {
      runs += 1;
    });
    const schedule = create();
    // Inside the grace window: an ordinary restart must not replay it.
    db.run('UPDATE schedules SET next_run_at = @recent WHERE id = @id', {
      recent: clock - 5,
      id: schedule.id,
    });

    await scheduler.start();

    expect(runs).toBe(0);
  });

  it('ignores a missed run on a disabled schedule', async () => {
    let runs = 0;
    jobs.register('prune', () => {
      runs += 1;
    });
    const schedule = create({ enabled: false });
    db.run('UPDATE schedules SET next_run_at = @past WHERE id = @id', {
      past: clock - 86_400,
      id: schedule.id,
    });

    await scheduler.start();

    expect(runs).toBe(0);
  });
});

describe('robustness', () => {
  it('survives a target whose JSON no longer parses', () => {
    const schedule = create();
    db.run("UPDATE schedules SET target = '{not json' WHERE id = @id", { id: schedule.id });

    // Corrupt data degrades to "no target" rather than taking the scheduler down.
    expect(scheduler.require(schedule.id).target).toBeNull();
  });

  it('survives a target whose JSON parses but does not match the schema', () => {
    const schedule = create();
    db.run(`UPDATE schedules SET target = '{"shareId":"not a number"}' WHERE id = @id`, {
      id: schedule.id,
    });

    expect(scheduler.require(schedule.id).target).toBeNull();
  });

  it('waits for an in-flight job before stop() resolves', async () => {
    let finished = false;
    jobs.register('prune', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
    });
    const schedule = create();
    await scheduler.start();

    const running = scheduler.execute(schedule.id);
    await scheduler.stop();

    // A prune cut between deleting a blob and deleting its row would corrupt the store.
    expect(finished).toBe(true);
    await running;
  });

  it('starting twice is a no-op', async () => {
    create({ cron: EVERY_MINUTE });
    await scheduler.start();
    await scheduler.start();
    expect(scheduler.programmedCount).toBe(1);
  });
});
