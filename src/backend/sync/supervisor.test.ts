import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';

import { ShareStore } from './share-store';
import { type ShareMount, SyncSupervisor } from './supervisor';

/**
 * The supervisor converges rather than reacting, so the questions here are all of the
 * form "given this table, what is running" — including after the events that a
 * save-triggered design gets wrong: a restart, a share being disabled, a field changing
 * that has nothing to do with whether a share should sync.
 */

let db: Db;
let config: ConfigManager;
let roots: string;
let mounts: FakeMount[];

class FakeMount implements ShareMount {
  mounted = false;
  unmounted = false;
  private listener: ((change: { online?: boolean }) => void) | undefined;

  constructor(readonly shareName: string) {}

  mount(): Promise<void> {
    this.mounted = true;
    return Promise.resolve();
  }

  unmount(): Promise<void> {
    this.unmounted = true;
    return Promise.resolve();
  }

  on(_event: 'state', listener: (change: { online?: boolean }) => void): unknown {
    this.listener = listener;
    return this;
  }

  /** Lets a test drive the mount going away under a running share. */
  emitState(online: boolean): void {
    this.listener?.({ online });
  }
}

function supervisor(): SyncSupervisor {
  return new SyncSupervisor({
    db,
    config,
    createMount: (spec) => {
      const fake = new FakeMount(spec.shareName);
      mounts.push(fake);
      return fake;
    },
  });
}

function createShare(name: string, overrides: Record<string, unknown> = {}): number {
  const store = new ShareStore({ db, config });
  const share = store.create({
    name,
    serverUnc: `//fileserver/cnc$/${name}`,
    enabled: true,
    smbDomain: null,
    smbUser: null,
    smbVersion: '3.1.1',
    smbSeal: true,
    conflictMode: 'last_write_wins',
    excludePatterns: [],
    scanIntervalMs: 60_000,
    bandwidthLimitKbps: null,
    maxFileSizeMb: 512,
    tncGuestOk: true,
    ...overrides,
  });
  // The real paths are /mnt and /srv, which a test cannot create. Point them at a temp
  // root so a cycle has somewhere to look.
  const cache = join(roots, name, 'cache');
  const mount = join(roots, name, 'mount');
  mkdirSync(cache, { recursive: true });
  mkdirSync(mount, { recursive: true });
  db.run('UPDATE shares SET cache_path = @cache, mount_point = @mount WHERE id = @id', {
    id: share.id,
    cache,
    mount,
  });
  return share.id;
}

