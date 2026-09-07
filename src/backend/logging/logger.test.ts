import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import {
  createLogging,
  currentRequestId,
  newRequestId,
  withCorrelationId,
  type LoggingSystem,
} from './logger';

let db: Db;
let logDir: string;
let logging: LoggingSystem;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  logDir = tmpDir('tnc-logs-');
  logging = createLogging({ logDir, db, stdout: false, level: 'debug' });
});

afterEach(() => {
  logging.close();
  cleanupTmpDbs();
});

const readLog = (name: string): string => {
  try {
    return readFileSync(join(logDir, name), 'utf8');
  } catch {
    return '';
  }
};

const storedRows = (): { message: string; source: string; context: string | null }[] =>
  db.all('SELECT message, source, context FROM log_entries ORDER BY id');

describe('fan-out across sinks', () => {
  it('delivers one log call to every configured sink', () => {
    // The acceptance criterion for T6: a single call must reach app.log, the
    // subsystem file, and the SQLite viewer sink.
    logging.child('sync').info({ shareId: 1 }, 'sync started');

    expect(readLog('app.log')).toContain('sync started');
    expect(readLog('sync.log')).toContain('sync started');
    expect(storedRows().map((r) => r.message)).toContain('sync started');
  });

  it('routes only sync entries into sync.log', () => {
    logging.child('sync').info('a sync line');
    logging.child('smb').info('an smb line');
    logging.child('auth').info('an auth line');

    const sync = readLog('sync.log');
    expect(sync).toContain('a sync line');
    expect(sync).not.toContain('an smb line');
    expect(sync).not.toContain('an auth line');
  });

  it('keeps every subsystem in app.log', () => {
    logging.child('sync').info('a sync line');
    logging.child('smb').info('an smb line');
    const app = readLog('app.log');
    expect(app).toContain('a sync line');
    expect(app).toContain('an smb line');
  });

  it('tags each entry with its subsystem', () => {
    logging.child('lock').warn('lock expired');
    expect(storedRows().find((r) => r.message === 'lock expired')?.source).toBe('lock');
  });

  it('honours the level threshold', () => {
    const quiet = createLogging({ logDir: tmpDir(), db, stdout: false, level: 'warn' });
    quiet.child('app').debug('should not appear');
    quiet.child('app').error('should appear');
    quiet.close();

    const messages = storedRows().map((r) => r.message);
    expect(messages).not.toContain('should not appear');
    expect(messages).toContain('should appear');
  });

  it('writes valid NDJSON', () => {
    logging.child('app').info({ n: 1 }, 'first');
    logging.child('app').info({ n: 2 }, 'second');

    const lines = readLog('app.log').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });
});

describe('redaction', () => {
  const SECRET = 'Sup3rGeheim!Passwort';

  it('redacts a password at the top level', () => {
    logging.child('smb').info({ password: SECRET }, 'mounting');
    expectSecretAbsent(SECRET);
  });

  it('redacts a credential nested inside an options object', () => {
    logging.child('smb').info(
      {
        mount: { options: { vers: '3.1.1', credentials: { username: 'svc', password: SECRET } } },
      },
      'mount options',
    );
    expectSecretAbsent(SECRET);
  });

  it('redacts a secret nested inside an array', () => {
    // The path-based redaction list cannot express this; the deep walk is what
    // catches it, and this is exactly the case that would otherwise reach a file
    // attached to a support ticket.
    logging.child('smb').info({ shares: [{ name: 'programs', password: SECRET }] }, 'shares');
    expectSecretAbsent(SECRET);
  });

  it('redacts a token and an api key', () => {
    logging.child('auth').info({ token: 'tok_abc123', apiKey: 'key_xyz789' }, 'auth attempt');
    const everything = readLog('app.log') + JSON.stringify(storedRows());
    expect(everything).not.toContain('tok_abc123');
    expect(everything).not.toContain('key_xyz789');
  });

  it('keeps non-secret fields intact', () => {
    logging.child('smb').info({ username: 'svc_cnc', password: SECRET, share: 'programs' }, 'x');
    expect(readLog('app.log')).toContain('svc_cnc');
    expect(readLog('app.log')).toContain('programs');
  });

  function expectSecretAbsent(secret: string): void {
    expect(readLog('app.log')).not.toContain(secret);
    expect(JSON.stringify(storedRows())).not.toContain(secret);
  }
});

describe('correlation ids', () => {
  it('attaches the ambient request id to every line inside the scope', () => {
    const id = newRequestId();
    withCorrelationId(id, () => {
      logging.child('app').info('inside');
    });
    logging.child('app').info('outside');

    const lines = readLog('app.log')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.find((l) => l.msg === 'inside')?.requestId).toBe(id);
    expect(lines.find((l) => l.msg === 'outside')?.requestId).toBeUndefined();
  });

  it('survives an await boundary', async () => {
    const id = newRequestId();
    await withCorrelationId(id, async () => {
      await Promise.resolve();
      logging.child('sync').info('after await');
      expect(currentRequestId()).toBe(id);
    });

    const row = db.get<{ request_id: string }>(
      "SELECT request_id FROM log_entries WHERE message = 'after await'",
    );
    expect(row?.request_id).toBe(id);
  });

  it('keeps concurrent scopes separate', async () => {
    const a = newRequestId();
    const b = newRequestId();
    await Promise.all([
      withCorrelationId(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        logging.child('app').info('from a');
      }),
      withCorrelationId(b, async () => {
        await Promise.resolve();
        logging.child('app').info('from b');
      }),
    ]);

    const rows = db.all<{ message: string; request_id: string }>(
      'SELECT message, request_id FROM log_entries',
    );
    expect(rows.find((r) => r.message === 'from a')?.request_id).toBe(a);
    expect(rows.find((r) => r.message === 'from b')?.request_id).toBe(b);
  });

  it('returns undefined outside any scope', () => {
    expect(currentRequestId()).toBeUndefined();
  });

  it('generates distinct ids', () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

describe('rotation through the logging system', () => {
  it('rotates both files on demand', () => {
    logging.child('app').info('before rotation');
    logging.child('sync').info('sync before rotation');
    logging.rotate();
    logging.child('app').info('after rotation');

    expect(readLog('app.log.1')).toContain('before rotation');
    expect(readLog('app.log')).toContain('after rotation');
    expect(readLog('app.log')).not.toContain('before rotation');
    expect(readLog('sync.log.1')).toContain('sync before rotation');
  });

  it('rotates automatically once the size limit is passed', () => {
    const dir = tmpDir();
    const small = createLogging({ logDir: dir, stdout: false, maxBytes: 512, maxFiles: 3 });
    for (let i = 0; i < 40; i += 1) {
      small.child('app').info({ i, filler: 'z'.repeat(100) }, 'noisy');
    }
    small.close();

    expect(readFileSync(join(dir, 'app.log.1'), 'utf8').length).toBeGreaterThan(0);
  });
});

describe('optional sinks', () => {
  it('works with no database, so logging is available before migrations run', () => {
    const dir = tmpDir();
    const early = createLogging({ logDir: dir, stdout: false });
    expect(() => early.child('app').info('starting up')).not.toThrow();
    early.close();
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toContain('starting up');
  });

  it('exposes the auth log writer alongside the structured sinks', () => {
    logging.authLog.failure({ username: 'admin', ip: '192.168.1.50', reason: 'invalid_password' });
    expect(readLog('auth.log')).toContain('authentication failure');
  });
});
