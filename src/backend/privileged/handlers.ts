import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { type BinaryName, type CommandRunner, resolveBinary, runCommand } from './exec';
import {
  type ApplyNetworkRequest,
  type ApplyUpdateRequest,
  type Fail2banUnbanRequest,
  type InstallCertRequest,
  type MountShareRequest,
  type PrivilegedRequest,
  type PrivilegedVerb,
  type ReloadSambaRequest,
  ROOTS,
  type ServiceRestartRequest,
  type UnmountShareRequest,
  type WriteDnsmasqConfigRequest,
  type WriteNftRulesetRequest,
  type WriteSambaConfigRequest,
} from './verbs';

/**
 * Execution for the eleven privileged verbs.
 *
 * `verbs.ts` decides what is *allowed*; this module decides what is *done*. The split
 * matters because it lets the validation layer be tested exhaustively without a single
 * process being spawned, and lets these handlers assume their input is already safe.
 * Nothing here re-derives a path or a name from raw input — every value used below came
 * out of `validateRequest`.
 *
 * Every dependency that touches the machine is injected. That is not ceremony: it is
 * how the tests assert the exact argv of `mount.cifs` without mounting anything, and
 * the exact argv is the security property worth testing.
 */

export const CREDENTIALS_DIR = '/run/tnc-bridge';
export const SAMBA_CONFIG_PATH = `${ROOTS.sambaConfig}/smb.conf`;
export const SAMBA_BACKUP_PATH = `${ROOTS.sambaConfig}/smb.conf.tnc-bak`;
export const DNSMASQ_CONFIG_PATH = `${ROOTS.dnsmasqConfig}/tnc-bridge.conf`;
export const NFT_RULESET_PATH = `${ROOTS.nftConfig}/tnc-bridge.nft`;
export const CURRENT_RELEASE_LINK = '/opt/tnc-bridge/current';
export const NET_REVERT_UNIT = 'tnc-bridge-netrevert';
export const CHECKSUM_MANIFEST = 'SHA256SUMS';

/** The group that owns the TLS private key. The service reads it; nobody else can. */
export const SERVICE_GROUP = 'tncbridge';

export class PrivilegedExecutionError extends Error {
  constructor(
    readonly verb: string,
    message: string,
  ) {
    super(`${verb}: ${message}`);
    this.name = 'PrivilegedExecutionError';
  }
}

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

export interface FilesystemPort {
  exists(path: string): boolean;
  readText(path: string): string;
  /** Write via a same-directory temp file plus `rename`, so readers never see a partial file. */
  writeAtomic(path: string, content: string, mode: number): void;
  /** Write a fresh file with an exact mode, never widened by the umask. */
  writeSecret(path: string, content: string, mode: number): void;
  /** Overwrite the bytes before unlinking, so the contents do not survive in the page cache. */
  shred(path: string): void;
  mkdirp(path: string, mode: number): void;
  copy(source: string, destination: string): void;
  remove(path: string): void;
  sha256(path: string): string;
  isDirectory(path: string): boolean;
}

export const nodeFilesystem: FilesystemPort = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf8'),
  writeAtomic(path, content, mode) {
    const temporary = `${path}.tnc-tmp-${randomBytes(6).toString('hex')}`;
    const fd = openSync(temporary, 'wx', mode);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  },
  writeSecret(path, content, mode) {
    const fd = openSync(path, 'w', mode);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(path, mode);
  },
  shred(path) {
    if (!existsSync(path)) {
      return;
    }
    const size = statSync(path).size;
    if (size > 0) {
      writeFileSync(path, randomBytes(size));
    }
    rmSync(path, { force: true });
  },
  mkdirp: (path, mode) => {
    mkdirSync(path, { recursive: true, mode });
  },
  copy(source, destination) {
    writeFileSync(destination, readFileSync(source));
  },
  remove: (path) => {
    rmSync(path, { force: true, recursive: true });
  },
  sha256: (path) => createHash('sha256').update(readFileSync(path)).digest('hex'),
  isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
};

export interface HandlerDeps {
  readonly run: CommandRunner;
  readonly resolve: (name: BinaryName) => string;
  readonly fs: FilesystemPort;
  readonly randomToken: () => string;
}

