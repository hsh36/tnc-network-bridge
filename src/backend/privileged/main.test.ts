import { MemoryAuditSink } from './audit';
import { CommandError, type CommandResult } from './exec';
import { type FilesystemPort, type HandlerDeps } from './handlers';
import {
  EXIT_DENIED,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type HelperIo,
  type HelperResponse,
  runHelper,
} from './main';

/**
 * The entrypoint's job is to be paranoid before it is useful: refuse to run
 * unprivileged, refuse arguments, refuse anything the validator dislikes, and write an
 * audit record whichever of those happens.
 */

/**
 * A filesystem that accepts everything and records what it was asked to do. These tests
 * are about the entrypoint's control flow, not about what lands on disk, so the writes
 * only need to be counted — but counting them proves a rejected request performed none.
 */
class NullFs implements FilesystemPort {
  readonly writes: string[] = [];

  exists(): boolean {
    return true;
  }
  readText(): string {
    return '';
  }
  writeAtomic(path: string): void {
    this.writes.push(path);
  }
  writeSecret(path: string): void {
    this.writes.push(path);
  }
  shred(path: string): void {
    this.writes.push(path);
  }
  mkdirp(path: string): void {
    this.writes.push(path);
  }
  copy(_source: string, destination: string): void {
    this.writes.push(destination);
  }
  remove(path: string): void {
    this.writes.push(path);
  }
  sha256(): string {
    return '0'.repeat(64);
  }
  isDirectory(): boolean {
    return true;
  }
}

interface Setup {
  readonly io: HelperIo;
  readonly sink: MemoryAuditSink;
  readonly deps: HandlerDeps;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly calls: string[][];
}

function setup(options: {
  request?: unknown;
  stdin?: string;
  uid?: number;
  argv?: string[];
  env?: Record<string, string | undefined>;
  runFails?: boolean;
}): Setup {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: string[][] = [];
  const sink = new MemoryAuditSink();

  const stdin =
    options.stdin ?? (options.request === undefined ? '' : JSON.stringify(options.request));

  const io: HelperIo = {
    argv: options.argv ?? [],
    readStdin: () => stdin,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    getuid: () => options.uid ?? 0,
    getgid: () => 0,
    env: options.env ?? {},
    now: () => 1_700_000_000_000,
  };

  const deps: HandlerDeps = {
    resolve: (name) => `/usr/bin/${name}`,
    fs: new NullFs(),
    randomToken: () => 'token',
    run: (argv) => {
      calls.push([...argv]);
      const result: CommandResult = {
        argv,
        status: options.runFails === true ? 1 : 0,
        stdout: 'GENERAL.CONNECTION:Wired connection 1\n',
        stderr: options.runFails === true ? 'device is busy' : '',
        timedOut: false,
      };
      if (options.runFails === true) {
        throw new CommandError(result, 'umount exited with status 1: device is busy');
      }
      return result;
    },
  };

  return { io, sink, deps, stdout, stderr, calls };
}

function response(stdout: string[]): HelperResponse {
  return JSON.parse(stdout.join('').trim()) as HelperResponse;
}

const RELOAD = { verb: 'reload-samba', mode: 'reload' };

// ---------------------------------------------------------------------------

describe('the root assertion', () => {
  /**
   * A helper that runs unprivileged would not fail loudly — it would produce broken
   * mounts and half-written configs that look like ordinary operational failures,
   * teaching operators to ignore exactly the errors that mean the privilege boundary is
   * misinstalled.
   */
  it.each([1000, 1, 65_534, -1])('refuses to run as uid %p', (uid) => {
    const s = setup({ request: RELOAD, uid });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_USAGE);
    expect(s.calls).toHaveLength(0);
    expect(response(s.stdout).error).toMatch(/must run as root/);
  });

  it('names the effective uid so the misconfiguration is diagnosable', () => {
    const s = setup({ request: RELOAD, uid: 1000 });
    runHelper(s.io, s.deps, s.sink);
    expect(response(s.stdout).error).toMatch(/effective uid is 1000/);
  });

  it('audits the refusal — a probe of the boundary is a security event', () => {
    const s = setup({ request: RELOAD, uid: 1000 });
    runHelper(s.io, s.deps, s.sink);
    expect(s.sink.records).toHaveLength(1);
    expect(s.sink.records[0]).toMatchObject({ outcome: 'denied', uid: 1000 });
  });

  it('proceeds as uid 0', () => {
    const s = setup({ request: RELOAD, uid: 0 });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_OK);
  });
});

describe('argument handling', () => {
  /** The sudoers rule permits the binary with no arguments; this mirrors that. */
  it('refuses any argument', () => {
    const s = setup({ request: RELOAD, argv: ['mount-share', '--share', 'werkstatt'] });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_USAGE);
    expect(response(s.stdout).error).toMatch(/takes no arguments/);
  });

  it('prints usage for --help without needing stdin', () => {
    const s = setup({ argv: ['--help'] });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_OK);
    expect(s.stdout.join('')).toMatch(/reads one JSON request on stdin/i);
  });

  it('lists the fourteen verbs for --list-verbs', () => {
    const s = setup({ argv: ['--list-verbs'] });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_OK);
    expect(s.stdout.join('').trim().split('\n')).toHaveLength(14);
  });

  it('answers --help even when invoked unprivileged, so operators can read it', () => {
    const s = setup({ argv: ['-h'], uid: 1000 });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_OK);
  });
});

