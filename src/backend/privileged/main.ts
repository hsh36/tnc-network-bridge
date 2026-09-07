import { readFileSync } from 'node:fs';

import {
  type AuditSink,
  buildRecord,
  FileAuditSink,
  redactArgs,
  redactArgv,
} from './audit';
import { CommandError } from './exec';
import { defaultDeps, type HandlerDeps, execute, PrivilegedExecutionError } from './handlers';
import { PRIVILEGED_VERBS, PrivilegedValidationError, validateRequest } from './verbs';

/**
 * The privileged helper's entrypoint — the process sudo actually starts.
 *
 * It reads **one JSON request from stdin**, never from argv. That is a security
 * decision, not a style one:
 *
 *  - `/proc/<pid>/cmdline` is world-readable on Linux. An AD service-account password
 *    passed as an argument would be visible to every local user for the lifetime of the
 *    process, and to anything sampling `ps`.
 *  - The sudoers rule can then permit the binary with **no arguments at all**. A rule
 *    that has to allow arguments has to describe them, and sudo's wildcard matching is
 *    a notoriously poor place to express "any share name but nothing with a slash".
 *
 * Exit codes are distinct so the caller can tell a rejected request from a failed one:
 * a `2` means someone sent something the boundary refused, which is a security event;
 * a `3` means a legitimate operation did not work, which is an operations event.
 */

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_DENIED = 2;
export const EXIT_FAILED = 3;

export interface HelperIo {
  readonly argv: readonly string[];
  readonly readStdin: () => string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly getuid: () => number;
  readonly getgid: () => number;
  readonly env: Record<string, string | undefined>;
  readonly now: () => number;
}

export const defaultIo: HelperIo = {
  argv: process.argv.slice(2),
  readStdin: () => readFileSync(0, 'utf8'),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  /* c8 ignore next 2 -- not available on the Windows dev host; exercised on the target. */
  getuid: () => process.getuid?.() ?? -1,
  getgid: () => process.getgid?.() ?? -1,
  env: process.env,
  now: () => Date.now(),
};

export interface HelperResponse {
  readonly ok: boolean;
  readonly verb?: string;
  readonly detail?: Record<string, unknown>;
  readonly error?: string;
  readonly code?: 'denied' | 'failed' | 'usage';
}

const USAGE = `tnc-bridge-helper — privileged operations for the TNC Network Bridge.

Reads one JSON request on stdin and writes one JSON response on stdout.
Must be invoked as root, normally through the sudoers rule installed at
/etc/sudoers.d/tnc-bridge.

Verbs: ${PRIVILEGED_VERBS.join(', ')}

Options:
  --help          show this message
  --list-verbs    print the permitted verbs, one per line
`;

export function runHelper(io: HelperIo = defaultIo, deps: HandlerDeps = defaultDeps, sink?: AuditSink): number {
  const auditSink = sink ?? new FileAuditSink();
  const started = io.now();

  if (io.argv.includes('--help') || io.argv.includes('-h')) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (io.argv.includes('--list-verbs')) {
    io.stdout(`${PRIVILEGED_VERBS.join('\n')}\n`);
    return EXIT_OK;
  }

  const uid = io.getuid();
  const gid = io.getgid();
  const context = {
    uid,
    gid,
    ...(io.env.SUDO_USER === undefined ? {} : { invoker: io.env.SUDO_USER }),
  };

  const fail = (
    code: 'denied' | 'failed' | 'usage',
    verb: string,
    message: string,
    exit: number,
    commands: readonly (readonly string[])[] = [],
  ): number => {
    auditSink.write(
      buildRecord(context, {
        verb,
        outcome: code === 'failed' ? 'failed' : 'denied',
        durationMs: io.now() - started,
        error: message,
        ...(commands.length === 0 ? {} : { commands: commands.map(redactArgv) }),
      }),
    );
    const response: HelperResponse = { ok: false, error: message, code, verb };
    io.stdout(`${JSON.stringify(response)}\n`);
    io.stderr(`${message}\n`);
    return exit;
  };

  /**
   * The assertion the whole design rests on.
   *
   * If the helper is somehow reachable as a non-root user it must not pretend to work —
   * a half-succeeding privileged tool teaches operators to ignore its errors, and a
   * helper that runs unprivileged would silently produce broken mounts and configs that
   * look like ordinary failures rather than a misinstalled privilege boundary.
   */
  if (uid !== 0) {
    return fail(
      'usage',
      '<none>',
      `must run as root (uid 0), but the effective uid is ${uid}. ` +
        'Invoke via: sudo /usr/local/lib/tnc-bridge/helper',
      EXIT_USAGE,
    );
  }

  if (io.argv.length > 0) {
    return fail(
      'usage',
      '<none>',
      `takes no arguments; the request is read from stdin (got: ${io.argv.join(' ')})`,
      EXIT_USAGE,
    );
  }

  let raw: unknown;
  try {
    const text = io.readStdin();
    if (text.trim() === '') {
      return fail('usage', '<none>', 'no request received on stdin', EXIT_USAGE);
    }
    raw = JSON.parse(text);
  } catch (error) {
    return fail(
      'usage',
      '<none>',
      `could not read a JSON request from stdin: ${(error as Error).message}`,
      EXIT_USAGE,
    );
  }

  const rawVerb =
    typeof raw === 'object' && raw !== null && 'verb' in raw && typeof raw.verb === 'string'
      ? raw.verb
      : '<missing>';

  let request;
  try {
    request = validateRequest(raw);
  } catch (error) {
    if (error instanceof PrivilegedValidationError) {
      return fail('denied', error.verb, error.message, EXIT_DENIED);
    }
    return fail('denied', rawVerb, (error as Error).message, EXIT_DENIED);
  }

  try {
    const result = execute(request, deps);
    auditSink.write(
      buildRecord(context, {
        verb: result.verb,
        outcome: 'ok',
        durationMs: io.now() - started,
        args: redactArgs({ ...request }),
        commands: result.commands.map(redactArgv),
      }),
    );
    const response: HelperResponse = { ok: true, verb: result.verb, detail: result.detail };
    io.stdout(`${JSON.stringify(response)}\n`);
    return EXIT_OK;
  } catch (error) {
    const message =
      error instanceof CommandError || error instanceof PrivilegedExecutionError
        ? error.message
        : `unexpected failure: ${(error as Error).message}`;
    return fail('failed', request.verb, message, EXIT_FAILED);
  }
}

/* c8 ignore start -- process bootstrap, exercised by the installed binary. */
if (require.main === module) {
  process.exitCode = runHelper();
}
/* c8 ignore stop */
