import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEMP_FILE_PREFIX } from '../shared/constants';

import { Db } from './config/db';
import { writeSecretKeyFile } from './config/secrets';
import {
  bootstrap,
  bootstrapLogger,
  type BootstrapOptions,
  installSignalHandlers,
  selfCheck,
  type Service,
  type SignalTarget,
} from './index';
import { NoopNotifier } from './lifecycle/watchdog';

/**
 * Bootstrap is tested against the real subsystems — a real SQLite file, real migrations,
 * a real logging tree — because the failures worth catching here are integration
 * failures. A mocked bootstrap would prove only that the mocks agree with each other.
 */

let root: string;
let services: Service[] = [];

function options(overrides: BootstrapOptions = {}): BootstrapOptions {
  return {
    dbPath: join(root, 'db', 'tnc-bridge.db'),
    logDir: join(root, 'log'),
    secretKeyPath: join(root, 'secret.key'),
    notifier: new NoopNotifier(),
    quiet: true,
    env: {},
    ...overrides,
  };
}

async function start(overrides: BootstrapOptions = {}): Promise<Service> {
  const service = await bootstrap(options(overrides));
  services.push(service);
  return service;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tnc-boot-'));
  writeSecretKeyFile(join(root, 'secret.key'));
});

afterEach(async () => {
  for (const service of services) {
    await service.shutdown('test cleanup');
  }
  services = [];
  rmSync(root, { recursive: true, force: true });
});

describe('startup', () => {
  it('brings every subsystem up in dependency order', async () => {
    const service = await start();
    expect(service.lifecycle.state).toBe('running');
    expect(service.lifecycle.running).toEqual([
      'secret-key',
      'database',
      'migrations',
      'logging',
      'config',
      'watchdog',
    ]);
  });

  it('creates the database and applies the schema', async () => {
    const service = await start();
    const row = service.db.get<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations',
    );
    expect(row?.version).toBeGreaterThan(0);
  });

  it('creates the log directory and its files', async () => {
    await start();
    expect(readdirSync(join(root, 'log'))).toEqual(expect.arrayContaining(['app.log']));
  });

  it('loads configuration defaults', async () => {
    const service = await start();
    expect(Object.keys(service.config.getAll()).length).toBeGreaterThan(0);
  });

  it('tells systemd it is ready only after everything has started', async () => {
    const notifier = new NoopNotifier();
    await start({ notifier });
    expect(notifier.messages[0]).toBe('READY=1');
  });

  /**
   * A half-built service handed back to a caller is worse than no service: it looks
   * usable and fails on first request. A failed start must unwind and throw.
   */
  it('fails cleanly when the secret key is missing', async () => {
    await expect(bootstrap(options({ secretKeyPath: join(root, 'absent.key') }))).rejects.toThrow(
      /secret-key/,
    );
  });

  it('leaves nothing running after a failed start', async () => {
    let error: unknown;
    try {
      await bootstrap(options({ secretKeyPath: join(root, 'absent.key') }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    // The database stage never ran, so no `.db` file was created to leak.
    expect(existsSync(join(root, 'db', 'tnc-bridge.db'))).toBe(false);
  });
});

describe('the watchdog stage', () => {
  it('runs no timer when systemd sets no WatchdogSec', async () => {
    const service = await start({ env: {} });
    expect(service.watchdog).toBeUndefined();
  });

  it('starts a watchdog when WATCHDOG_USEC is present', async () => {
    const service = await start({ env: { WATCHDOG_USEC: '30000000' } });
    expect(service.watchdog?.running).toBe(true);
  });

  it('stops the watchdog on shutdown', async () => {
    const service = await start({ env: { WATCHDOG_USEC: '30000000' } });
    await service.shutdown();
    expect(service.watchdog?.running).toBe(false);
  });
});

describe('graceful shutdown', () => {
  it('stops every stage and closes the database', async () => {
    const service = await start();
    await service.shutdown();
    expect(service.lifecycle.state).toBe('stopped');
    expect(service.db.isOpen).toBe(false);
  });

  it('is idempotent', async () => {
    const service = await start();
    await Promise.all([service.shutdown(), service.shutdown()]);
    expect(service.lifecycle.state).toBe('stopped');
  });

  it('tells systemd it is stopping before it tears anything down', async () => {
    const notifier = new NoopNotifier();
    const service = await start({ notifier });
    notifier.messages.length = 0;
    await service.shutdown();
    expect(notifier.messages[0]).toBe('STOPPING=1');
  });

  /**
   * The WAL matters because backups of this database are taken by copying the file. An
   * un-checkpointed WAL leaves the last writes only in `-wal`, so the copy is silently
   * stale rather than obviously broken.
   */
  it('checkpoints the WAL so the last writes live in the .db file itself', async () => {
    const dbPath = join(root, 'db', 'tnc-bridge.db');
    const service = await start();
    service.db.run(
      "INSERT INTO config (key, value, is_secret, updated_at) VALUES ('probe.key', '1', 0, 1)",
    );
    await service.shutdown();

    // A TRUNCATE checkpoint empties the -wal file rather than leaving the write
    // stranded in it, which is what makes a file-copy backup of the .db trustworthy.
    const wal = `${dbPath}-wal`;
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);

    // And the value is genuinely readable through a fresh handle.
    const reopened = Db.open({ path: dbPath, readonly: true });
    try {
      expect(
        reopened.get<{ value: string }>("SELECT value FROM config WHERE key = 'probe.key'"),
      ).toEqual({ value: '1' });
    } finally {
      reopened.close();
    }
  });

  /**
   * The acceptance criterion for T8, modelled literally: a transfer is mid-write when
   * SIGTERM arrives. Shutdown must wait for the rename rather than exiting between the
   * write and the rename, which is what would strand a `.tnc-tmp-*` file on the share.
   */
  it('waits for an in-flight transfer, leaving no temp file behind', async () => {
    const share = join(root, 'share');
    mkdirSync(share, { recursive: true });
    const temp = join(share, `${TEMP_FILE_PREFIX}1234`);
    const final = join(share, '1234.H');

    const service = await start();

    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const transfer = service.drain.track('transfer 1234.H', async () => {
      writeFileSync(temp, 'BEGIN PGM 1234\n');
      await gate;
      renameSync(temp, final);
    });

    // SIGTERM arrives while the temp file exists and the rename has not happened.
    expect(existsSync(temp)).toBe(true);
    const shutdown = service.shutdown('SIGTERM');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.lifecycle.state).toBe('running'); // still waiting on the drain

    released();
    await transfer;
    await shutdown;

    expect(existsSync(temp)).toBe(false);
    expect(existsSync(final)).toBe(true);
    expect(readdirSync(share)).toEqual(['1234.H']);
  });

  it('refuses to start new work once shutdown has begun', async () => {
    const service = await start();
    const handle = service.drain.begin('running transfer');
    const shutdown = service.shutdown('SIGTERM');

    expect(() => service.drain.begin('new transfer')).toThrow(/shutting down/);

    handle.done();
    await shutdown;
  });

  it('gives up on a stuck operation at the drain deadline rather than hanging forever', async () => {
    const service = await start({ drainTimeoutMs: 30 });
    service.drain.begin('stuck transfer');

    await service.shutdown('SIGTERM');
    expect(service.lifecycle.state).toBe('stopped');
    expect(service.db.isOpen).toBe(false);
  });
});

