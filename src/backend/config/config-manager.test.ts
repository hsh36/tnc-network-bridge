import { SECRET_SENTINEL, type SmbConfig } from '../../shared';
import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import {
  ConfigError,
  ConfigManager,
  ConfigValidationError,
  redactSecrets,
  type ConfigChange,
} from './config-manager';
import { type Db } from './db';
import { runMigrations } from './migrations/runner';
import { generateSecretKey } from './secrets';

const SECRET_KEY = 'smb.server.credentials.password';
const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let config: ConfigManager;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('defaults', () => {
  it('materialises every section default into the database', () => {
    const count = db.pluck<number>("SELECT count(*) FROM config WHERE key LIKE 'sync.%'");
    expect(count).toBeGreaterThan(5);
  });

  it('returns the documented defaults', () => {
    expect(config.get('sync').conflictMode).toBe('last_write_wins');
    expect(config.get('sync').mtimeToleranceMs).toBe(2000);
    expect(config.get('locking').tncLockTtlS).toBe(900);
    expect(config.get('smb').tnc.minProtocol).toBe('NT1');
  });

  it('does not overwrite an operator setting when defaults are re-materialised', () => {
    config.set('sync', { ...config.get('sync'), concurrency: 8 });
    ConfigManager.create({ db, secretKey: generateSecretKey() });
    expect(config.get('sync').concurrency).toBe(8);
  });

  it('fills a field that has no row from the schema default', () => {
    db.run("DELETE FROM config WHERE key = 'sync.concurrency'");
    expect(config.get('sync').concurrency).toBe(4);
  });

  it('exposes every section through getAll', () => {
    expect(Object.keys(config.getAll())).toHaveLength(10);
  });
});

describe('validation', () => {
  it('rejects an out-of-range value with the offending field named', () => {
    let error: ConfigValidationError | undefined;
    try {
      config.set('sync', { ...config.get('sync'), concurrency: 999 });
    } catch (err) {
      error = err as ConfigValidationError;
    }
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error?.issues[0]?.path).toBe('concurrency');
    expect(error?.message).toMatch(/concurrency/);
  });

  it('rejects an unknown enum value', () => {
    expect(() => config.set('sync', { ...config.get('sync'), conflictMode: 'tnc_always' })).toThrow(
      ConfigValidationError,
    );
  });

  it('reports the nested path for a nested field', () => {
    let error: ConfigValidationError | undefined;
    try {
      config.set('network', {
        ...config.get('network'),
        tnc: { interface: 'eth1', address: 'not-an-address' },
      });
    } catch (err) {
      error = err as ConfigValidationError;
    }
    expect(error?.issues[0]?.path).toBe('tnc.address');
  });

  it('surfaces a cross-field rule as a useful message', () => {
    let error: ConfigValidationError | undefined;
    try {
      config.set('network', {
        ...config.get('network'),
        lan: { interface: 'eth0', method: 'dhcp', dns: [] },
        tnc: { interface: 'eth0', address: '192.168.42.1/24' },
      });
    } catch (err) {
      error = err as ConfigValidationError;
    }
    expect(error?.message).toMatch(/must be different/);
  });

  it('leaves the stored value untouched when validation fails', () => {
    expect(() => config.set('sync', { ...config.get('sync'), concurrency: 999 })).toThrow();
    expect(config.get('sync').concurrency).toBe(4);
  });
});

describe('persistence', () => {
  it('persists a changed value', () => {
    config.set('sync', { ...config.get('sync'), concurrency: 8, protectDeletes: false });
    expect(config.get('sync').concurrency).toBe(8);
    expect(config.get('sync').protectDeletes).toBe(false);
  });

  it('survives a restart', () => {
    config.set('sync', { ...config.get('sync'), maxFileSizeMb: 1024 });
    const reopened = ConfigManager.create({ db, secretKey: generateSecretKey() });
    expect(reopened.get('sync').maxFileSizeMb).toBe(1024);
  });

  it('stores an array as a single value', () => {
    config.set('sync', { ...config.get('sync'), excludePatterns: ['*.bak', '*.tmp'] });
    expect(config.get('sync').excludePatterns).toEqual(['*.bak', '*.tmp']);
    expect(
      db.pluck<number>("SELECT count(*) FROM config WHERE key LIKE 'sync.excludePatterns%'"),
    ).toBe(1);
  });

  it('records who made the change', () => {
    config.set('sync', { ...config.get('sync'), concurrency: 6 }, 'admin');
    expect(db.pluck<string>("SELECT updated_by FROM config WHERE key = 'sync.concurrency'")).toBe(
      'admin',
    );
  });

  it('falls back to defaults if a stored value has become invalid', () => {
    db.run("UPDATE config SET value = '\"nonsense\"' WHERE key = 'sync.conflictMode'");
    const warn = jest.fn();
    const manager = ConfigManager.create({
      db,
      secretKey: generateSecretKey(),
      logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() },
    });
    expect(manager.get('sync').conflictMode).toBe('last_write_wins');
  });
});