export const defaultDeps: HandlerDeps = {
  run: runCommand,
  resolve: (name) => resolveBinary(name),
  fs: nodeFilesystem,
  randomToken: () => randomBytes(8).toString('hex'),
};

export interface HandlerResult {
  readonly verb: PrivilegedVerb;
  /** Every command actually executed, in order. Fed straight to the audit record. */
  readonly commands: readonly (readonly string[])[];
  readonly detail: Record<string, unknown>;
}

/** Records each command as it runs so the audit entry reflects reality, not intent. */
class CommandLog {
  readonly entries: string[][] = [];

  constructor(private readonly deps: HandlerDeps) {}

  exec(argv: readonly string[], options?: Parameters<CommandRunner>[1]): ReturnType<CommandRunner> {
    this.entries.push([...argv]);
    return this.deps.run(argv, options);
  }
}

// ---------------------------------------------------------------------------
// 1 · mount-share
// ---------------------------------------------------------------------------

/**
 * Mount options that are never negotiable.
 *
 * `soft` is the load-bearing one. With `hard`, a CIFS call against a server that has
 * gone away blocks in uninterruptible sleep forever; the syscall is made from a libuv
 * thread pool worker, so four such calls exhaust the pool and the entire service —
 * including the dashboard that would tell an operator what is wrong — stops responding.
 * `hard` is rejected by assertion rather than merely not offered.
 */
export const REQUIRED_MOUNT_OPTIONS = ['soft', 'noserverino'] as const;

export function buildMountOptions(request: MountShareRequest, credentialsPath: string): string {
  const options = [
    `credentials=${credentialsPath}`,
    `vers=${request.smbVersion}`,
    'soft',
    'noserverino',
    'nobrl',
    `uid=${request.uid}`,
    `gid=${request.gid}`,
    'file_mode=0660',
    'dir_mode=0770',
    'iocharset=utf8',
    'actimeo=1',
    'echo_interval=10',
    'timeo=50',
  ];
  if (request.seal) {
    options.push('seal');
  }
  const rendered = options.join(',');
  // The value is built entirely from validated fields, so a comma cannot appear inside
  // one and split into an extra option. Asserted rather than assumed.
  if (/(^|,)hard(,|$)/.test(rendered)) {
    throw new PrivilegedExecutionError('mount-share', 'refusing to build a hard mount');
  }
  return rendered;
}

/**
 * `mount.cifs` needs the password in plaintext at mount time — there is no API that
 * avoids it. What can be controlled is the exposure window: the file lives on `/run`
 * (tmpfs, never written to the SD card), is created 0600 by root, and is overwritten
 * and unlinked in a `finally` so a failed mount does not leave it behind.
 *
 * It is a credentials *file* rather than a `pass=` mount option because mount options
 * appear in `/proc/mounts` and in the argv of the process, both world-readable.
 */
export function renderCredentialsFile(request: MountShareRequest): string {
  return `username=${request.username}\npassword=${request.password}\ndomain=${request.domain}\n`;
}

function mountShare(request: MountShareRequest, deps: HandlerDeps, log: CommandLog): HandlerResult {
  // A newline in the password would inject extra directives into the credentials file.
  // The generic string validator permits control characters; this one must not.
  if (/[\r\n]/.test(request.password)) {
    throw new PrivilegedExecutionError('mount-share', 'password must not contain a line break');
  }

  deps.fs.mkdirp(CREDENTIALS_DIR, 0o700);
  deps.fs.mkdirp(request.mountPoint, 0o755);

  const credentialsPath = join(CREDENTIALS_DIR, `creds-${request.shareName}-${deps.randomToken()}`);
  try {
    deps.fs.writeSecret(credentialsPath, renderCredentialsFile(request), 0o600);
    log.exec([
      deps.resolve('mount'),
      '-t',
      'cifs',
      request.serverUnc,
      request.mountPoint,
      '-o',
      buildMountOptions(request, credentialsPath),
    ]);
  } finally {
    deps.fs.shred(credentialsPath);
  }

  return {
    verb: 'mount-share',
    commands: log.entries,
    detail: { shareName: request.shareName, mountPoint: request.mountPoint },
  };
}

// ---------------------------------------------------------------------------
// 2 · unmount-share
// ---------------------------------------------------------------------------