describe('signal handling', () => {
  /** A fake process, so the suite never installs handlers on the real one. */
  function fakeTarget(): SignalTarget & { handlers: Map<string, () => void>; removed: string[] } {
    const handlers = new Map<string, () => void>();
    const removed: string[] = [];
    return {
      handlers,
      removed,
      on(signal, handler) {
        handlers.set(signal, handler);
        return this;
      },
      off(signal) {
        removed.push(signal);
        return this;
      },
    };
  }

  it('installs a handler for SIGTERM and SIGINT', () => {
    const target = fakeTarget();
    installSignalHandlers({ shutdown: () => Promise.resolve() }, { target });
    expect([...target.handlers.keys()]).toEqual(['SIGTERM', 'SIGINT']);
  });

  it('shuts down on SIGTERM and reports completion', async () => {
    const target = fakeTarget();
    const shutdown = jest.fn(() => Promise.resolve());
    const onComplete = jest.fn();
    installSignalHandlers({ shutdown }, { target, onComplete });

    target.handlers.get('SIGTERM')!();
    await new Promise((resolve) => setImmediate(resolve));

    expect(shutdown).toHaveBeenCalledWith('SIGTERM');
    expect(onComplete).toHaveBeenCalledWith('SIGTERM');
  });

  /**
   * An impatient second Ctrl+C would otherwise abort a drain that was seconds from
   * finishing — producing exactly the orphaned temp file the drain prevents.
   */
  it('ignores a repeated signal rather than escalating', async () => {
    const target = fakeTarget();
    const shutdown = jest.fn(() => Promise.resolve());
    installSignalHandlers({ shutdown }, { target });

    target.handlers.get('SIGTERM')!();
    target.handlers.get('SIGTERM')!();
    target.handlers.get('SIGINT')!();
    await new Promise((resolve) => setImmediate(resolve));

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('logs rather than crashing when shutdown itself fails', async () => {
    const target = fakeTarget();
    const lines: string[] = [];
    installSignalHandlers(
      { shutdown: () => Promise.reject(new Error('unmount hung')) },
      {
        target,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: (message) => lines.push(message),
        },
      },
    );

    target.handlers.get('SIGTERM')!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toContain('shutdown failed');
  });

  it('removes its handlers when uninstalled', () => {
    const target = fakeTarget();
    const uninstall = installSignalHandlers({ shutdown: () => Promise.resolve() }, { target });
    uninstall();
    expect(target.removed).toEqual(['SIGTERM', 'SIGINT']);
  });
});

describe('--check self-test', () => {
  /**
   * Runs the real startup path, so an installer learns that the secret key is
   * unreadable before systemd starts flapping the unit.
   */
  it('passes on a healthy installation', async () => {
    const result = await selfCheck(options());
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      'startup',
      'database',
      'schema',
      'config',
    ]);
  });

  it('leaves nothing running afterwards', async () => {
    await selfCheck(options());
    // A second check on the same paths would fail if the first had held the database.
    expect((await selfCheck(options())).ok).toBe(true);
  });

  it('fails with a diagnosis when a prerequisite is missing', async () => {
    const result = await selfCheck(options({ secretKeyPath: join(root, 'absent.key') }));
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: 'startup', ok: false });
    expect(result.checks[0]?.detail).toMatch(/secret-key/);
  });
});

describe('bootstrapLogger', () => {
  it('is silent when quiet', () => {
    const write = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    bootstrapLogger(true).info('hidden');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('writes levelled lines to stderr, keeping stdout clean for journald', () => {
    const written: string[] = [];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const logger = bootstrapLogger(false);
    logger.info('starting');
    logger.warn('slow', { ms: 12 });
    logger.error('failed');
    write.mockRestore();

    expect(written[0]).toBe('[info] starting\n');
    expect(written[1]).toBe('[warn] slow {"ms":12}\n');
    expect(written[2]).toBe('[error] failed\n');
  });
});