describe('stdin handling', () => {
  it('rejects empty stdin', () => {
    const s = setup({ stdin: '   \n' });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_USAGE);
    expect(response(s.stdout).error).toMatch(/no request received on stdin/);
  });

  it('rejects malformed JSON', () => {
    const s = setup({ stdin: '{ not json' });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_USAGE);
    expect(response(s.stdout).error).toMatch(/could not read a JSON request/);
  });

  it('rejects a JSON array', () => {
    const s = setup({ stdin: '["mount-share"]' });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_DENIED);
  });
});

describe('validation failures', () => {
  it.each([
    ['an unknown verb', { verb: 'exec-shell', command: 'id' }],
    ['a hostile share name', { verb: 'unmount-share', shareName: '../../etc' }],
    ['a command-substitution share name', { verb: 'unmount-share', shareName: '$(id)' }],
    ['a disallowed service', { verb: 'service-restart', service: 'sshd' }],
    ['a traversing version', { verb: 'apply-update', version: '../../root' }],
  ])('rejects %s with the denied exit code', (_label, request) => {
    const s = setup({ request });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_DENIED);
    expect(s.calls).toHaveLength(0);
    expect(response(s.stdout).code).toBe('denied');
  });

  it('audits a rejected request as denied', () => {
    const s = setup({ request: { verb: 'service-restart', service: 'sshd' } });
    runHelper(s.io, s.deps, s.sink);
    expect(s.sink.records[0]).toMatchObject({ outcome: 'denied', verb: 'service-restart' });
  });

  it('writes the reason to stderr as well as the JSON response', () => {
    const s = setup({ request: { verb: 'service-restart', service: 'sshd' } });
    runHelper(s.io, s.deps, s.sink);
    expect(s.stderr.join('')).toMatch(/is not an allowed unit/);
  });
});

describe('successful dispatch', () => {
  it('returns a JSON success envelope', () => {
    const s = setup({ request: RELOAD });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_OK);
    expect(response(s.stdout)).toMatchObject({ ok: true, verb: 'reload-samba' });
  });

  it('audits the call with its commands', () => {
    const s = setup({ request: RELOAD });
    runHelper(s.io, s.deps, s.sink);
    expect(s.sink.records[0]).toMatchObject({
      outcome: 'ok',
      verb: 'reload-samba',
      commands: [['/usr/bin/smbcontrol', 'all', 'reload-config']],
    });
  });

  it('records the invoking account from SUDO_USER', () => {
    const s = setup({ request: RELOAD, env: { SUDO_USER: 'tncbridge' } });
    runHelper(s.io, s.deps, s.sink);
    expect(s.sink.records[0]).toMatchObject({ invoker: 'tncbridge' });
  });

  /** The whole point of the audit trail is that secrets do not land in it. */
  it('never writes a password to the audit log', () => {
    const s = setup({
      request: {
        verb: 'mount-share',
        shareName: 'werkstatt',
        serverUnc: '//server/CNC',
        smbVersion: '3.1.1',
        seal: true,
        domain: 'EXAMPLE',
        username: 'svc-tnc',
        password: 'hunter2-do-not-log-me',
        uid: 1000,
        gid: 1000,
      },
    });
    runHelper(s.io, s.deps, s.sink);
    const serialised = JSON.stringify(s.sink.records);
    expect(serialised).not.toContain('hunter2-do-not-log-me');
    expect(serialised).toContain('[redacted]');
    expect(s.sink.records[0]).toMatchObject({ outcome: 'ok', verb: 'mount-share' });
  });
});

describe('execution failures', () => {
  it('reports a failed command distinctly from a rejected request', () => {
    const s = setup({ request: { verb: 'unmount-share', shareName: 'werkstatt' }, runFails: true });
    expect(runHelper(s.io, s.deps, s.sink)).toBe(EXIT_FAILED);
    const parsed = response(s.stdout);
    expect(parsed.code).toBe('failed');
    expect(parsed.error).toMatch(/device is busy/);
  });

  it('audits a failed operation as failed, not denied', () => {
    const s = setup({ request: { verb: 'unmount-share', shareName: 'werkstatt' }, runFails: true });
    runHelper(s.io, s.deps, s.sink);
    expect(s.sink.records[0]).toMatchObject({ outcome: 'failed', verb: 'unmount-share' });
  });

  it('wraps an unexpected error rather than leaking a stack trace', () => {
    const s = setup({ request: RELOAD });
    const deps: HandlerDeps = {
      ...s.deps,
      run: () => {
        throw new TypeError('something internal broke');
      },
    };
    expect(runHelper(s.io, deps, s.sink)).toBe(EXIT_FAILED);
    expect(response(s.stdout).error).toMatch(/unexpected failure: something internal broke/);
  });
});

describe('exit codes are distinguishable', () => {
  it('uses four distinct codes so callers can tell probes from outages', () => {
    expect(new Set([EXIT_OK, EXIT_USAGE, EXIT_DENIED, EXIT_FAILED]).size).toBe(4);
  });
});
