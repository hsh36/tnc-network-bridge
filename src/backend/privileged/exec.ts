import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Command execution for the privileged helper.
 *
 * Every call goes through `spawnSync` with an argv array and `shell: false`. There is
 * no command string anywhere in this module, so there is nothing for a shell to
 * interpret — a share name containing `; rm -rf /` would be passed to `mount` as one
 * literal argument and rejected by `mount`, not executed.
 *
 * The binary is resolved from a fixed table of absolute paths rather than from `PATH`.
 * A root process that trusts `PATH` can be redirected by anything that can set the
 * environment, which is exactly the escalation privilege separation exists to prevent.
 */

export interface CommandResult {
  readonly argv: readonly string[];
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type CommandRunner = (argv: readonly string[], options?: RunOptions) => CommandResult;

export interface RunOptions {
  readonly input?: string;
  readonly timeoutMs?: number;
  /** Non-zero exit is returned rather than thrown when true. */
  readonly allowFailure?: boolean;
}

export class CommandError extends Error {
  constructor(
    readonly result: CommandResult,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * Logical name → candidate absolute paths.
 *
 * Distributions disagree about `/bin` versus `/usr/bin`, and Raspberry Pi OS has moved
 * over time, so each tool lists the places it legitimately lives. Nothing outside this
 * table can be executed.
 */
export const BINARIES = {
  mount: ['/usr/bin/mount', '/bin/mount'],
  umount: ['/usr/bin/umount', '/bin/umount'],
  systemctl: ['/usr/bin/systemctl', '/bin/systemctl'],
  smbcontrol: ['/usr/bin/smbcontrol'],
  testparm: ['/usr/bin/testparm'],
  smbpasswd: ['/usr/bin/smbpasswd'],
  useradd: ['/usr/sbin/useradd', '/sbin/useradd'],
  userdel: ['/usr/sbin/userdel', '/sbin/userdel'],
  nft: ['/usr/sbin/nft', '/sbin/nft'],
  nmcli: ['/usr/bin/nmcli'],
  fail2banClient: ['/usr/bin/fail2ban-client'],
  sysctl: ['/usr/sbin/sysctl', '/sbin/sysctl'],
  ln: ['/usr/bin/ln', '/bin/ln'],
  systemdRun: ['/usr/bin/systemd-run', '/bin/systemd-run'],
  hostnamectl: ['/usr/bin/hostnamectl', '/bin/hostnamectl'],
} as const;

export type BinaryName = keyof typeof BINARIES;

export class BinaryNotFoundError extends Error {
  constructor(name: string) {
    super(`Required binary "${name}" was not found in any of its expected locations`);
    this.name = 'BinaryNotFoundError';
  }
}

export function resolveBinary(
  name: BinaryName,
  exists: (p: string) => boolean = existsSync,
): string {
  for (const candidate of BINARIES[name]) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  throw new BinaryNotFoundError(name);
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A deliberately minimal environment.
 *
 * `PATH` is fixed and `IFS` is reset, so nothing inherited from the calling process
 * can influence how a child resolves or splits anything. `LC_ALL=C` keeps tool output
 * parseable — a localised `mount` error message would silently break error
 * classification on a German-configured host.
 */
export const SAFE_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  IFS: ' \t\n',
  LC_ALL: 'C',
  LANG: 'C',
});

export const runCommand: CommandRunner = (argv, options = {}) => {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new Error('runCommand requires at least a command');
  }
  if (!command.startsWith('/')) {
    // Belt and braces: resolveBinary already returns absolute paths.
    throw new Error(`Refusing to execute "${command}" — commands must be absolute paths`);
  }

  const spawned = spawnSync(command, args, {
    shell: false,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: { ...SAFE_ENV },
    maxBuffer: 8 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
  });

  const result: CommandResult = {
    argv,
    status: spawned.status ?? -1,
    stdout: spawned.stdout ?? '',
    stderr: spawned.stderr ?? '',
    timedOut:
      spawned.error !== undefined && 'code' in spawned.error && spawned.error.code === 'ETIMEDOUT',
  };

  if (result.status !== 0 && options.allowFailure !== true) {
    throw new CommandError(
      result,
      `${command} exited with status ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
};