/** Polls until `condition` holds, or fails the test with a useful message. */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition did not hold within ${String(timeoutMs)} ms`);
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  roots = tmpDir('tnc-shares-');
  mounts = [];
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('reconcile', () => {
  it('starts an enabled share', async () => {
    const id = createShare('programs');
    const sync = supervisor();

    await sync.reconcile();

    expect(sync.activeShareIds()).toEqual([id]);
    expect(mounts[0]?.mounted).toBe(true);
    await sync.stop();
  });

  it('does not start a disabled one', async () => {
    createShare('programs', { enabled: false });
    const sync = supervisor();

    await sync.reconcile();

    expect(sync.activeShareIds()).toEqual([]);
    await sync.stop();
  });

  it('picks up shares that already existed, without anyone saving anything', async () => {
    // The case a save-triggered design gets wrong: after a reboot nothing has been
    // saved, so nothing would sync until an operator opened the UI.
    createShare('programs');
    createShare('fixtures');

    const sync = supervisor();
    await sync.reconcile();

    expect(sync.activeShareIds()).toHaveLength(2);
    await sync.stop();
  });

  it('stops a share that was disabled', async () => {
    const id = createShare('programs');
    const sync = supervisor();
    await sync.reconcile();

    db.run('UPDATE shares SET enabled = 0 WHERE id = @id', { id });
    await sync.reconcile();

    expect(sync.activeShareIds()).toEqual([]);
    expect(mounts[0]?.unmounted).toBe(true);
    await sync.stop();
  });

  it('stops a share that was deleted', async () => {
    const id = createShare('programs');
    const sync = supervisor();
    await sync.reconcile();

    new ShareStore({ db, config }).delete(id);
    await sync.reconcile();

    expect(sync.activeShareIds()).toEqual([]);
    await sync.stop();
  });

  it('restarts a share whose server path changed', async () => {
    const id = createShare('programs');
    const sync = supervisor();
    await sync.reconcile();

    new ShareStore({ db, config }).update(id, { serverUnc: '//other/cnc$/programs' });
    await sync.reconcile();

    // A new mount, because the old one points somewhere else entirely.
    expect(mounts).toHaveLength(2);
    expect(mounts[0]?.unmounted).toBe(true);
    await sync.stop();
  });

  it('leaves a running share alone when a field it re-reads each cycle changes', async () => {
    const id = createShare('programs');
    const sync = supervisor();
    await sync.reconcile();

    new ShareStore({ db, config }).update(id, { bandwidthLimitKbps: 2048 });
    await sync.reconcile();

    // Restarting here would throw away a scan in progress to pick up a value the next
    // cycle would have read anyway.
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.unmounted).toBe(false);
    await sync.stop();
  });

  it('is idempotent', async () => {
    createShare('programs');
    const sync = supervisor();

    await sync.reconcile();
    await sync.reconcile();
    await sync.reconcile();

    expect(mounts).toHaveLength(1);
    await sync.stop();
  });

  it('keeps the share running when the mount fails', async () => {
    const id = createShare('programs');
    const sync = new SyncSupervisor({
      db,
      config,
      createMount: () => ({
        mount: () => Promise.reject(new Error('server unreachable')),
        unmount: () => Promise.resolve(),
        on: () => undefined,
      }),
    });

    await sync.reconcile();

    // Serving the cache to the machines while the server is away is the whole point of
    // caching; refusing to start would take the machines down with the server.
    expect(sync.activeShareIds()).toEqual([id]);
    expect(db.pluck<string>('SELECT status FROM shares WHERE id = @id', { id })).toBe('offline');
    await sync.stop();
  });
});

describe('actions', () => {
  it('refuses an action against a share that is not running', async () => {
    const id = createShare('programs', { enabled: false });
    const sync = supervisor();
    await sync.reconcile();

    expect(sync.runNow(id)).toBe(false);
    expect(sync.setPaused(id, true)).toBe(false);
    await sync.stop();
  });

  it('pauses and resumes a running share', async () => {
    const id = createShare('programs');
    const sync = supervisor();
    await sync.reconcile();

    expect(sync.setPaused(id, true)).toBe(true);
    expect(db.pluck<string>('SELECT status FROM shares WHERE id = @id', { id })).toBe('paused');

    expect(sync.setPaused(id, false)).toBe(true);
    expect(db.pluck<string>('SELECT status FROM shares WHERE id = @id', { id })).toBe('idle');
    await sync.stop();
  });
});

describe('a cycle', () => {
  it('pulls a file that exists only on the server', async () => {
    const id = createShare('programs');
    const mountPoint = db.pluck<string>('SELECT mount_point FROM shares WHERE id = @id', { id });
    writeFileSync(join(mountPoint ?? '', 'part.h'), 'from the server');

    const sync = supervisor();
    await sync.reconcile();

    const cachePath = db.pluck<string>('SELECT cache_path FROM shares WHERE id = @id', { id });
    const pulled = join(cachePath ?? '', 'part.h');
    // Waits for the condition rather than a fixed delay: reconcile() starts the first
    // cycle without awaiting it, and a sleep long enough on one machine is a flake on a
    // slower one — which is exactly what it was under coverage instrumentation.
    await waitFor(() => existsSync(pulled));
    expect(readFileSync(pulled, 'utf8')).toBe('from the server');
    await sync.stop();
  });
});

describe('stop', () => {
  it('unmounts everything and refuses to start anything after', async () => {
    createShare('programs');
    const sync = supervisor();
    await sync.reconcile();

    await sync.stop();

    expect(sync.activeShareIds()).toEqual([]);
    expect(mounts[0]?.unmounted).toBe(true);

    await sync.reconcile();
    expect(sync.activeShareIds()).toEqual([]);
  });
});