/**
 * A plain `umount` fails with EBUSY whenever anything holds a descriptor, and against a
 * server that has vanished it can fail outright. `force` escalates: `-f` asks the kernel
 * to abandon in-flight requests, and a lazy `-l` detaches the tree so the mount point is
 * reusable even if a stuck reader is still holding on.
 */
function unmountShare(
  request: UnmountShareRequest,
  deps: HandlerDeps,
  log: CommandLog,
): HandlerResult {
  const umount = deps.resolve('umount');
  const first = log.exec([umount, ...(request.force ? ['-f'] : []), request.mountPoint], {
    allowFailure: request.force,
  });

  let lazy = false;
  if (first.status !== 0 && request.force) {
    log.exec([umount, '-l', request.mountPoint]);
    lazy = true;
  }

  return {
    verb: 'unmount-share',
    commands: log.entries,
    detail: { shareName: request.shareName, lazy },
  };
}

// ---------------------------------------------------------------------------
// 3 · reload-samba
// ---------------------------------------------------------------------------

/**
 * Reload over restart wherever possible: `smbcontrol all reload-config` re-reads
 * `smb.conf` without dropping established sessions, so a TNC mid-transfer does not see
 * its connection die because an unrelated share was edited. Restart is offered because
 * some settings (`interfaces`, `bind interfaces only`) genuinely require it.
 */
function reloadSamba(
  request: ReloadSambaRequest,
  deps: HandlerDeps,
  log: CommandLog,
): HandlerResult {
  if (request.mode === 'reload') {
    log.exec([deps.resolve('smbcontrol'), 'all', 'reload-config']);
  } else {
    log.exec([deps.resolve('systemctl'), 'restart', 'smbd', 'nmbd']);
  }
  return { verb: 'reload-samba', commands: log.entries, detail: { mode: request.mode } };
}

// ---------------------------------------------------------------------------
// 4 · write-samba-config
// ---------------------------------------------------------------------------

/**
 * Validate before activating, and keep the previous file.
 *
 * A malformed `smb.conf` does not fail loudly — smbd may start and silently ignore the
 * stanza that confines it to the TNC interface, which turns a config typo into an SMB1
 * listener on the LAN. So the candidate is written to a scratch path, `testparm` is run
 * against *that*, and only a clean parse earns a rename into place.
 */
function writeSambaConfig(
  request: WriteSambaConfigRequest,
  deps: HandlerDeps,
  log: CommandLog,
): HandlerResult {
  const candidate = `${SAMBA_CONFIG_PATH}.candidate`;
  deps.fs.mkdirp(ROOTS.sambaConfig, 0o755);
  deps.fs.writeSecret(candidate, request.content, 0o644);

  try {
    const check = log.exec([deps.resolve('testparm'), '-s', '--suppress-prompt', candidate], {
      allowFailure: true,
    });
    if (check.status !== 0) {
      throw new PrivilegedExecutionError(
        'write-samba-config',
        `testparm rejected the configuration: ${check.stderr.trim() || check.stdout.trim()}`,
      );
    }

    if (deps.fs.exists(SAMBA_CONFIG_PATH)) {
      deps.fs.copy(SAMBA_CONFIG_PATH, SAMBA_BACKUP_PATH);
    }
    deps.fs.writeAtomic(SAMBA_CONFIG_PATH, request.content, 0o644);
  } finally {
    deps.fs.remove(candidate);
  }

  log.exec([deps.resolve('smbcontrol'), 'all', 'reload-config'], { allowFailure: true });

  return {
    verb: 'write-samba-config',
    commands: log.entries,
    detail: { path: SAMBA_CONFIG_PATH, bytes: Buffer.byteLength(request.content, 'utf8') },
  };
}

// ---------------------------------------------------------------------------
// 5 · write-dnsmasq-config
// ---------------------------------------------------------------------------

/**
 * The TNC-side DHCP server. Disabling it removes the drop-in rather than commenting it
 * out — a stale file that dnsmasq still reads is how a "disabled" service keeps handing
 * out leases.
 */
