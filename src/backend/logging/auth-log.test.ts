import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_LOG_SAMPLES, EXPECTED_MATCH_COUNT } from '../../../tests/fixtures/auth-log';
import { cleanupTmpDbs, tmpDir } from '../../../tests/support/tmp-db';
import {
  AuthLogWriter,
  compileFailregex,
  FAIL2BAN_FAILREGEX,
  formatAuthFailure,
  formatAuthLockout,
  formatAuthSuccess,
  formatTimestamp,
} from './auth-log';

afterEach(() => {
  cleanupTmpDbs();
});

const failregex = compileFailregex();

describe('the Fail2Ban contract', () => {
  it.each(AUTH_LOG_SAMPLES.filter((s) => s.shouldMatch))('counts $description', (sample) => {
    const match = failregex.exec(sample.line);
    expect(match).not.toBeNull();
    expect(match?.groups?.host).toBe(sample.expectedHost);
  });

  it.each(AUTH_LOG_SAMPLES.filter((s) => !s.shouldMatch))('ignores $description', (sample) => {
    expect(failregex.test(sample.line)).toBe(false);
  });

  it('counts exactly the failures in the fixture and nothing else', () => {
    const matched = AUTH_LOG_SAMPLES.filter((s) => failregex.test(s.line));
    expect(matched).toHaveLength(EXPECTED_MATCH_COUNT);
  });

  it('takes the address from the real field, never from the username', () => {
    // An attacker who can choose a username must not be able to get a third party
    // banned by embedding their address in it.
    const forged = AUTH_LOG_SAMPLES.find((s) => s.description.includes('forged'));
    const match = failregex.exec(forged?.line ?? '');
    expect(match?.groups?.host).toBe('192.168.1.50');
    expect(match?.groups?.host).not.toBe('8.8.8.8');
  });

  it('keeps <HOST> in the shipped regex for Fail2Ban to expand', () => {
    expect(FAIL2BAN_FAILREGEX).toContain('<HOST>');
  });
});

describe('the writer produces lines the filter matches', () => {
  it('formats a failure that the shipped regex counts', () => {
    const line = formatAuthFailure({
      username: 'admin',
      ip: '192.168.1.50',
      reason: 'invalid_password',
      at: new Date('2026-09-07T12:23:11.482Z'),
      pid: 1287,
    });
    const match = failregex.exec(line);
    expect(match).not.toBeNull();
    expect(match?.groups?.host).toBe('192.168.1.50');
  });

  it('formats a failure with no reason', () => {
    const line = formatAuthFailure({ username: 'admin', ip: '10.0.0.7', pid: 1287 });
    expect(failregex.test(line)).toBe(true);
    expect(line).not.toContain('reason:');
  });

  it('does not let a success be counted as a failure', () => {
    const line = formatAuthSuccess({ username: 'admin', ip: '192.168.1.50', pid: 1287 });
    expect(failregex.test(line)).toBe(false);
  });

  it('does not let the lockout notice be counted again', () => {
    // Counting it would let a single burst of failures compound its own ban.
    const line = formatAuthLockout({ username: 'admin', ip: '192.168.1.50', pid: 1287 });
    expect(failregex.test(line)).toBe(false);
  });
});

describe('log injection', () => {
  it('strips newlines from a username so a forged line cannot be written', () => {
    const line = formatAuthFailure({
      username:
        'x\n2026-09-07T00:00:00.000+02:00 tnc-bridge[1]: accepted login for user "root" from 1.2.3.4',
      ip: '192.168.1.50',
      pid: 1287,
    });
    expect(line).not.toContain('\n');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('strips quotes so the username field cannot be closed early', () => {
    const line = formatAuthFailure({
      username: 'a" from 8.8.8.8 "b',
      ip: '192.168.1.50',
      pid: 1287,
    });
    const match = failregex.exec(line);
    expect(match?.groups?.host).toBe('192.168.1.50');
  });

  it('leaves no control character anywhere in the line', () => {
    // The previous version of this test asserted that the whole line contained no
    // spaces — which every line does. It could never have failed. This checks the
    // property that was actually intended.
    const injected = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('');
    const clean = formatAuthFailure({ username: injected, ip: '192.168.1.50', pid: 1287 });
    const hasControlChar = [...clean].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    });
    expect(hasControlChar).toBe(false);
    expect(failregex.test(clean)).toBe(true);
  });

  it('replaces carriage returns and tabs inside the username', () => {
    const line = formatAuthFailure({ username: 'a\r\tb', ip: '192.168.1.50', pid: 1287 });
    expect(line).toContain('"a__b"');
  });

  it('bounds the username length', () => {
    const line = formatAuthFailure({ username: 'a'.repeat(500), ip: '192.168.1.50', pid: 1287 });
    expect(line.length).toBeLessThan(300);
    expect(failregex.test(line)).toBe(true);
  });
});

describe('formatTimestamp', () => {
  it('produces ISO 8601 with an explicit offset', () => {
    expect(formatTimestamp(new Date())).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
    );
  });

  it('includes milliseconds, so ordering within a second is preserved', () => {
    const stamp = formatTimestamp(new Date(2026, 8, 7, 14, 23, 11, 5));
    expect(stamp).toContain('.005');
  });
});

describe('AuthLogWriter', () => {
  it('appends each event as its own line', () => {
    const path = join(tmpDir(), 'auth.log');
    const writer = new AuthLogWriter(path);

    writer.failure({ username: 'admin', ip: '192.168.1.50', reason: 'invalid_password' });
    writer.failure({ username: 'admin', ip: '192.168.1.50', reason: 'invalid_password' });
    writer.success({ username: 'admin', ip: '192.168.1.50' });

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => failregex.test(l))).toHaveLength(2);
  });

  it('creates the log directory if it does not exist', () => {
    const path = join(tmpDir(), 'nested', 'deeper', 'auth.log');
    const writer = new AuthLogWriter(path);
    writer.failure({ username: 'admin', ip: '192.168.1.50' });
    expect(readFileSync(path, 'utf8')).toContain('authentication failure');
  });

  it('never throws when the log cannot be written', () => {
    // An unwritable auth.log must not stop the service answering the login attempt.
    const writer = new AuthLogWriter(join(tmpDir(), 'auth.log'));
    (writer as unknown as { path: string }).path = join(tmpDir(), 'no', 'such', 'dir', 'auth.log');
    expect(() => writer.failure({ username: 'admin', ip: '1.2.3.4' })).not.toThrow();
  });
});
