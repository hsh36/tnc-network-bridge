import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { LockHeldError, LockManager, LockNotFoundError } from './lock-manager';

let db: Db;
let config: ConfigManager;
let manager: LockManager;
let mountPoint: string;
let clockSeconds: number;

function insertShare(overrides: Record<string, string | number | null> = {}): number {
  const now = clockSeconds;
  const values = {
    name: 'programs',
    server_unc: '//fileserver/cnc$/programs',
    mount_point: mountPoint,
    cache_path: join(mountPoint, '..', 'cache'),
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  const columns = Object.keys(values);
  const result = db.run(
    `INSERT INTO shares (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
    values,
  );
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  mountPoint = join(tmpDir(), 'mount');
  mkdirSync(mountPoint, { recursive: true });
  clockSeconds = 1_700_000_000;
  manager = new LockManager({ db, config, now: () => clockSeconds });
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('acquire', () => {
  it('creates a lock row and writes the sidecar marker', () => {
    const shareId = insertShare();
    const lock = manager.acquire({
      shareId,
      relPath: 'PART1.H',
      origin: 'tnc',
      tncIp: '192.168.42.50',
    });

    expect(lock.id).toBeGreaterThan(0);
    expect(lock.releasedAt).toBeNull();
    expect(lock.serverLockOk).toBe(true);
    expect(existsSync(join(mountPoint, '.~lock.PART1.H#'))).toBe(true);
  });

  it('defaults a TNC lock TTL from configuration', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc' });
    expect(lock.expiresAt).toBe(clockSeconds + config.get('locking').tncLockTtlS);
  });

  it('leaves a manual lock without expiry unless a TTL is given', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' });
    expect(lock.expiresAt).toBeNull();
  });

  it('honours an explicit TTL override', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual', ttlSeconds: 60 });
    expect(lock.expiresAt).toBe(clockSeconds + 60);
  });

  it('refuses a second lock on the same path', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc' });
    expect(() => manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' })).toThrow(
      LockHeldError,
    );
  });

  it('allows locking the same path again once the first lock is released', () => {
    const shareId = insertShare();
    const first = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc' });
    manager.release(first.id);
    expect(() => manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' })).not.toThrow();
  });

  it('records a projection failure without refusing the lock', () => {
    const shareId = insertShare({ mount_point: join(mountPoint, 'does-not-exist') });
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc' });
    expect(lock.serverLockOk).toBe(false);
    expect(lock.serverLockError).toBeTruthy();
  });

  it('throws when locking is disabled', () => {
    config.set('locking', { ...config.get('locking'), enabled: false });
    const shareId = insertShare();
    expect(() => manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' })).toThrow(
      'Locking is disabled',
    );
  });
});

describe('release', () => {
  it('removes the sidecar marker and marks the row released', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc' });
    const released = manager.release(lock.id, { reason: 'closed on TNC' });

    expect(released.releasedAt).toBe(clockSeconds);
    expect(released.note).toBe('closed on TNC');
    expect(existsSync(join(mountPoint, '.~lock.PART1.H#'))).toBe(false);
  });

  it('throws for an id that is not an active lock', () => {
    expect(() => manager.release(999)).toThrow(LockNotFoundError);
  });

  it('throws when releasing an already-released lock', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' });
    manager.release(lock.id);
    expect(() => manager.release(lock.id)).toThrow(LockNotFoundError);
  });
});

describe('expireStale', () => {
  it('leaves an unexpired lock alone', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc' });
    expect(manager.expireStale()).toHaveLength(0);
  });

  it('releases a lock past its TTL and removes its sidecar', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc', ttlSeconds: 30 });
    clockSeconds += 31;

    const expired = manager.expireStale();
    expect(expired).toHaveLength(1);
    expect(expired[0]?.releasedAt).toBe(clockSeconds);
    expect(existsSync(join(mountPoint, '.~lock.PART1.H#'))).toBe(false);
  });

  it('never expires a lock with no TTL', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' });
    clockSeconds += 1_000_000;
    expect(manager.expireStale()).toHaveLength(0);
  });
});

describe('list and getActive', () => {
  it('finds the active lock for a path', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc' });
    expect(manager.getActive(shareId, 'PART1.H')?.relPath).toBe('PART1.H');
    expect(manager.getActive(shareId, 'OTHER.H')).toBeUndefined();
  });

  it('excludes released locks by default and includes them on request', () => {
    const shareId = insertShare();
    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc' });
    manager.release(lock.id);

    expect(manager.list({ limit: 100, offset: 0, includeReleased: false }).total).toBe(0);
    expect(manager.list({ limit: 100, offset: 0, includeReleased: true }).total).toBe(1);
  });

  it('filters by origin', () => {
    const shareId = insertShare();
    manager.acquire({ shareId, relPath: 'A.H', origin: 'tnc' });
    manager.acquire({ shareId, relPath: 'B.H', origin: 'manual' });

    const result = manager.list({
      limit: 100,
      offset: 0,
      includeReleased: false,
      origin: 'manual',
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.relPath).toBe('B.H');
  });
});

describe('lock events', () => {
  it('notifies subscribers on acquire, release and expiry', () => {
    const shareId = insertShare();
    const seen: string[] = [];
    manager.onLockEvent((e) => seen.push(e.action));

    const lock = manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc', ttlSeconds: 30 });
    manager.release(lock.id);

    const second = manager.acquire({ shareId, relPath: 'A.H', origin: 'tnc', ttlSeconds: 10 });
    void second;
    clockSeconds += 20;
    manager.expireStale();

    expect(seen).toEqual(['acquired', 'released', 'acquired', 'expired']);
  });

  it('lets an unsubscribe stop further notifications', () => {
    const shareId = insertShare();
    const seen: string[] = [];
    const unsubscribe = manager.onLockEvent((e) => seen.push(e.action));
    unsubscribe();

    manager.acquire({ shareId, relPath: 'PART1.H', origin: 'tnc' });
    expect(seen).toHaveLength(0);
  });

  it('does not let a throwing subscriber break the acquire call', () => {
    const shareId = insertShare();
    manager.onLockEvent(() => {
      throw new Error('subscriber bug');
    });
    expect(() => manager.acquire({ shareId, relPath: 'PART1.H', origin: 'manual' })).not.toThrow();
  });
});

describe('createManual', () => {
  it('forces origin to manual regardless of what the caller might pass elsewhere', () => {
    const shareId = insertShare();
    const lock = manager.createManual(shareId, {
      shareId,
      relPath: 'PART1.H',
      note: 'operator hold',
    });
    expect(lock.origin).toBe('manual');
    expect(lock.note).toBe('operator hold');
  });
});
