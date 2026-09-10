import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { JobRegistry } from '../scheduling/jobs';
import { Scheduler } from '../scheduling/scheduler';

import { isManagedSchedule, ManagedSchedules, MANAGED_SCHEDULE_NAMES } from './managed-schedules';

/**
 * The defect: the Updates page and the Schedules page described the same thing twice
 * and agreed by accident. `updates.scheduleCron` lived in a config section, the cron
 * engine read the schedules table, and nothing connected them — so the schedule editor
 * on the Updates page wrote nowhere and a row added by hand ran on a cadence the
 * Updates page never showed.
 */

let db: Db;
let config: ConfigManager;
let scheduler: Scheduler;

function managed(): ManagedSchedules {
  return new ManagedSchedules({ config, scheduler });
}

function rowFor(name: string): { id: number; cron: string; enabled: boolean } | undefined {
  return scheduler.list({ limit: 100 }).items.find((schedule) => schedule.name === name);
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  scheduler = new Scheduler({ db, jobs: new JobRegistry() });
});

afterEach(() => {
  void scheduler.stop?.();
  cleanupTmpDbs();
});

describe('reconcile', () => {
  it('creates a row per managed kind, so the cron engine has something to fire', () => {
    managed().reconcile();

    expect(rowFor(MANAGED_SCHEDULE_NAMES.update)).toBeDefined();
    expect(rowFor(MANAGED_SCHEDULE_NAMES.osUpdate)).toBeDefined();
  });

  it('gives each row the cron from its own config section', () => {
    config.set('updates', { ...config.get('updates'), scheduleCron: '30 2 * * 1' });
    config.set('osUpdates', { ...config.get('osUpdates'), scheduleCron: '0 5 * * 6' });

    managed().reconcile();

    expect(rowFor(MANAGED_SCHEDULE_NAMES.update)?.cron).toBe('30 2 * * 1');
    expect(rowFor(MANAGED_SCHEDULE_NAMES.osUpdate)?.cron).toBe('0 5 * * 6');
  });

  it('carries the enabled flag across, so turning updates off actually stops them', () => {
    config.set('updates', { ...config.get('updates'), enabled: false });

    managed().reconcile();

    expect(rowFor(MANAGED_SCHEDULE_NAMES.update)?.enabled).toBe(false);
  });

  it('does not create a second row when run again', () => {
    const m = managed();
    m.reconcile();
    m.reconcile();
    m.reconcile();

    const all = scheduler.list({ limit: 100 }).items;
    expect(all.filter((s) => s.name === MANAGED_SCHEDULE_NAMES.update)).toHaveLength(1);
    expect(all.filter((s) => s.name === MANAGED_SCHEDULE_NAMES.osUpdate)).toHaveLength(1);
  });

  it('leaves an unchanged row alone rather than rewriting its next run', () => {
    // An unconditional update would rewrite `next_run_at` on every config save and
    // every restart, so a daily job would drift later each time an operator touched an
    // unrelated setting.
    const m = managed();
    m.reconcile();
    const before = scheduler.require(rowFor(MANAGED_SCHEDULE_NAMES.update)!.id).nextRunAt;

    m.reconcile();

    expect(scheduler.require(rowFor(MANAGED_SCHEDULE_NAMES.update)!.id).nextRunAt).toBe(before);
  });

  it('follows a later config change without a restart', () => {
    const m = managed();
    m.reconcile();

    config.set('updates', { ...config.get('updates'), scheduleCron: '15 1 * * *' });

    expect(rowFor(MANAGED_SCHEDULE_NAMES.update)?.cron).toBe('15 1 * * *');
  });

  it('reconciles on a change to the OS section too', () => {
    const m = managed();
    m.reconcile();

    config.set('osUpdates', { ...config.get('osUpdates'), enabled: true });

    expect(rowFor(MANAGED_SCHEDULE_NAMES.osUpdate)?.enabled).toBe(true);
  });

  it('does not throw when a schedule cannot be written', () => {
    // Bridging files is the appliance's job; it should keep doing that with a stale
    // cron entry rather than refuse to start.
    const broken = {
      list: () => {
        throw new Error('database is locked');
      },
    } as unknown as Scheduler;

    expect(() => new ManagedSchedules({ config, scheduler: broken }).reconcile()).not.toThrow();
  });
});

describe('isManagedSchedule', () => {
  it('recognises both managed rows', () => {
    expect(isManagedSchedule(MANAGED_SCHEDULE_NAMES.update)).toBe(true);
    expect(isManagedSchedule(MANAGED_SCHEDULE_NAMES.osUpdate)).toBe(true);
  });

  it('does not claim a schedule the operator made', () => {
    expect(isManagedSchedule('Nightly prune')).toBe(false);
  });
});
