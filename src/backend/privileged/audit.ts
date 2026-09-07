import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The privileged helper's audit trail.
 *
 * Every invocation is recorded — accepted or rejected, succeeded or failed. A rejected
 * call is the more interesting record of the two: it is the only signal that something
 * is probing the privilege boundary, so validation failures are logged at `denied`
 * rather than discarded.
 *
 * The log is written by root and never by the service user. It is deliberately a
 * separate file from the application log (T6): the application log is rotated, shipped
 * and readable by the service, whereas this one is append-only evidence about the
 * service itself. A process that can rewrite its own audit trail does not have one.
 */

export const DEFAULT_AUDIT_LOG_PATH = '/var/log/tnc-bridge/privileged-audit.log';

export type AuditOutcome = 'ok' | 'failed' | 'denied';

export interface AuditRecord {
  readonly ts: string;
  readonly verb: string;
  readonly outcome: AuditOutcome;
  readonly uid: number;
  readonly gid: number;
  /** `SUDO_USER` — who invoked sudo. Absent when the helper is run directly as root. */
  readonly invoker?: string;
  readonly durationMs: number;
  readonly args?: Record<string, unknown>;
  readonly commands?: readonly (readonly string[])[];
  readonly error?: string;
}

/**
 * Field names whose values never reach the audit log.
 *
 * Redaction is by key, not by value inspection: a value-based scrubber has to guess
 * what a secret looks like and will eventually guess wrong. Anything not on the
 * allowlist of loggable shapes is replaced wholesale.
 */
const REDACTED_FIELDS = new Set([
  'password',
  'passwd',
  'secret',
  'keyPem',
  'certPem',
  'chainPem',
  'credentials',
  'token',
]);

export const REDACTION_PLACEHOLDER = '[redacted]';

/** Arguments are summarised, not echoed: long blobs become a length, secrets vanish. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (REDACTED_FIELDS.has(key)) {
      out[key] = REDACTION_PLACEHOLDER;
    } else if (typeof value === 'string' && value.length > 120) {
      out[key] = `[${value.length} chars]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Scrubs an argv array before it is logged.
 *
 * Nothing the helper builds puts a secret in argv — credentials go to `mount.cifs`
 * through a 0600 file precisely so they never appear in `/proc/<pid>/cmdline`. This is
 * the backstop for a future verb that forgets.
 */
export function redactArgv(argv: readonly string[]): readonly string[] {
  return argv.map((arg) =>
    /^(?:--?[A-Za-z-]*(?:pass|secret|token)[A-Za-z-]*=)/i.test(arg)
      ? arg.replace(/=.*$/, `=${REDACTION_PLACEHOLDER}`)
      : arg,
  );
}

export interface AuditSink {
  write(record: AuditRecord): void;
}

/**
 * Appends JSON lines to a 0600 file owned by root.
 *
 * `appendFileSync` on a path opened `a` is atomic for writes below `PIPE_BUF` on Linux,
 * which every record here is. Synchronous by design: the helper is a short-lived
 * process that may `exit()` immediately after, and an async write would be lost.
 */
export class FileAuditSink implements AuditSink {
  constructor(private readonly path: string = DEFAULT_AUDIT_LOG_PATH) {}

  write(record: AuditRecord): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o750 });
    // Create with 0600 explicitly; `appendFileSync` alone would honour the umask.
    closeSync(openSync(this.path, 'a', 0o600));
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
}

/** Collects records in memory. Used by tests and by `--check`. */
export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];

  write(record: AuditRecord): void {
    this.records.push(record);
  }
}

export interface AuditContext {
  readonly uid: number;
  readonly gid: number;
  readonly invoker?: string;
}

export function buildRecord(
  context: AuditContext,
  fields: Omit<AuditRecord, 'ts' | 'uid' | 'gid' | 'invoker'>,
): AuditRecord {
  return {
    ts: new Date().toISOString(),
    uid: context.uid,
    gid: context.gid,
    ...(context.invoker === undefined ? {} : { invoker: context.invoker }),
    ...fields,
  };
}
