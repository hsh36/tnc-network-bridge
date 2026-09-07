import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { pruneLogEntries, SqliteLogSink } from './sqlite-sink';

let db: Db;
let sink: SqliteLogSink;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  sink = new SqliteLogSink({ db });
});

afterEach(() => {
  cleanupTmpDbs();
});

const ndjson = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

interface Row {
  ts: number;
  level: string;
  source: string;
  message: string;
  request_id: string | null;
  share_id: number | null;
  context: string | null;
}

const rows = (): Row[] => db.all<Row>('SELECT * FROM log_entries ORDER BY id');

describe('ingestion', () => {
  it('stores a pino record as a queryable row', () => {
    sink.write(
      ndjson({
        level: 40,
        time: 1_757_000_000_000,
        msg: 'mount lost',
        source: 'smb',
        requestId: 'req-1',
        shareId: 3,
        attempt: 2,
      }),
    );

    const [row] = rows();
    expect(row?.level).toBe('warn');
    expect(row?.source).toBe('smb');
    expect(row?.message).toBe('mount lost');
    expect(row?.request_id).toBe('req-1');
    expect(row?.share_id).toBe(3);
    expect(JSON.parse(row?.context ?? '{}')).toEqual({ attempt: 2 });
  });

  it.each([
    [10, 'trace'],
    [20, 'debug'],
    [30, 'info'],
    [40, 'warn'],
    [50, 'error'],
    [60, 'fatal'],
  ])('maps pino level %i to %s', (level, expected) => {
    sink.write(ndjson({ level, time: Date.now(), msg: 'x', source: 'app' }));
    expect(rows()[0]?.level).toBe(expected);
  });

  it('handles several records in one chunk', () => {
    sink.write(
      ndjson({ level: 30, time: 1, msg: 'a', source: 'app' }) +
        ndjson({ level: 30, time: 2, msg: 'b', source: 'sync' }),
    );
    expect(rows()).toHaveLength(2);
  });

  it('leaves context null when there is nothing beyond the promoted fields', () => {
    sink.write(ndjson({ level: 30, time: 1, msg: 'plain', source: 'app', pid: 1, hostname: 'pi' }));
    expect(rows()[0]?.context).toBeNull();
  });

  it('falls back to the app source for an unknown one', () => {
    // The column has a CHECK constraint; an unrecognised source would otherwise
    // make the insert throw and lose the entry entirely.
    sink.write(ndjson({ level: 30, time: 1, msg: 'x', source: 'wat' }));
    expect(rows()[0]?.source).toBe('app');
  });

  it('truncates an oversized message rather than rejecting it', () => {
    sink.write(ndjson({ level: 30, time: 1, msg: 'y'.repeat(10_000), source: 'app' }));
    expect(rows()[0]?.message.length).toBeLessThanOrEqual(4000);
  });

  it('truncates oversized context', () => {
    sink.write(ndjson({ level: 30, time: 1, msg: 'x', source: 'app', blob: 'z'.repeat(50_000) }));
    expect((rows()[0]?.context ?? '').length).toBeLessThanOrEqual(8192);
  });
});

describe('resilience', () => {
  it('drops a malformed line and counts it instead of throwing', () => {
    expect(() => sink.write('this is not json\n')).not.toThrow();
    expect(rows()).toHaveLength(0);
    expect(sink.dropped).toBe(1);
  });

  it('drops a JSON value that is not an object', () => {
    sink.write('[1,2,3]\n');
    sink.write('"a string"\n');
    expect(rows()).toHaveLength(0);
    expect(sink.dropped).toBe(2);
  });

  it('ignores blank lines without counting them as drops', () => {
    sink.write('\n\n  \n');
    expect(sink.dropped).toBe(0);
  });

  it('keeps going after a malformed line', () => {
    sink.write('garbage\n');
    sink.write(ndjson({ level: 30, time: 1, msg: 'still working', source: 'app' }));
    expect(rows()).toHaveLength(1);
    expect(sink.written).toBe(1);
  });

  it('does not throw when the database is closed underneath it', () => {
    // This happens during shutdown: something logs after the database is closed.
    // Losing the line is fine; crashing the shutdown path is not.
    db.close();
    expect(() =>
      sink.write(ndjson({ level: 30, time: 1, msg: 'late', source: 'app' })),
    ).not.toThrow();
    expect(sink.dropped).toBe(1);
  });

  it('drops a line containing invalid JSON syntax', () => {
    // pino always emits valid JSON, but this sink also receives whatever a
    // misconfigured stream pipes into it. A syntax error must be a counted drop,
    // never an exception on the logging path.
    sink.write('{"level":30,"time":1,"msg":"x","source":"app","weird":undefinedValue}\n');
    expect(sink.dropped).toBe(1);
    expect(rows()).toHaveLength(0);
  });
});

describe('level filtering', () => {
  it('stores only entries at or above the configured level', () => {
    const filtered = new SqliteLogSink({ db, minLevel: 'warn' });
    filtered.write(ndjson({ level: 30, time: 1, msg: 'info', source: 'app' }));
    filtered.write(ndjson({ level: 50, time: 2, msg: 'error', source: 'app' }));
    expect(rows().map((r) => r.message)).toEqual(['error']);
  });
});

describe('pruneLogEntries', () => {
  it('removes entries older than the retention window', () => {
    const day = 24 * 60 * 60 * 1000;
    sink.write(ndjson({ level: 30, time: Date.now() - 40 * day, msg: 'ancient', source: 'app' }));
    sink.write(ndjson({ level: 30, time: Date.now() - 2 * day, msg: 'recent', source: 'app' }));

    const removed = pruneLogEntries(db, 30);

    expect(removed).toBe(1);
    expect(rows().map((r) => r.message)).toEqual(['recent']);
  });

  it('removes nothing when everything is inside the window', () => {
    sink.write(ndjson({ level: 30, time: Date.now(), msg: 'now', source: 'app' }));
    expect(pruneLogEntries(db, 30)).toBe(0);
  });
});
