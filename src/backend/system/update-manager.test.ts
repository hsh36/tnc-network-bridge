import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { type BridgeEvent } from '../../shared';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { type PrivilegedRequest } from '../privileged/verbs';

import { UpdateManager } from './update-manager';

/**
 * The defect these are written against: `/update/status` answered from a literal, so a
 * check that had just run left the screen reading "no checks performed yet". Every
 * assertion below therefore asks what a *subsequent* `getStatus()` reports, not what
 * `check()` returned — the UI polls status, it does not keep the check's response.
 *
 * Applying is asserted the same way, for a stronger reason: the updater restarts the
 * service, so the object that starts an update never sees it end. What it leaves behind
 * on disk, and what the next process makes of that, is the whole contract.
 */

let db: Db;
let config: ConfigManager;
let events: BridgeEvent[];
let invoked: PrivilegedRequest[];
let stateDir: string;
let statusFile: string;

const release = (tag: string, overrides: Record<string, unknown> = {}): unknown => ({
  tag_name: tag,
  body: 'notes',
  draft: false,
  prerelease: false,
  published_at: '2026-09-01T10:00:00Z',
  tarball_url: `https://api.github.com/repos/o/r/tarball/${tag}`,
  ...overrides,
});

const respondWith = (body: unknown, status = 200): typeof fetch =>
  (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    })) as unknown as typeof fetch;

const failWith =
  (error: Error): typeof fetch =>
  () =>
    Promise.reject(error);

function manager(fetchImpl: typeof fetch, currentVersion = '0.1.0'): UpdateManager {
  return new UpdateManager({
    currentVersion,
    publishEvent: (event) => events.push(event),
    config,
    db,
    fetchImpl,
    statusFile,
    invoke: (request) => {
      invoked.push(request);
      return { ok: true, verb: request.verb, commands: [], detail: {} } as never;
    },
  });
}

/** A status file exactly as `scripts/self-update.sh` writes one. */
function writeStatus(fields: Record<string, unknown>): void {
  writeFileSync(statusFile, JSON.stringify({ ts: 1_757_000_000, ...fields }));
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  events = [];
  invoked = [];
  stateDir = mkdtempSync(join(tmpdir(), 'tnc-update-'));
  statusFile = join(stateDir, 'update-status.json');
});