describe('secrets', () => {
  it('stores the password encrypted, never in cleartext', () => {
    config.set('smb', withPassword(config.get('smb'), PASSWORD));
    const stored = db.pluck<string>('SELECT value FROM config WHERE key = @key', {
      key: SECRET_KEY,
    });
    expect(stored).toBeDefined();
    expect(stored).not.toContain(PASSWORD);
    expect(stored?.startsWith('v1:')).toBe(true);
    expect(
      db.pluck<number>('SELECT is_secret FROM config WHERE key = @key', { key: SECRET_KEY }),
    ).toBe(1);
  });

  it('returns the sentinel from a normal section read', () => {
    config.set('smb', withPassword(config.get('smb'), PASSWORD));
    expect(config.get('smb').server.credentials.password).toBe(SECRET_SENTINEL);
  });

  it('returns the plaintext only through getSecret', () => {
    config.set('smb', withPassword(config.get('smb'), PASSWORD));
    expect(config.getSecret(SECRET_KEY)).toBe(PASSWORD);
  });

  it('treats the sentinel on write as "unchanged"', () => {
    config.set('smb', withPassword(config.get('smb'), PASSWORD));
    // This is the UI round-trip: fetch the redacted section, change something else,
    // send it back. The password must survive untouched.
    const fetched = config.get('smb');
    config.set('smb', { ...fetched, tnc: { ...fetched.tnc, workgroup: 'WERKSTATT' } });

    expect(config.getSecret(SECRET_KEY)).toBe(PASSWORD);
    expect(config.get('smb').tnc.workgroup).toBe('WERKSTATT');
  });

  it('replaces the password when a real value is submitted', () => {
    config.set('smb', withPassword(config.get('smb'), PASSWORD));
    config.set('smb', withPassword(config.get('smb'), 'ein-neues-Passwort'));
    expect(config.getSecret(SECRET_KEY)).toBe('ein-neues-Passwort');
  });

  it('does not report a secret as changed when the sentinel was submitted', () => {
    config.set('smb', withPassword(config.get('smb'), PASSWORD));
    const changes: ConfigChange[] = [];
    config.onChange((c) => changes.push(c));

    config.set('smb', config.get('smb'));
    expect(changes).toHaveLength(0);
  });

  it('reports the secret as changed when it is actually replaced', () => {
    const changes: ConfigChange[] = [];
    config.onChange((c) => changes.push(c));
    config.set('smb', withPassword(config.get('smb'), PASSWORD));
    expect(changes[0]?.changedKeys).toContain(SECRET_KEY);
  });

  it('keeps the plaintext out of every serialised form of a section', () => {
    config.set('smb', withPassword(config.get('smb'), PASSWORD));
    expect(JSON.stringify(config.get('smb'))).not.toContain(PASSWORD);
    expect(JSON.stringify(config.getAll())).not.toContain(PASSWORD);
  });

  it('keeps the plaintext out of change events', () => {
    const changes: ConfigChange[] = [];
    config.onChange((c) => changes.push(c));
    config.set('smb', withPassword(config.get('smb'), PASSWORD));
    expect(JSON.stringify(changes)).not.toContain(PASSWORD);
  });

  it('keeps the plaintext out of validation error output', () => {
    let error: unknown;
    try {
      // An invalid sibling field forces an error while a real password is in flight.
      const smb = withPassword(config.get('smb'), PASSWORD);
      config.set('smb', { ...smb, tnc: { ...smb.tnc, workgroup: 'this-name-is-far-too-long' } });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigValidationError);
    const serialised = `${String(error)} ${JSON.stringify((error as ConfigValidationError).issues)}`;
    expect(serialised).not.toContain(PASSWORD);
  });

  it('refuses to decrypt a key that is not marked secret', () => {
    db.run('UPDATE config SET is_secret = 0 WHERE key = @key', { key: SECRET_KEY });
    expect(() => config.getSecret(SECRET_KEY)).toThrow(ConfigError);
  });

  it('returns an empty string for a secret that was never written', () => {
    db.run('DELETE FROM config WHERE key = @key', { key: SECRET_KEY });
    expect(config.getSecret(SECRET_KEY)).toBe('');
  });
});

