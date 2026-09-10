import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { type BridgeEvent } from '../../shared';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';

import { UpdateManager } from './update-manager';

/**
 * The defect these are written against: `/update/status` answered from a literal, so a
 * check that had just run left the screen reading "no checks performed yet". Every
 * assertion below therefore asks what a *subsequent* `getStatus()` reports, not what
 * `check()` returned — the UI polls status, it does not keep the check's response.
 */

let db: Db;
let config: ConfigManager;
let events: BridgeEvent[];

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
    stepDelayMs: 0,
  });
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  events = [];
});

afterEach(() => {
  cleanupTmpDbs();
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
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });
    }) as unknown as typeof fetch;

    const updates = manager(spy);
    config.set('updates', { ...config.get('updates'), githubRepo: 'someone/else' });
    await updates.check();

    expect(seen[0]).toContain('/repos/someone/else/releases');
  });
});

describe('history', () => {
  it('is empty before anything has been applied', () => {
    expect(manager(respondWith([])).getHistory().items).toEqual([]);
  });

  it('records a rollback and survives a restart of the manager', async () => {
    const updates = manager(respondWith([release('v0.2.0')]));
    await updates.check();
    await updates.apply();

    // A new manager stands for the process the update restarted: the history has to
    // come from the database, or the record of the update is lost to the update.
    const afterRestart = manager(respondWith([]), '0.2.0');
    const history = afterRestart.getHistory();
    expect(history.total).toBe(1);
    expect(history.items[0]?.result).toBe('ok');
    expect(history.items[0]?.fromVersion).toBe('0.1.0');
    expect(history.items[0]?.toVersion).toBe('0.2.0');
  });
});

describe('apply', () => {
  it('refuses when no release has been found', async () => {
    const updates = manager(respondWith([]));
    await expect(updates.apply()).rejects.toThrow(/No update available/);
  });

  it('leaves the applied version as the current one and the old one as the rollback', async () => {
    const updates = manager(respondWith([release('v0.2.0')]));
    await updates.check();
    await updates.apply();

    const status = updates.getStatus();
    expect(status.currentVersion).toBe('0.2.0');
    expect(status.rollbackVersion).toBe('0.1.0');
    expect(status.available).toBeNull();
    expect(status.phase).toBe('done');
  });
});

describe('rollback', () => {
  it('refuses when there is no retained previous version', async () => {
    await expect(manager(respondWith([])).rollback()).rejects.toThrow(/No previous version/);
  });
});