afterEach(() => {
  cleanupTmpDbs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('check', () => {
  it('records the check on the status a later poll reads', async () => {
    const updates = manager(respondWith([]));
    expect(updates.getStatus().lastCheckAt).toBeNull();

    await updates.check();

    expect(updates.getStatus().lastCheckAt).not.toBeNull();
    expect(updates.getStatus().lastError).toBeNull();
    expect(updates.getStatus().available).toBeNull();
  });

  it('offers a newer release', async () => {
    const updates = manager(respondWith([release('v0.2.0')]));
    await updates.check();

    expect(updates.getStatus().available?.version).toBe('0.2.0');
  });

  it('does not offer the running version as an update', async () => {
    const updates = manager(respondWith([release('v0.1.0')]));
    await updates.check();

    expect(updates.getStatus().available).toBeNull();
    expect(updates.getStatus().lastCheckAt).not.toBeNull();
  });

  it('does not offer an older release', async () => {
    const updates = manager(respondWith([release('v0.0.9')]), '0.1.0');
    await updates.check();

    expect(updates.getStatus().available).toBeNull();
  });

  it('honours the configured channel', async () => {
    config.set('updates', { ...config.get('updates'), channel: 'beta' });
    const updates = manager(respondWith([release('v0.3.0', { prerelease: true })]));
    await updates.check();

    expect(updates.getStatus().available?.version).toBe('0.3.0');
  });

  it('stamps lastCheckAt even when the check fails, and keeps the reason', async () => {
    // Without the timestamp the screen reads "no checks performed yet" next to an
    // error, which describes a state that never happened.
    const updates = manager(failWith(new Error('ENOTFOUND')));

    await expect(updates.check()).rejects.toThrow();

    const status = updates.getStatus();
    expect(status.lastCheckAt).not.toBeNull();
    expect(status.lastError).toMatch(/ENOTFOUND/);
  });

  it('clears a previous error once a check succeeds', async () => {
    const failing = manager(failWith(new Error('ENOTFOUND')));
    await expect(failing.check()).rejects.toThrow();

    const updates = manager(respondWith([]));
    await updates.check();
    expect(updates.getStatus().lastError).toBeNull();
  });

  it('publishes the status so an open UI does not wait for the next poll', async () => {
    const updates = manager(respondWith([release('v0.2.0')]));
    await updates.check();

    const published = events.filter((event) => event.type === 'update');
    expect(published.length).toBeGreaterThanOrEqual(2);
    const last = published[published.length - 1];
    expect(last?.type === 'update' ? last.status.available?.version : undefined).toBe('0.2.0');
  });

  it('reads the repository from config at check time, not at construction', async () => {
    const seen: string[] = [];
    const spy = ((url: string) => {
      seen.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }) as unknown as typeof fetch;

    const updates = manager(spy);
    config.set('updates', { ...config.get('updates'), githubRepo: 'someone/else' });
    await updates.check();

    expect(seen[0]).toContain('/repos/someone/else/releases');
  });
});

describe('apply', () => {
  it('refuses when no release has been found', async () => {
    const updates = manager(respondWith([]));

    await expect(updates.apply()).rejects.toThrow(/No update available/);
    expect(invoked).toHaveLength(0);
  });

  it('asks the helper for the release tag, with the running version as the fallback', async () => {
    const updates = manager(respondWith([release('v0.2.0')]));
    await updates.check();
    await updates.apply();

    expect(invoked).toHaveLength(1);
    expect(invoked[0]).toMatchObject({
      verb: 'self-update',
      targetRef: 'v0.2.0',
      previousRef: 'v0.1.0',
    });
  });

  it('passes the configured health timeout, which is what arms the updater rollback', async () => {
    config.set('updates', { ...config.get('updates'), healthTimeoutS: 300 });
    const updates = manager(respondWith([release('v0.2.0')]));
    await updates.check();
    await updates.apply();

    expect(invoked[0]).toMatchObject({ healthTimeoutSeconds: 300 });
  });

  it('does not claim success, since the update ends in the process that replaces this one', async () => {
    const updates = manager(respondWith([release('v0.2.0')]));
    await updates.check();
    await updates.apply();

    // Reporting `done` here would be a lie: nothing has been built or restarted yet.
    expect(updates.getStatus().phase).not.toBe('done');
    expect(updates.getStatus().currentVersion).toBe('0.1.0');
  });

  it('records a failure the helper reported before anything was started', async () => {
    const updates = new UpdateManager({
      currentVersion: '0.1.0',
      publishEvent: (event) => events.push(event),
      config,
      db,
      fetchImpl: respondWith([]),
      statusFile,
      invoke: () => {
        throw new Error('sudo: a password is required');
      },
    });

    await expect(updates.apply('0.2.0')).rejects.toThrow(/password is required/);
    expect(updates.getStatus().phase).toBe('failed');
    expect(updates.getStatus().lastError).toMatch(/password is required/);
    expect(updates.getHistory().items[0]?.result).toBe('failed');
  });
});

describe('rollback', () => {
  it('refuses when there is no retained previous version', async () => {
    await expect(manager(respondWith([])).rollback()).rejects.toThrow(/No previous version/);
  });

  it('goes back by the same mechanism, with no further fallback', async () => {
    writeStatus({ phase: 'done', progressPct: 100, target: 'v0.2.0', previous: 'v0.1.0' });
    const updates = manager(respondWith([]), '0.2.0');
    updates.adoptExternalStatus();

    await updates.rollback();

    expect(invoked[0]).toMatchObject({
      verb: 'self-update',
      targetRef: 'v0.1.0',
      // Falling back from the rollback target would mean going forward again, into the
      // release that just failed.
      previousRef: '',
    });
  });
});

describe('history', () => {
  it('is empty before anything has been applied', () => {
    expect(manager(respondWith([])).getHistory().items).toEqual([]);
  });

  it('records what the updater reported, since the process that asked for it is gone', () => {
    writeStatus({ phase: 'done', progressPct: 100, target: 'v0.2.0', previous: 'v0.1.0' });

    const afterRestart = manager(respondWith([]), '0.2.0');
    afterRestart.adoptExternalStatus();

    const history = afterRestart.getHistory();
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({
      result: 'ok',
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
    });
  });
});

describe('adoptExternalStatus', () => {
  it('does nothing when the updater has left no status behind', () => {
    const updates = manager(respondWith([]));

    updates.adoptExternalStatus();

    expect(updates.getStatus().phase).toBe('idle');
    expect(updates.getHistory().total).toBe(0);
  });

  it('survives a status file caught mid-write', () => {
    // The script renames a temp file into place, but a truncated read must not take a
    // startup down even so — this runs before the service is listening.
    writeFileSync(statusFile, '{"phase":"inst');
    const updates = manager(respondWith([]));

    expect(() => updates.adoptExternalStatus()).not.toThrow();
    expect(updates.getStatus().phase).toBe('idle');
  });

  it('ignores a status file holding something that is not an object', () => {
    writeFileSync(statusFile, '"installing"');
    const updates = manager(respondWith([]));

    updates.adoptExternalStatus();

    expect(updates.getStatus().phase).toBe('idle');
  });

  it('ignores a status file with no phase in it at all', () => {
    writeFileSync(statusFile, JSON.stringify({ target: 'v0.2.0' }));
    const updates = manager(respondWith([]));

    updates.adoptExternalStatus();

    expect(updates.getStatus().phase).toBe('idle');
  });

  it('tolerates a status file missing the fields the script always writes', () => {
    // Forward compatibility in the other direction: an older script, or one killed
    // between opening the file and writing the body.
    writeFileSync(statusFile, JSON.stringify({ phase: 'done' }));
    const updates = manager(respondWith([]), '0.2.0');

    updates.adoptExternalStatus();

    expect(updates.getStatus().phase).toBe('done');
    expect(updates.getStatus().rollbackVersion).toBeNull();
  });

  it('ignores a phase this build does not know', () => {
    writeStatus({ phase: 'teleporting', target: 'v9.9.9' });
    const updates = manager(respondWith([]));

    updates.adoptExternalStatus();

    expect(updates.getStatus().phase).toBe('idle');
  });

  it('keeps the reason a failed update failed, which nothing else survives to record', () => {
    writeStatus({
      phase: 'failed',
      progressPct: 100,
      target: 'v0.2.0',
      previous: 'v0.1.0',
      error: 'Build failed for v0.2.0 (rolled back to v0.1.0)',
    });
    const updates = manager(respondWith([]), '0.1.0');

    updates.adoptExternalStatus();

    expect(updates.getStatus().phase).toBe('failed');
    expect(updates.getStatus().lastError).toMatch(/Build failed/);
    expect(updates.getHistory().items[0]?.result).toBe('failed');
  });

  it('shows an update still in flight rather than an idle screen', () => {
    writeStatus({ phase: 'health_gate', progressPct: 90, target: 'v0.2.0', previous: '' });
    const updates = manager(respondWith([]), '0.2.0');

    updates.adoptExternalStatus();

    expect(updates.getStatus().phase).toBe('health_gate');
    expect(updates.getStatus().progressPct).toBe(90);
    // Still running: recording it now would double-count it when it finishes.
    expect(updates.getHistory().total).toBe(0);
  });

  it('consumes a finished status so a later restart does not record it twice', () => {
    writeStatus({ phase: 'done', progressPct: 100, target: 'v0.2.0', previous: 'v0.1.0' });

    manager(respondWith([]), '0.2.0').adoptExternalStatus();
    manager(respondWith([]), '0.2.0').adoptExternalStatus();

    expect(manager(respondWith([]), '0.2.0').getHistory().total).toBe(1);
  });

  it('makes the previous release available as a rollback target after a good update', () => {
    writeStatus({ phase: 'done', progressPct: 100, target: 'v0.2.0', previous: 'v0.1.0' });
    const updates = manager(respondWith([]), '0.2.0');

    updates.adoptExternalStatus();

    expect(updates.getStatus().rollbackVersion).toBe('0.1.0');
  });
});

describe('refusing concurrent work', () => {
  it('does not start a second check on top of one already running', async () => {
    // `checking` is a real phase the UI shows. A second check would reset it and the
    // first would then finish into a state it no longer owns.
    let release_: (() => void) | undefined;
    const slow = (() =>
      new Promise((resolve) => {
        release_ = () => {
          resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        };
      })) as unknown as typeof fetch;
    const updates = manager(slow);

    const first = updates.check();
    await expect(updates.check()).rejects.toThrow(/while checking/);

    release_?.();
    await first;
  });

  it('does not start a second update on top of one in flight', async () => {
    writeStatus({ phase: 'installing', progressPct: 40, target: 'v0.2.0', previous: 'v0.1.0' });
    const updates = manager(respondWith([]), '0.1.0');
    updates.adoptExternalStatus();

    await expect(updates.apply('0.3.0')).rejects.toThrow(/while installing/);
    expect(invoked).toHaveLength(0);
  });

  it('reports a rollback the helper refused', async () => {
    writeStatus({ phase: 'done', progressPct: 100, target: 'v0.2.0', previous: 'v0.1.0' });
    const updates = new UpdateManager({
      currentVersion: '0.2.0',
      publishEvent: (event) => events.push(event),
      config,
      db,
      fetchImpl: respondWith([]),
      statusFile,
      invoke: () => {
        throw new Error('helper exited with status 1');
      },
    });
    updates.adoptExternalStatus();

    await expect(updates.rollback()).rejects.toThrow(/helper exited/);
    expect(updates.getStatus().phase).toBe('failed');
    expect(updates.getStatus().lastError).toMatch(/helper exited/);
  });
});

describe('without a database', () => {
  it('still reports status, and simply keeps no history', async () => {
    // A route test builds a context without one. Losing history is acceptable there;
    // throwing on every status poll is not.
    const updates = new UpdateManager({
      currentVersion: '0.1.0',
      publishEvent: (event) => events.push(event),
      config,
      fetchImpl: respondWith([release('v0.2.0')]),
      statusFile,
      invoke: (request) => ({ ok: true, verb: request.verb, commands: [], detail: {} }) as never,
    });

    await updates.check();
    await updates.apply();

    expect(updates.getHistory()).toEqual({ items: [], total: 0 });
    expect(updates.getStatus().lastCheckAt).not.toBeNull();
  });
});

describe('the restart race', () => {
  it('picks up a status written after startup, which is every real update', () => {
    // The actual sequence on the appliance, from the journal: the updater restarts the
    // service during `restarting`, the new process reads the file while starting, and
    // the updater writes `done` three seconds later — after the only read that would
    // ever have happened. Reading once at startup froze the UI mid-update on an update
    // that had succeeded.
    writeStatus({ phase: 'restarting', progressPct: 80, target: 'v0.2.0', previous: 'abc123' });
    const updates = manager(respondWith([]), '0.2.0');
    updates.adoptExternalStatus();
    expect(updates.getStatus().phase).toBe('restarting');

    // The updater finishes, after this process has already started.
    writeStatus({ phase: 'done', progressPct: 100, target: 'v0.2.0', previous: 'abc123' });

    expect(updates.getStatus().phase).toBe('done');
  });

  it('records the history row for an update that finished after the restart', () => {
    writeStatus({ phase: 'restarting', progressPct: 80, target: 'v0.2.0', previous: 'abc123' });
    const updates = manager(respondWith([]), '0.2.0');
    updates.adoptExternalStatus();

    writeStatus({ phase: 'done', progressPct: 100, target: 'v0.2.0', previous: 'abc123' });
    updates.getStatus();

    expect(updates.getHistory().items[0]).toMatchObject({ result: 'ok', toVersion: '0.2.0' });
  });

  it('records that row exactly once, however often the UI polls', () => {
    writeStatus({ phase: 'restarting', progressPct: 80, target: 'v0.2.0', previous: 'abc123' });
    const updates = manager(respondWith([]), '0.2.0');
    updates.adoptExternalStatus();

    writeStatus({ phase: 'done', progressPct: 100, target: 'v0.2.0', previous: 'abc123' });
    updates.getStatus();
    updates.getStatus();
    updates.getStatus();

    expect(updates.getHistory().total).toBe(1);
  });

  it('does not read the file at all once everything is idle', () => {
    // The UI polls this every two seconds forever; an idle appliance should not be
    // opening a file for each poll.
    writeStatus({ phase: 'done', progressPct: 100, target: 'v9.9.9', previous: '' });
    const updates = manager(respondWith([]), '0.1.0');

    expect(updates.getStatus().phase).toBe('idle');
  });

  it('does not adopt a stale terminal status left by an earlier update', async () => {
    // Otherwise the first status read after pressing Install reports the *previous*
    // update as this one's result, instantly and wrongly.
    writeStatus({ phase: 'done', progressPct: 100, target: 'v0.1.0', previous: '' });
    const updates = manager(respondWith([release('v0.2.0')]));
    await updates.check();

    await updates.apply();

    expect(updates.getStatus().phase).not.toBe('done');
  });
});
