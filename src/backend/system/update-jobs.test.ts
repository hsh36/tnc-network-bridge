import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { type JobContext, type JobOutcome } from '../scheduling/jobs';

import { type OsUpdateManager } from './os-update-manager';
import { checkAndMaybeApply, runOsUpdate } from './update-jobs';
import { type UpdateManager } from './update-manager';

/**
 * Neither schedule kind had a handler, so the scheduler recorded every firing as
 * `skipped` and an operator watching the history saw a job that never ran.
 */

let db: Db;
let config: ConfigManager;

const CONTEXT: JobContext = {
  trigger: 'cron',
  scheduleId: 1,
  scheduleName: 'Automatic bridge updates',
  target: null,
  firedAt: 1_757_000_000,
};

/** An UpdateManager stub that reports what the test wants and records what was asked. */
function updateManager(available: string | null): {
  manager: UpdateManager;
  applied: string[];
  checks: number;
} {
  const applied: string[] = [];
  let checks = 0;
  const manager = {
    check: () => {
      checks += 1;
      return Promise.resolve({
        currentVersion: '0.1.0',
        available: available === null ? null : { version: available },
        phase: 'idle',
        progressPct: null,
        lastCheckAt: 1,
        lastError: null,
        rollbackVersion: null,
      });
    },
    apply: (version?: string) => {
      applied.push(version ?? '<latest>');
      return Promise.resolve();
    },
  } as unknown as UpdateManager;

  return {
    manager,
    applied,
    get checks() {
      return checks;
    },
  };
}

function osManager(running: boolean): { manager: OsUpdateManager; runs: number } {
  let runs = 0;
  const manager = {
    isRunning: () => running,
    run: () => {
      runs += 1;
    },
  } as unknown as OsUpdateManager;

  return {
    manager,
    get runs() {
      return runs;
    },
  };
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('the update job', () => {
  it('skips when there is nothing newer, and says which version it is on', async () => {
    // Skipped rather than ok: "nothing available" and "installed one" are different
    // outcomes, and the history should not need opening to tell them apart.
    const updates = updateManager(null);
    const os = osManager(false);

    const outcome = (await checkAndMaybeApply({
      updates: updates.manager,
      osUpdates: os.manager,
      config,
    })(CONTEXT)) as JobOutcome;

    expect(outcome.skipped).toBe(true);
    expect(outcome.detail).toMatch(/0\.1\.0/);
    expect(updates.applied).toEqual([]);
  });

  it('installs a newer release when automatic updates are on', async () => {
    config.set('updates', { ...config.get('updates'), enabled: true });
    const updates = updateManager('0.2.0');
    const os = osManager(false);

    const outcome = (await checkAndMaybeApply({
      updates: updates.manager,
      osUpdates: os.manager,
      config,
    })(CONTEXT)) as JobOutcome;

    expect(updates.applied).toEqual(['0.2.0']);
    expect(outcome.detail).toMatch(/installing 0\.2\.0/);
  });

  it('still checks when automatic updates are off, but installs nothing', async () => {
    // `enabled` governs installing, not checking. An operator who turns it off still
    // wants to be told an update exists — that is what the badge is for.
    config.set('updates', { ...config.get('updates'), enabled: false });
    const updates = updateManager('0.2.0');
    const os = osManager(false);

    const outcome = (await checkAndMaybeApply({
      updates: updates.manager,
      osUpdates: os.manager,
      config,
    })(CONTEXT)) as JobOutcome;

    expect(updates.checks).toBe(1);
    expect(updates.applied).toEqual([]);
    expect(outcome.detail).toMatch(/not installing/);
    expect(outcome.skipped).toBeUndefined();
  });

  it('does not report an install as finished, because nothing has observed that yet', async () => {
    config.set('updates', { ...config.get('updates'), enabled: true });
    const updates = updateManager('0.2.0');
    const os = osManager(false);

    const outcome = (await checkAndMaybeApply({
      updates: updates.manager,
      osUpdates: os.manager,
      config,
    })(CONTEXT)) as JobOutcome;

    // apply() hands the work to a unit that outlives this process.
    expect(outcome.detail).not.toMatch(/installed/);
  });

  it('lets a failed check fail the run, so the history records it', async () => {
    const failing = {
      check: () => Promise.reject(new Error('GitHub did not answer in time')),
    } as unknown as UpdateManager;

    await expect(
      checkAndMaybeApply({
        updates: failing,
        osUpdates: osManager(false).manager,
        config,
      })(CONTEXT),
    ).rejects.toThrow(/did not answer/);
  });
});

describe('the OS update job', () => {
  it('starts a run', () => {
    const os = osManager(false);

    const outcome = runOsUpdate({
      updates: updateManager(null).manager,
      osUpdates: os.manager,
      config,
    })(CONTEXT) as JobOutcome;

    expect(os.runs).toBe(1);
    expect(outcome.detail).toMatch(/started/);
  });

  it('skips when one is already going', () => {
    // Real on a Pi: an apt run can outlast the gap between two firings of an hourly
    // schedule somebody set by mistake.
    const os = osManager(true);

    const outcome = runOsUpdate({
      updates: updateManager(null).manager,
      osUpdates: os.manager,
      config,
    })(CONTEXT) as JobOutcome;

    expect(os.runs).toBe(0);
    expect(outcome.skipped).toBe(true);
  });
});
