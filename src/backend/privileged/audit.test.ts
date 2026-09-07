import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildRecord,
  FileAuditSink,
  MemoryAuditSink,
  redactArgs,
  redactArgv,
  REDACTION_PLACEHOLDER,
} from './audit';

describe('redactArgs', () => {
  it.each(['password', 'passwd', 'secret', 'keyPem', 'certPem', 'chainPem', 'credentials', 'token'])(
    'replaces the %s field wholesale',
    (field) => {
      expect(redactArgs({ [field]: 'super secret value' })).toEqual({
        [field]: REDACTION_PLACEHOLDER,
      });
    },
  );

  it('keeps ordinary fields so the audit entry is still useful', () => {
    expect(redactArgs({ verb: 'mount-share', shareName: 'werkstatt', uid: 1000 })).toEqual({
      verb: 'mount-share',
      shareName: 'werkstatt',
      uid: 1000,
    });
  });

  it('summarises long blobs by length rather than inlining a config file', () => {
    expect(redactArgs({ content: 'x'.repeat(500) })).toEqual({ content: '[500 chars]' });
  });

  it('leaves short strings intact', () => {
    expect(redactArgs({ mode: 'reload' })).toEqual({ mode: 'reload' });
  });

  it('redacts by key even when the value looks harmless', () => {
    // Key-based redaction, not value sniffing: a scrubber that guesses what a secret
    // looks like eventually guesses wrong.
    expect(redactArgs({ password: '' })).toEqual({ password: REDACTION_PLACEHOLDER });
  });

  it('passes non-string values through', () => {
    expect(redactArgs({ seal: true, dns: ['1.1.1.1'] })).toEqual({ seal: true, dns: ['1.1.1.1'] });
  });
});

describe('redactArgv', () => {
  it('masks the value of a password-like flag', () => {
    expect(redactArgv(['/usr/bin/tool', '--password=hunter2'])).toEqual([
      '/usr/bin/tool',
      `--password=${REDACTION_PLACEHOLDER}`,
    ]);
  });

  it.each(['--pass=x', '--secret=x', '--api-token=x', '-password=x'])('masks %p', (arg) => {
    expect(redactArgv([arg])[0]).toContain(REDACTION_PLACEHOLDER);
  });

  it('leaves ordinary arguments untouched, so the audit trail stays readable', () => {
    const argv = ['/usr/bin/mount', '-t', 'cifs', '//server/share', '/mnt/tnc-server/werkstatt'];
    expect(redactArgv(argv)).toEqual(argv);
  });

  it('does not mask a path that merely contains the word pass', () => {
    expect(redactArgv(['/etc/passwd'])).toEqual(['/etc/passwd']);
  });
});

describe('buildRecord', () => {
  it('stamps the identity of the process and the invoking account', () => {
    const record = buildRecord(
      { uid: 0, gid: 0, invoker: 'tncbridge' },
      { verb: 'reload-samba', outcome: 'ok', durationMs: 12 },
    );
    expect(record).toMatchObject({ uid: 0, gid: 0, invoker: 'tncbridge', outcome: 'ok' });
    expect(Date.parse(record.ts)).not.toBeNaN();
  });

  it('omits the invoker when the helper was run directly as root', () => {
    const record = buildRecord({ uid: 0, gid: 0 }, { verb: 'reload-samba', outcome: 'ok', durationMs: 1 });
    expect(record).not.toHaveProperty('invoker');
  });
});

describe('MemoryAuditSink', () => {
  it('collects records in order', () => {
    const sink = new MemoryAuditSink();
    sink.write(buildRecord({ uid: 0, gid: 0 }, { verb: 'a', outcome: 'ok', durationMs: 1 }));
    sink.write(buildRecord({ uid: 0, gid: 0 }, { verb: 'b', outcome: 'denied', durationMs: 2 }));
    expect(sink.records.map((record) => record.verb)).toEqual(['a', 'b']);
  });
});

describe('FileAuditSink', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tnc-audit-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('appends one JSON object per line', () => {
    const path = join(directory, 'audit.log');
    const sink = new FileAuditSink(path);
    sink.write(buildRecord({ uid: 0, gid: 0 }, { verb: 'mount-share', outcome: 'ok', durationMs: 4 }));
    sink.write(buildRecord({ uid: 0, gid: 0 }, { verb: 'unmount-share', outcome: 'failed', durationMs: 5 }));

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as { verb: string }).verb)).toEqual([
      'mount-share',
      'unmount-share',
    ]);
  });

  it('creates the log directory when it does not exist', () => {
    const path = join(directory, 'nested', 'deeper', 'audit.log');
    new FileAuditSink(path).write(
      buildRecord({ uid: 0, gid: 0 }, { verb: 'reload-samba', outcome: 'ok', durationMs: 1 }),
    );
    expect(readFileSync(path, 'utf8')).toContain('reload-samba');
  });

  /** The audit trail records what the service did; the service must not be able to read it back. */
  it('creates the log file 0600', () => {
    if (process.platform === 'win32') {
      return; // POSIX modes are not meaningful here; asserted on Linux in CI.
    }
    const path = join(directory, 'audit.log');
    new FileAuditSink(path).write(
      buildRecord({ uid: 0, gid: 0 }, { verb: 'reload-samba', outcome: 'ok', durationMs: 1 }),
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