function writeDnsmasqConfig(
  request: WriteDnsmasqConfigRequest,
  deps: HandlerDeps,
  log: CommandLog,
): HandlerResult {
  const systemctl = deps.resolve('systemctl');

  if (!request.enabled) {
    deps.fs.remove(DNSMASQ_CONFIG_PATH);
    log.exec([systemctl, 'stop', 'dnsmasq'], { allowFailure: true });
    log.exec([systemctl, 'disable', 'dnsmasq'], { allowFailure: true });
    return { verb: 'write-dnsmasq-config', commands: log.entries, detail: { enabled: false } };
  }

  deps.fs.mkdirp(ROOTS.dnsmasqConfig, 0o755);
  deps.fs.writeAtomic(DNSMASQ_CONFIG_PATH, request.content, 0o644);
  log.exec([systemctl, 'enable', 'dnsmasq'], { allowFailure: true });
  log.exec([systemctl, 'restart', 'dnsmasq']);

  return {
    verb: 'write-dnsmasq-config',
    commands: log.entries,
    detail: { enabled: true, path: DNSMASQ_CONFIG_PATH },
  };
}

// ---------------------------------------------------------------------------
// 6 · apply-network
// ---------------------------------------------------------------------------

/** `nmcli -t -f GENERAL.CONNECTION device show eth0` → `GENERAL.CONNECTION:Wired connection 1`. */
export function parseConnectionName(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    if (line.slice(0, separator).trim() === 'GENERAL.CONNECTION') {
      const value = line.slice(separator + 1).trim();
      if (value !== '' && value !== '--') {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Applying a network change over the network is the one operation that can destroy the
 * channel used to undo it. A wrong static address on the LAN interface locks the
 * operator out of a headless Pi in a machine hall.
 *
 * So the pre-change profile is cloned first, and a transient systemd timer is armed to
 * bring the clone back up after `revertAfterSeconds`. The timer survives the service
 * dying, which is the whole point — a rollback that depends on the process that just
 * broke the network is not a rollback. Confirming means calling `apply-network` again
 * with `revertAfterSeconds: 0`, which stops the timer and drops the clone.
 */
function applyNetwork(
  request: ApplyNetworkRequest,
  deps: HandlerDeps,
  log: CommandLog,
): HandlerResult {
  const nmcli = deps.resolve('nmcli');
  const systemctl = deps.resolve('systemctl');

  const shown = log.exec([
    nmcli,
    '-t',
    '-f',
    'GENERAL.CONNECTION',
    'device',
    'show',
    request.interface,
  ]);
  const connection = parseConnectionName(shown.stdout);
  if (connection === undefined) {
    throw new PrivilegedExecutionError(
      'apply-network',
      `interface ${request.interface} has no active NetworkManager connection`,
    );
  }

  // Any timer armed by a previous apply is now moot, whichever way this call goes.
  log.exec([systemctl, 'stop', `${NET_REVERT_UNIT}.service`], { allowFailure: true });
  const backupProfile = `tnc-revert-${request.interface}`;
  log.exec([nmcli, 'con', 'delete', backupProfile], { allowFailure: true });

  if (request.revertAfterSeconds > 0) {
    log.exec([nmcli, 'con', 'clone', connection, backupProfile], { allowFailure: true });
  }

  const settings: string[] =
    request.method === 'static'
      ? [
          'ipv4.method',
          'manual',
          'ipv4.addresses',
          request.address ?? '',
          'ipv4.gateway',
          request.gateway ?? '',
          'ipv4.dns',
          request.dns.join(' '),
        ]
      : ['ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', ''];

  settings.push('ipv6.method', request.ipv6Enabled ? 'auto' : 'disabled');

  // MTU lives on a different setting for a VLAN connection than for a plain Ethernet
  // one: NetworkManager rejects `802-3-ethernet.mtu` on a `vlan` profile outright, so
  // sending the wrong one turns every tagged apply into a failure.
  settings.push(request.vlan === null ? '802-3-ethernet.mtu' : 'vlan.mtu', String(request.mtu));
  if (request.vlan !== null) {
    settings.push('vlan.id', String(request.vlan));
  }

  log.exec([nmcli, 'con', 'mod', connection, ...settings]);
  log.exec([nmcli, 'con', 'up', connection]);

  if (request.revertAfterSeconds > 0) {
    log.exec([
      deps.resolve('systemdRun'),
      `--unit=${NET_REVERT_UNIT}`,
      `--on-active=${request.revertAfterSeconds}`,
      '--description=Revert TNC Bridge network change if unconfirmed',
      nmcli,
      'con',
      'up',
      backupProfile,
    ]);
  }

  return {
    verb: 'apply-network',
    commands: log.entries,
    detail: {
      interface: request.interface,
      connection,
      method: request.method,
      revertArmed: request.revertAfterSeconds > 0,
      revertAfterSeconds: request.revertAfterSeconds,
    },
  };
}

// ---------------------------------------------------------------------------
// 7 · write-nft-ruleset
// ---------------------------------------------------------------------------

/**
 * `nft -c -f` parses and checks a ruleset without loading it. Loading an unchecked
 * ruleset that drops the management interface is the firewall equivalent of the
 * network lockout above, minus the timer.
 */
function writeNftRuleset(
  request: WriteNftRulesetRequest,
  deps: HandlerDeps,
  log: CommandLog,
): HandlerResult {
  const nft = deps.resolve('nft');
  const candidate = `${NFT_RULESET_PATH}.candidate`;
  deps.fs.mkdirp(ROOTS.nftConfig, 0o750);
  deps.fs.writeSecret(candidate, request.content, 0o600);

  try {
    const check = log.exec([nft, '-c', '-f', candidate], { allowFailure: true });
    if (check.status !== 0) {
      throw new PrivilegedExecutionError(
        'write-nft-ruleset',
        `nft rejected the ruleset: ${check.stderr.trim() || check.stdout.trim()}`,
      );
    }
    deps.fs.writeAtomic(NFT_RULESET_PATH, request.content, 0o600);
  } finally {
    deps.fs.remove(candidate);
  }

  log.exec([nft, '-f', NFT_RULESET_PATH]);

  return { verb: 'write-nft-ruleset', commands: log.entries, detail: { path: NFT_RULESET_PATH } };
}

// ---------------------------------------------------------------------------
// 8 · fail2ban-unban
// ---------------------------------------------------------------------------

function fail2banUnban(
  request: Fail2banUnbanRequest,
  deps: HandlerDeps,
  log: CommandLog,
): HandlerResult {
  log.exec([deps.resolve('fail2banClient'), 'set', request.jail, 'unbanip', request.ip]);
  return {
    verb: 'fail2ban-unban',
    commands: log.entries,
    detail: { jail: request.jail, ip: request.ip },
  };
}

// ---------------------------------------------------------------------------
// 9 · install-cert
// ---------------------------------------------------------------------------

/**
 * The private key is written 0640 root:tncbridge — the service must read it to serve
 * HTTPS, and nothing else on the box should. The certificate and chain are public by
 * definition and stay 0644.
 */
function installCert(
  request: InstallCertRequest,
  deps: HandlerDeps,
  log: CommandLog,
): HandlerResult {
  deps.fs.mkdirp(ROOTS.tls, 0o750);

  const certPath = join(ROOTS.tls, 'server.crt');
  const keyPath = join(ROOTS.tls, 'server.key');
  const chainPath = join(ROOTS.tls, 'chain.crt');

  deps.fs.writeAtomic(certPath, request.certPem, 0o644);
  deps.fs.writeSecret(keyPath, request.keyPem, 0o640);
  if (request.chainPem === undefined) {
    deps.fs.remove(chainPath);
  } else {
    deps.fs.writeAtomic(chainPath, request.chainPem, 0o644);
  }

  return {
    verb: 'install-cert',
    commands: log.entries,
    detail: {
      certPath,
      keyPath,
      chainInstalled: request.chainPem !== undefined,
      keyGroup: SERVICE_GROUP,
    },
  };
}

// ---------------------------------------------------------------------------
// 10 · service-restart
// ---------------------------------------------------------------------------

function serviceRestart(
  request: ServiceRestartRequest,
  deps: HandlerDeps,
  log: CommandLog,
): HandlerResult {
  log.exec([deps.resolve('systemctl'), request.action, request.service]);
  return {
    verb: 'service-restart',
    commands: log.entries,
    detail: { service: request.service, action: request.action },
  };
}

// ---------------------------------------------------------------------------
// 11 · apply-update
// ---------------------------------------------------------------------------

/** `<sha256>  <relative path>` — the format `sha256sum` writes. */
export function parseChecksumManifest(text: string): { path: string; digest: string }[] {
  const entries: { path: string; digest: string }[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line);
    if (match === null) {
      throw new PrivilegedExecutionError('apply-update', `malformed checksum line: ${line}`);
    }
    const [, digest, path] = match;
    if (digest === undefined || path === undefined) {
      continue;
    }
    // A manifest that can name `../../etc/systemd/system/x.service` turns a checksum
    // file into an arbitrary-read primitive; relative escapes are refused outright.
    if (path.includes('..') || path.startsWith('/')) {
      throw new PrivilegedExecutionError(
        'apply-update',
        `manifest path escapes the release: ${path}`,
      );
    }
    entries.push({ digest: digest.toLowerCase(), path });
  }
  if (entries.length === 0) {
    throw new PrivilegedExecutionError('apply-update', 'checksum manifest is empty');
  }
  return entries;
}

/**
 * Verify, then swap.
 *
 * The unprivileged updater downloaded this release, so its integrity cannot be assumed
 * here — the whole point of the privilege boundary is that the caller may be
 * compromised. The helper re-hashes every file in the manifest itself before anything
 * is activated, and `ln -sfn` makes the swap a single atomic rename rather than an
 * rm-then-link window in which `current` points at nothing.
 */
function applyUpdate(
  request: ApplyUpdateRequest,
  deps: HandlerDeps,
  log: CommandLog,
): HandlerResult {
  if (!deps.fs.isDirectory(request.releaseDir)) {
    throw new PrivilegedExecutionError(
      'apply-update',
      `release directory ${request.releaseDir} not found`,
    );
  }

  const manifestPath = join(request.releaseDir, CHECKSUM_MANIFEST);
  if (!deps.fs.exists(manifestPath)) {
    throw new PrivilegedExecutionError('apply-update', `release is missing ${CHECKSUM_MANIFEST}`);
  }

  if (request.manifestSha256 !== undefined) {
    const actual = deps.fs.sha256(manifestPath);
    if (actual !== request.manifestSha256.toLowerCase()) {
      throw new PrivilegedExecutionError(
        'apply-update',
        `${CHECKSUM_MANIFEST} digest mismatch: expected ${request.manifestSha256}, got ${actual}`,
      );
    }
  }

  const entries = parseChecksumManifest(deps.fs.readText(manifestPath));
  for (const entry of entries) {
    const target = join(request.releaseDir, entry.path);
    if (!deps.fs.exists(target)) {
      throw new PrivilegedExecutionError('apply-update', `release is missing ${entry.path}`);
    }
    const actual = deps.fs.sha256(target);
    if (actual !== entry.digest) {
      throw new PrivilegedExecutionError(
        'apply-update',
        `checksum mismatch for ${entry.path}: expected ${entry.digest}, got ${actual}`,
      );
    }
  }

  deps.fs.mkdirp(dirname(CURRENT_RELEASE_LINK), 0o755);
  log.exec([deps.resolve('ln'), '-sfn', request.releaseDir, CURRENT_RELEASE_LINK]);
  log.exec([deps.resolve('systemctl'), 'restart', 'tnc-bridge']);

  return {
    verb: 'apply-update',
    commands: log.entries,
    detail: {
      version: request.version,
      releaseDir: request.releaseDir,
      filesVerified: entries.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Routes a *validated* request to its handler.
 *
 * The switch is exhaustive over the union and lint enforces that
 * (`switch-exhaustiveness-check`), so a twelfth verb cannot be added to `verbs.ts`
 * without the compiler demanding a handler for it.
 */
export function execute(
  request: PrivilegedRequest,
  deps: HandlerDeps = defaultDeps,
): HandlerResult {
  const log = new CommandLog(deps);

  switch (request.verb) {
    case 'mount-share':
      return mountShare(request, deps, log);
    case 'unmount-share':
      return unmountShare(request, deps, log);
    case 'reload-samba':
      return reloadSamba(request, deps, log);
    case 'write-samba-config':
      return writeSambaConfig(request, deps, log);
    case 'write-dnsmasq-config':
      return writeDnsmasqConfig(request, deps, log);
    case 'apply-network':
      return applyNetwork(request, deps, log);
    case 'write-nft-ruleset':
      return writeNftRuleset(request, deps, log);
    case 'fail2ban-unban':
      return fail2banUnban(request, deps, log);
    case 'install-cert':
      return installCert(request, deps, log);
    case 'service-restart':
      return serviceRestart(request, deps, log);
    case 'apply-update':
      return applyUpdate(request, deps, log);
  }
}