describe('change subscriptions', () => {
  it('notifies subscribers with the changed keys and both states', () => {
    const changes: ConfigChange[] = [];
    config.onChange((c) => changes.push(c));

    config.set('sync', { ...config.get('sync'), concurrency: 8 }, 'admin');

    expect(changes).toHaveLength(1);
    expect(changes[0]?.section).toBe('sync');
    expect(changes[0]?.changedKeys).toEqual(['sync.concurrency']);
    expect(changes[0]?.actor).toBe('admin');
    expect((changes[0]?.previous as { concurrency: number }).concurrency).toBe(4);
    expect((changes[0]?.current as { concurrency: number }).concurrency).toBe(8);
  });

  it('does not fire when nothing actually changed', () => {
    const handler = jest.fn();
    config.onChange(handler);
    config.set('sync', config.get('sync'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports only the keys that changed, not the whole section', () => {
    const changes: ConfigChange[] = [];
    config.onChange((c) => changes.push(c));
    config.set('sync', { ...config.get('sync'), concurrency: 8, maxFileSizeMb: 1024 });
    expect([...(changes[0]?.changedKeys ?? [])].sort()).toEqual([
      'sync.concurrency',
      'sync.maxFileSizeMb',
    ]);
  });

  it('scopes a section subscription to that section', () => {
    const syncHandler = jest.fn();
    const lockingHandler = jest.fn();
    config.onSectionChange('sync', syncHandler);
    config.onSectionChange('locking', lockingHandler);

    config.set('sync', { ...config.get('sync'), concurrency: 8 });

    expect(syncHandler).toHaveBeenCalledTimes(1);
    expect(lockingHandler).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const handler = jest.fn();
    const unsubscribe = config.onChange(handler);
    config.set('sync', { ...config.get('sync'), concurrency: 8 });
    unsubscribe();
    config.set('sync', { ...config.get('sync'), concurrency: 6 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing subscriber from the write and from other subscribers', () => {
    const good = jest.fn();
    config.onChange(() => {
      throw new Error('subscriber exploded');
    });
    config.onChange(good);

    expect(() => config.set('sync', { ...config.get('sync'), concurrency: 8 })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(config.get('sync').concurrency).toBe(8);
  });
});

describe('install-scoped flags', () => {
  it('reads a seeded flag', () => {
    expect(config.getFlag('setup.completed', true)).toBe(false);
  });

  it('returns the fallback for an unknown key', () => {
    expect(config.getFlag('nope.not.here', 'fallback')).toBe('fallback');
  });

  it('round-trips a flag', () => {
    config.setFlag('setup.completed', true);
    expect(config.getFlag('setup.completed', false)).toBe(true);
  });
});

describe('redactSecrets', () => {
  it('redacts a known config key by its full path', () => {
    const redacted = redactSecrets({
      smb: { server: { credentials: { password: PASSWORD, username: 'svc_cnc' } } },
    });
    expect(JSON.stringify(redacted)).not.toContain(PASSWORD);
    expect(redacted.smb.server.credentials.username).toBe('svc_cnc');
  });

  it('redacts anything that looks like a credential, wherever it appears', () => {
    const redacted = redactSecrets({
      mount: { password: PASSWORD, token: 'abc123', apiKey: 'xyz' },
      nested: [{ secret: 'shh' }],
    });
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain('abc123');
    expect(serialised).not.toContain('shh');
  });

  it('leaves ordinary values alone', () => {
    expect(redactSecrets({ concurrency: 4, name: 'programs' })).toEqual({
      concurrency: 4,
      name: 'programs',
    });
  });
});

/** Builds an smb section with a real password in place of the sentinel. */
function withPassword(smb: SmbConfig, password: string): SmbConfig {
  return {
    ...smb,
    server: {
      ...smb.server,
      credentials: { ...smb.server.credentials, password },
    },
  };
}
