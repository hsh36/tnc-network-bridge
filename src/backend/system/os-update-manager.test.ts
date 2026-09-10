import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { type PrivilegedRequest } from '../privileged/verbs';

import { OsUpdateManager } from './os-update-manager';

/**
 * apt runs for minutes and may end in a reboot, so — as with the self-updater — the
 * process that starts one is not necessarily the process that sees it end. Everything
 * here therefore goes through the status file the script writes, including the cases
 * where that file is absent, truncated or written by a version that reports
 * differently.
 */

let db: Db;
let config: ConfigManager;
let invoked: PrivilegedRequest[];
let stateDir: string;
let statusFile: string;

function manager(invoke?: () => never): OsUpdateManager {
  return new OsUpdateManager({
    config,
    statusFile,
    invoke:
      invoke ??
      ((request) => {
        invoked.push(request);
        return { ok: true, verb: request.verb, commands: [], detail: {} } as never;
      }),
  });
}

/** A status file exactly as `scripts/os-update.sh` writes one. */
function writeStatus(fields: Record<string, unknown>): void {
  writeFileSync(statusFile, JSON.stringify({ ts: 1_757_000_000, ...fields }));
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  invoked = [];
  stateDir = mkdtempSync(join(tmpdir(), 'tnc-os-update-'));
  statusFile = join(stateDir, 'os-update-status.json');
});

afterEach(() => {
  cleanupTmpDbs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('getStatus', () => {
  it('is idle on an appliance that has never run one', () => {
    expect(manager().getStatus()).toMatchObject({
      phase: 'idle',
      lastRunAt: null,
      lastResult: null,
      rebootPending: false,
    });
  });

  it('reports progress from the file while apt is working', () => {
    writeStatus({ phase: 'upgrading', progressPct: 40 });

    expect(manager().getStatus()).toMatchObject({ phase: 'upgrading', progressPct: 40 });
  });

  it('records the outcome of a finished run', () => {
    writeStatus({ phase: 'done', progressPct: 100 });

    expect(manager().getStatus()).toMatchObject({
      phase: 'done',
      lastResult: 'ok',
      lastRunAt: 1_757_000_000,
    });
  });

  it('keeps the reason a run failed', () => {
    writeStatus({ phase: 'failed', progressPct: 100, detail: 'apt-get upgrade failed' });

    const status = manager().getStatus();
    expect(status.lastResult).toBe('failed');
    expect(status.detail).toMatch(/apt-get upgrade failed/);
  });

  it('surfaces a reboot the upgrade still needs', () => {
    // The operator has to know the machine is not finished, even though apt is.
    writeStatus({ phase: 'done', progressPct: 100, detail: 'a reboot is required to finish' });

    expect(manager().getStatus().rebootPending).toBe(true);
  });

  it('does not claim a reboot is pending after a clean run', () => {
    writeStatus({ phase: 'done', progressPct: 100 });

    expect(manager().getStatus().rebootPending).toBe(false);
  });

  it('survives a status file caught mid-write', () => {
    writeFileSync(statusFile, '{"phase":"upgr');

    expect(() => manager().getStatus()).not.toThrow();
    expect(manager().getStatus().phase).toBe('idle');
  });

  it('ignores a phase this build does not know', () => {
    writeStatus({ phase: 'defragmenting' });

    expect(manager().getStatus().phase).toBe('idle');
  });
});

describe('isRunning', () => {
  it.each([['refreshing'], ['upgrading'], ['cleaning'], ['rebooting']])(
    'is true during %s',
    (phase) => {
      writeStatus({ phase, progressPct: 10 });
      expect(manager().isRunning()).toBe(true);
    },
  );

  it.each([['idle'], ['done'], ['failed']])('is false at %s', (phase) => {
    writeStatus({ phase, progressPct: 100 });
    expect(manager().isRunning()).toBe(false);
  });
});

describe('run', () => {
  it('asks the helper to start one', () => {
    manager().run();

    expect(invoked).toEqual([{ verb: 'os-update', reboot: false }]);
  });

  it('takes the reboot decision from config by default', () => {
    config.set('osUpdates', { ...config.get('osUpdates'), autoReboot: true });

    manager().run();

    expect(invoked[0]).toMatchObject({ reboot: true });
  });

  it('lets one run override the configured reboot setting', () => {
    config.set('osUpdates', { ...config.get('osUpdates'), autoReboot: true });

    manager().run({ reboot: false });

    expect(invoked[0]).toMatchObject({ reboot: false });
  });

  it('refuses to start a second run on top of one in flight', () => {
    writeStatus({ phase: 'upgrading', progressPct: 40 });

    expect(() => manager().run()).toThrow(/already running/);
    expect(invoked).toHaveLength(0);
  });

  it('clears the previous run before starting, so the new one does not look finished', () => {
    // Leaving a terminal status in place would make the fresh run read as `done` until
    // the script's first write, which is several seconds of apt refresh later.
    writeStatus({ phase: 'done', progressPct: 100 });
    const os = manager();

    os.run();

    expect(existsSync(statusFile)).toBe(false);
    expect(os.getStatus().phase).toBe('refreshing');
  });

  it('lets a failure from the helper reach the caller', () => {
    const os = manager(() => {
      throw new Error('sudo: a password is required');
    });

    expect(() => os.run()).toThrow(/password is required/);
  });
});
