import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The plaintext `auth.log` that Fail2Ban watches.
 *
 * This file exists for one consumer — a regex — so its format is frozen and defined
 * here next to the regex that must match it. {@link FAIL2BAN_FAILREGEX} is the exact
 * string shipped in `filter.d/tnc-bridge.conf` (T37), and the tests run real generated
 * lines through it. That is the whole point: a format change that breaks brute-force
 * protection fails the build instead of silently disabling the jail.
 *
 * The lines are deliberately syslog-shaped rather than JSON. Fail2Ban's date detectors
 * and `<HOST>` token are built for this shape, and every operator who has ever debugged
 * a jail already knows how to read it.
 */

export const AUTH_LOG_TAG = 'tnc-bridge';

export const DEFAULT_AUTH_LOG_PATH = '/var/log/tnc-bridge/auth.log';

/** Why an authentication attempt failed. Recorded for the operator, ignored by the regex. */
export type AuthFailureReason =
  | 'invalid_password'
  | 'unknown_user'
  | 'rate_limited'
  | 'session_expired'
  | 'csrf_invalid'
  | 'invalid_token';

/**
 * The failregex shipped in `filter.d/tnc-bridge.conf`.
 *
 * `<HOST>` is Fail2Ban's own token; it is substituted with a host/address pattern at
 * load time. The reason suffix is optional so that adding or removing it later cannot
 * break matching.
 */
export const FAIL2BAN_FAILREGEX =
  '^.*\\s' +
  AUTH_LOG_TAG +
  '\\[\\d+\\]: authentication failure for user "[^"]*" from <HOST>(?: \\(reason: \\S+\\))?\\s*$';

/**
 * Compiles the shipped failregex for use in a JavaScript test.
 *
 * Substitutes Fail2Ban's `<HOST>` with an equivalent address pattern. This is an
 * approximation of Fail2Ban's own expansion — close enough to catch a format change,
 * which is what the test is for. `fail2ban-regex` against the same fixture is the
 * authoritative check and runs in T37.
 */
export function compileFailregex(failregex: string = FAIL2BAN_FAILREGEX): RegExp {
  return new RegExp(failregex.replace('<HOST>', '(?<host>[0-9a-fA-F:.]+)'));
}

/**
 * ISO 8601 with the local UTC offset, e.g. `2026-09-07T14:23:11.123+02:00`.
 *
 * Local time rather than UTC so the timestamps line up with `journalctl` when an
 * operator is comparing the two, and with an explicit offset so they stay unambiguous
 * across the DST transitions that a Swiss shop floor sees twice a year.
 */
export function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`
  );
}

/**
 * A username can contain anything a client sends, so it is quoted and sanitised.
 * An unescaped newline would let an attacker forge log lines — including lines that
 * look like successful logins from someone else's address.
 */
function sanitise(value: string, maxLength = 128): string {
  return (
    value
      .replace(/[\r\n\t"\\]/g, '_')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\x00-\x1f\x7f]/g, '')
      .slice(0, maxLength)
  );
}

export interface AuthEventBase {
  readonly username: string;
  readonly ip: string;
  readonly at?: Date;
  readonly pid?: number;
}

export interface AuthFailureEvent extends AuthEventBase {
  readonly reason?: AuthFailureReason;
}

/** The line Fail2Ban counts. Format frozen — see {@link FAIL2BAN_FAILREGEX}. */
export function formatAuthFailure(event: AuthFailureEvent): string {
  const prefix = linePrefix(event);
  const reason = event.reason === undefined ? '' : ` (reason: ${event.reason})`;
  return `${prefix}authentication failure for user "${sanitise(event.username)}" from ${sanitise(event.ip, 64)}${reason}`;
}

export function formatAuthSuccess(event: AuthEventBase): string {
  return `${linePrefix(event)}accepted login for user "${sanitise(event.username)}" from ${sanitise(event.ip, 64)}`;
}

export function formatAuthLogout(event: AuthEventBase): string {
  return `${linePrefix(event)}session closed for user "${sanitise(event.username)}" from ${sanitise(event.ip, 64)}`;
}

/** A lockout is informational — the ban itself is Fail2Ban's decision, not ours. */
export function formatAuthLockout(event: AuthEventBase): string {
  return `${linePrefix(event)}too many authentication failures for user "${sanitise(event.username)}" from ${sanitise(event.ip, 64)}`;
}

function linePrefix(event: AuthEventBase): string {
  const pid = event.pid ?? process.pid;
  return `${formatTimestamp(event.at ?? new Date())} ${AUTH_LOG_TAG}[${pid}]: `;
}

/**
 * Appends to `auth.log`.
 *
 * Synchronous and unbuffered: Fail2Ban polls the file, so a buffered write would delay
 * a ban past the window in which it is useful. A write failure is swallowed — an
 * unwritable log must not prevent the login attempt from being answered.
 */
export class AuthLogWriter {
  constructor(private readonly path: string = DEFAULT_AUTH_LOG_PATH) {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  failure(event: AuthFailureEvent): void {
    this.write(formatAuthFailure(event));
  }

  success(event: AuthEventBase): void {
    this.write(formatAuthSuccess(event));
  }

  logout(event: AuthEventBase): void {
    this.write(formatAuthLogout(event));
  }

  lockout(event: AuthEventBase): void {
    this.write(formatAuthLockout(event));
  }

  write(line: string): void {
    try {
      appendFileSync(this.path, `${line}\n`, 'utf8');
    } catch {
      // Intentionally silent. See the class comment.
    }
  }
}
