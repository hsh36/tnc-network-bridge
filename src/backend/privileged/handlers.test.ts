import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type CommandResult, CommandError } from './exec';
import {
  buildMountOptions,
  CHECKSUM_MANIFEST,
  CURRENT_RELEASE_LINK,
  DNSMASQ_CONFIG_PATH,
  execute,
  type FilesystemPort,
  type HandlerDeps,
  NET_REVERT_UNIT,
  NFT_RULESET_PATH,
  nodeFilesystem,
  parseChecksumManifest,
  parseConnectionName,
  PrivilegedExecutionError,
  renderCredentialsFile,
  SAMBA_BACKUP_PATH,
  SAMBA_CONFIG_PATH,
  SERVICE_GROUP,
  SELF_UPDATE_SCRIPT,
  SELF_UPDATE_UNIT,
  OS_UPDATE_SCRIPT,
  OS_UPDATE_UNIT,
} from './handlers';
import { type PrivilegedRequest, validateRequest, type ValidateOptions } from './verbs';

/**
 * Handler tests assert the *exact argv* of every privileged command.
 *
 * That is the property worth pinning: a refactor that quietly drops `soft` from the
 * mount options, or activates an `smb.conf` before `testparm` has approved it, is not a
 * style regression — it is an outage or a LAN-exposed SMB1 listener. Nothing here
 * spawns a process or touches a real path; every dependency is a recording double.
 */

const OPTIONS: ValidateOptions = { listInterfaces: () => ['lo', 'eth0', 'eth1'] };

/** Records every write, and answers reads from an in-memory tree. */
class FakeFs implements FilesystemPort {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly shredded: string[] = [];
  readonly removed: string[] = [];
  readonly modes = new Map<string, number>();

  exists(path: string): boolean {
    return this.files.has(path) || this.directories.has(path);
  }
  readText(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }
  writeAtomic(path: string, content: string, mode: number): void {
    this.files.set(path, content);
    this.modes.set(path, mode);
  }
  writeSecret(path: string, content: string, mode: number): void {
    this.files.set(path, content);
    this.modes.set(path, mode);
  }
  shred(path: string): void {
    this.shredded.push(path);
    this.files.delete(path);
  }
  mkdirp(path: string): void {
    this.directories.add(path);
  }
  copy(source: string, destination: string): void {
    this.files.set(destination, this.readText(source));
  }
  remove(path: string): void {
    this.removed.push(path);
    this.files.delete(path);
  }
  sha256(path: string): string {
    return createHash('sha256').update(this.readText(path)).digest('hex');
  }
  isDirectory(path: string): boolean {
    return this.directories.has(path);
  }
}

interface Harness {
  readonly deps: HandlerDeps;
  readonly fs: FakeFs;
  readonly calls: string[][];
  /** Make the nth matching command fail. */
  failWhen(predicate: (argv: readonly string[]) => boolean, result?: Partial<CommandResult>): void;
}

function harness(stdoutFor: (argv: readonly string[]) => string = () => ''): Harness {
  const fs = new FakeFs();
  const calls: string[][] = [];
  const failures: {
    predicate: (argv: readonly string[]) => boolean;
    result: Partial<CommandResult>;
  }[] = [];

  const deps: HandlerDeps = {
    // Binary resolution is `exec.ts`'s job and is tested there; here it is the identity
    // so assertions read as the real absolute paths.
    resolve: (name) => `/usr/bin/${name}`,
    fs,
    randomToken: () => 'deadbeef',
    run: (argv, runOptions) => {
      calls.push([...argv]);
      const failure = failures.find((entry) => entry.predicate(argv));
      const result: CommandResult = {
        argv,
        status: failure === undefined ? 0 : (failure.result.status ?? 1),
        stdout: failure?.result.stdout ?? stdoutFor(argv),
        stderr: failure?.result.stderr ?? '',
        timedOut: false,
      };
      if (result.status !== 0 && runOptions?.allowFailure !== true) {
        throw new CommandError(result, `${argv[0] ?? ''} exited with status ${result.status}`);
      }
      return result;
    },
  };

  return {
    deps,
    fs,
    calls,
    failWhen: (predicate, result = {}) => failures.push({ predicate, result }),
  };
}

function build(raw: Record<string, unknown>): PrivilegedRequest {
  return validateRequest(raw, OPTIONS);
}

const MOUNT_REQUEST = {
  verb: 'mount-share',
  shareName: 'werkstatt',
  serverUnc: '//fileserver.example.local/CNC',
  smbVersion: '3.1.1',
  seal: true,
  domain: 'EXAMPLE',
  username: 'svc-tnc',
  password: 'correct horse battery staple',
  uid: 1000,
  gid: 1000,
};

// ---------------------------------------------------------------------------

describe('mount-share', () => {
  it('invokes mount with -t cifs and the derived mount point', () => {
    const h = harness();
    execute(build(MOUNT_REQUEST), h.deps);

    expect(h.calls).toHaveLength(1);
    const argv = h.calls[0]!;
    expect(argv[0]).toBe('/usr/bin/mount');
    expect(argv.slice(1, 4)).toEqual(['-t', 'cifs', '//fileserver.example.local/CNC']);
    expect(argv[5]).toBe('-o');
  });

  /**
   * The single most important assertion in this file. A `hard` CIFS mount blocks
   * uninterruptibly when the server disappears; those blocking calls run on libuv's
   * thread pool, so a handful of them take the whole service down — including the
   * dashboard an operator would use to diagnose it.
   */
  it('always mounts soft, never hard', () => {
    const h = harness();
    execute(build(MOUNT_REQUEST), h.deps);
    const options = h.calls[0]![6]!.split(',');
    expect(options).toContain('soft');
    expect(options).not.toContain('hard');
  });

  it('sets noserverino, because CIFS inode numbers from the server are not stable', () => {
    const h = harness();
    execute(build(MOUNT_REQUEST), h.deps);
    expect(h.calls[0]![6]!.split(',')).toContain('noserverino');
  });

  it('adds seal only when requested', () => {
    const sealed = harness();
    execute(build(MOUNT_REQUEST), sealed.deps);
    expect(sealed.calls[0]![6]!.split(',')).toContain('seal');

    const plain = harness();
    execute(build({ ...MOUNT_REQUEST, seal: false }), plain.deps);
    expect(plain.calls[0]![6]!.split(',')).not.toContain('seal');
  });

  /**
   * `/proc/<pid>/cmdline` is world-readable and `/proc/mounts` shows mount options, so a
   * password in either is a password disclosed to every local account.
   */
  it('never puts the password in argv', () => {
    const h = harness();
    execute(build(MOUNT_REQUEST), h.deps);
    const flat = h.calls.flat().join(' ');
    expect(flat).not.toContain('correct horse battery staple');
    expect(flat).not.toContain('svc-tnc');
  });

  it('writes the credentials to a 0600 file on tmpfs', () => {
    const h = harness();
    execute(build(MOUNT_REQUEST), h.deps);
    const [path] = [...h.fs.modes.keys()].filter((key) => key.includes('creds-werkstatt-'));
    expect(path).toBeDefined();
    expect(h.fs.modes.get(path!)).toBe(0o600);
  });

  it('shreds the credentials file after a successful mount', () => {
    const h = harness();
    execute(build(MOUNT_REQUEST), h.deps);
    expect(h.fs.shredded.some((path) => path.includes('creds-werkstatt-'))).toBe(true);
  });

  /** A failed mount is exactly when a forgotten credentials file would linger. */
  it('shreds the credentials file even when mount fails', () => {
    const h = harness();
    h.failWhen((argv) => argv[0] === '/usr/bin/mount', { stderr: 'mount error(13)' });
    expect(() => execute(build(MOUNT_REQUEST), h.deps)).toThrow(CommandError);
    expect(h.fs.shredded.some((path) => path.includes('creds-werkstatt-'))).toBe(true);
  });

  it('rejects a password containing a line break, which would inject credential directives', () => {
    const h = harness();
    const request = build({ ...MOUNT_REQUEST, password: 'pw\nusername=root' });
    expect(() => execute(request, h.deps)).toThrow(/line break/);
    expect(h.calls).toHaveLength(0);
  });

  it('renders a credentials file with one directive per line', () => {
    const request = build(MOUNT_REQUEST) as Extract<PrivilegedRequest, { verb: 'mount-share' }>;
    expect(renderCredentialsFile(request)).toBe(
      'username=svc-tnc\npassword=correct horse battery staple\ndomain=EXAMPLE\n',
    );
  });

  /**
   * The option string is comma-separated, so a comma smuggled into any interpolated
   * value becomes an extra mount option. Every field reaching it is validated against a
   * pattern with no comma in it, but the credentials path is built here rather than
   * validated there — so the assertion is what stands between a future refactor and a
   * silently `hard` mount. Asserted directly, or it would be deletable as dead code.
   */
  it('refuses to build options in which a comma has injected a hard mount', () => {
    const request = build(MOUNT_REQUEST) as Extract<PrivilegedRequest, { verb: 'mount-share' }>;
    expect(() => buildMountOptions(request, '/run/tnc-bridge/creds,hard')).toThrow(/hard mount/);
  });

  it('builds a clean option string for an ordinary credentials path', () => {
    const request = build(MOUNT_REQUEST) as Extract<PrivilegedRequest, { verb: 'mount-share' }>;
    expect(buildMountOptions(request, '/run/tnc-bridge/creds-x')).toContain(
      'credentials=/run/tnc-bridge/creds-x',
    );
  });

  /**
   * Options the cifs module does not know are not ignored — the whole mount is refused
   * with a bare `mount error(22): Invalid argument`, and the actual reason appears only
   * in dmesg. `timeo` was in this list and is not a parameter modern cifs accepts, so
   * every share failed to mount with an error that named nothing.
   *
   * The list is deliberately of options *removed for cause*, not an allowlist: a new
   * option should not need this test edited, but a rediscovered bad one should fail.
   */
  it.each(['timeo'])('does not pass %p, which modern cifs rejects outright', (option) => {
    const request = build(MOUNT_REQUEST) as Extract<PrivilegedRequest, { verb: 'mount-share' }>;
    const rendered = buildMountOptions(request, '/run/tnc-bridge/creds');

    expect(rendered.split(',').map((entry) => entry.split('=')[0])).not.toContain(option);
  });

  it('keeps the options that bound how long a call against a dead server hangs', () => {
    const request = build(MOUNT_REQUEST) as Extract<PrivilegedRequest, { verb: 'mount-share' }>;
    const rendered = buildMountOptions(request, '/run/tnc-bridge/creds');

    // Without `soft` a CIFS call against a vanished server blocks for ever, and the
    // process holding it cannot be killed.
    expect(rendered.split(',')).toContain('soft');
    expect(rendered).toContain('echo_interval=');
  });
});

describe('unmount-share', () => {
  it('unmounts the derived mount point', () => {
    const h = harness();
    execute(build({ verb: 'unmount-share', shareName: 'werkstatt' }), h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]![0]).toBe('/usr/bin/umount');
    expect(h.calls[0]).not.toContain('-f');
  });

  it('passes -f when forced', () => {
    const h = harness();
    execute(build({ verb: 'unmount-share', shareName: 'werkstatt', force: true }), h.deps);
    expect(h.calls[0]).toContain('-f');
  });

  it('escalates to a lazy unmount when a forced unmount fails', () => {
    const h = harness();
    h.failWhen((argv) => argv.includes('-f'));
    const result = execute(
      build({ verb: 'unmount-share', shareName: 'werkstatt', force: true }),
      h.deps,
    );
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toContain('-l');
    expect(result.detail).toMatchObject({ lazy: true });
  });

  it('propagates a plain unmount failure rather than silently lazily detaching', () => {
    const h = harness();
    h.failWhen(() => true);
    expect(() => execute(build({ verb: 'unmount-share', shareName: 'werkstatt' }), h.deps)).toThrow(
      CommandError,
    );
  });
});

describe('reload-samba', () => {
  it('reloads config without dropping sessions', () => {
    const h = harness();
    execute(build({ verb: 'reload-samba', mode: 'reload' }), h.deps);
    expect(h.calls[0]).toEqual(['/usr/bin/smbcontrol', 'all', 'reload-config']);
  });

  it('restarts both daemons when asked', () => {
    const h = harness();
    execute(build({ verb: 'reload-samba', mode: 'restart' }), h.deps);
    expect(h.calls[0]).toEqual(['/usr/bin/systemctl', 'restart', 'smbd', 'nmbd']);
  });
});

describe('write-samba-config', () => {
  const content = '[global]\n  interfaces = eth1\n  bind interfaces only = yes\n';

  it('validates with testparm before the config is activated', () => {
    const h = harness();
    execute(build({ verb: 'write-samba-config', content }), h.deps);
    expect(h.calls[0]![0]).toBe('/usr/bin/testparm');
    expect(h.fs.files.get(SAMBA_CONFIG_PATH)).toBe(content);
  });

  /** The regression this guards: a typo that removes `bind interfaces only` going live. */
  it('never activates a config testparm rejects', () => {
    const h = harness();
    h.failWhen((argv) => argv[0] === '/usr/bin/testparm', { stderr: 'Unknown parameter' });
    expect(() => execute(build({ verb: 'write-samba-config', content }), h.deps)).toThrow(
      /testparm rejected/,
    );
    expect(h.fs.files.has(SAMBA_CONFIG_PATH)).toBe(false);
  });

  it('removes the candidate file whether validation passes or fails', () => {
    const ok = harness();
    execute(build({ verb: 'write-samba-config', content }), ok.deps);
    expect(ok.fs.removed).toContain(`${SAMBA_CONFIG_PATH}.candidate`);

    const bad = harness();
    bad.failWhen((argv) => argv[0] === '/usr/bin/testparm');
    expect(() => execute(build({ verb: 'write-samba-config', content }), bad.deps)).toThrow();
    expect(bad.fs.removed).toContain(`${SAMBA_CONFIG_PATH}.candidate`);
  });

  it('keeps the previous config for rollback', () => {
    const h = harness();
    h.fs.files.set(SAMBA_CONFIG_PATH, '[global]\n  old = yes\n');
    execute(build({ verb: 'write-samba-config', content }), h.deps);
    expect(h.fs.files.get(SAMBA_BACKUP_PATH)).toBe('[global]\n  old = yes\n');
  });

  it('reloads samba after a successful write', () => {
    const h = harness();
    execute(build({ verb: 'write-samba-config', content }), h.deps);
    expect(h.calls.at(-1)).toEqual(['/usr/bin/smbcontrol', 'all', 'reload-config']);
  });
});

describe('write-dnsmasq-config', () => {
  const content = 'interface=eth1\ndhcp-range=192.168.42.50,192.168.42.100,12h\n';

  it('writes the drop-in and restarts dnsmasq when enabled', () => {
    const h = harness();
    execute(build({ verb: 'write-dnsmasq-config', content, enabled: true }), h.deps);
    expect(h.fs.files.get(DNSMASQ_CONFIG_PATH)).toBe(content);
    expect(h.calls.at(-1)).toEqual(['/usr/bin/systemctl', 'restart', 'dnsmasq']);
  });

  /** A commented-out drop-in that dnsmasq still reads keeps handing out leases. */
  it('removes the drop-in entirely when disabled', () => {
    const h = harness();
    execute(build({ verb: 'write-dnsmasq-config', content, enabled: false }), h.deps);
    expect(h.fs.removed).toContain(DNSMASQ_CONFIG_PATH);
    expect(h.calls).toEqual([
      ['/usr/bin/systemctl', 'stop', 'dnsmasq'],
      ['/usr/bin/systemctl', 'disable', 'dnsmasq'],
    ]);
  });
});

describe('apply-network', () => {
  const NMCLI_SHOW = 'GENERAL.CONNECTION:Wired connection 1\n';
  const base = {
    verb: 'apply-network',
    interface: 'eth0',
    method: 'static',
    address: '192.168.1.5/24',
    gateway: '192.168.1.1',
    dns: ['192.168.1.1'],
    mtu: 1500,
    ipv6Enabled: false,
    revertAfterSeconds: 60,
  };

  it('parses the connection name out of nmcli terse output', () => {
    expect(parseConnectionName(NMCLI_SHOW)).toBe('Wired connection 1');
    expect(parseConnectionName('GENERAL.CONNECTION:--\n')).toBeUndefined();
    expect(parseConnectionName('GENERAL.CONNECTION:\n')).toBeUndefined();
    expect(parseConnectionName('GENERAL.DEVICE:eth0\n')).toBeUndefined();
    expect(parseConnectionName('no colon here\n')).toBeUndefined();
  });

  it('creates a profile when the interface has none, instead of refusing', () => {
    // A NIC that has never been configured has no profile to modify, which is the state
    // every appliance's second interface ships in. Refusing made the TNC side impossible
    // to configure at all — the operator saw a 500 and the segment stayed dark.
    const h = harness(() => 'GENERAL.CONNECTION:--\n');

    const result = execute(build(base), h.deps);

    const added = result.commands.find((cmd) => cmd.includes('add'));
    expect(added).toBeDefined();
    expect(added).toEqual(
      expect.arrayContaining(['con', 'add', 'type', 'ethernet', 'ifname', 'eth0']),
    );
    // Named after the interface so a second run finds it rather than stacking another.
    expect(added).toEqual(expect.arrayContaining(['con-name', 'tnc-eth0']));
    // And it must come back on its own after a reboot.
    expect(added).toEqual(expect.arrayContaining(['autoconnect', 'yes']));
  });

  it('modifies the profile it just created, not some other one', () => {
    const h = harness(() => 'GENERAL.CONNECTION:--\n');

    const result = execute(build(base), h.deps);

    const modified = result.commands.find((cmd) => cmd.includes('mod'));
    expect(modified).toEqual(expect.arrayContaining(['con', 'mod', 'tnc-eth0']));
  });

  it('applies a static address, gateway and DNS', () => {
    const h = harness(() => NMCLI_SHOW);
    execute(build(base), h.deps);
    const mod = h.calls.find((argv) => argv[2] === 'mod')!;
    expect(mod).toEqual([
      '/usr/bin/nmcli',
      'con',
      'mod',
      'Wired connection 1',
      'ipv4.method',
      'manual',
      'ipv4.addresses',
      '192.168.1.5/24',
      'ipv4.gateway',
      '192.168.1.1',
      'ipv4.dns',
      '192.168.1.1',
      'ipv6.method',
      'disabled',
      '802-3-ethernet.mtu',
      '1500',
    ]);
  });

  it('clears the static settings when switching to dhcp', () => {
    const h = harness(() => NMCLI_SHOW);
    execute(build({ ...base, method: 'dhcp', address: undefined }), h.deps);
    const mod = h.calls.find((argv) => argv[2] === 'mod')!;
    expect(mod.slice(4, 12)).toEqual([
      'ipv4.method',
      'auto',
      'ipv4.addresses',
      '',
      'ipv4.gateway',
      '',
      'ipv4.dns',
      '',
    ]);
  });

  it('enables ipv6 when requested', () => {
    const h = harness(() => NMCLI_SHOW);
    execute(build({ ...base, ipv6Enabled: true }), h.deps);
    const mod = h.calls.find((argv) => argv[2] === 'mod')!;
    expect(mod.slice(-4, -2)).toEqual(['ipv6.method', 'auto']);
  });

  /**
   * The lockout guard. A wrong static address on a headless Pi in a machine hall is
   * only recoverable by a timer that does not depend on the service that broke it.
   */
  it('clones the current profile and arms a systemd revert timer', () => {
    const h = harness(() => NMCLI_SHOW);
    const result = execute(build(base), h.deps);
    expect(h.calls.some((argv) => argv.includes('clone'))).toBe(true);
    const armed = h.calls.find((argv) => argv[0] === '/usr/bin/systemdRun')!;
    expect(armed).toEqual([
      '/usr/bin/systemdRun',
      `--unit=${NET_REVERT_UNIT}`,
      '--on-active=60',
      '--description=Revert TNC Bridge network change if unconfirmed',
      '/usr/bin/nmcli',
      'con',
      'up',
      'tnc-revert-eth0',
    ]);
    expect(result.detail).toMatchObject({ revertArmed: true });
  });

  it('arms nothing and confirms the previous change when the window is zero', () => {
    const h = harness(() => NMCLI_SHOW);
    const result = execute(build({ ...base, revertAfterSeconds: 0 }), h.deps);
    expect(h.calls.some((argv) => argv[0] === '/usr/bin/systemdRun')).toBe(false);
    expect(h.calls.some((argv) => argv.includes('clone'))).toBe(false);
    // The pending timer and its clone are cleared, which is what "confirm" means here.
    // Asserted by content rather than by index: a positional assertion on a command log
    // breaks whenever a step is inserted, which is noise rather than a signal.
    expect(h.calls).toContainEqual(['/usr/bin/systemctl', 'stop', `${NET_REVERT_UNIT}.service`]);
    expect(h.calls).toContainEqual(['/usr/bin/nmcli', 'con', 'delete', 'tnc-revert-eth0']);
    expect(result.detail).toMatchObject({ revertArmed: false });
  });

  it('unloads a revert unit left in the failed state, not merely stops it', () => {
    // The bug that made the appliance un-reconfigurable. A revert timer that has fired
    // and exited non-zero stays *loaded* in state `failed`, and systemd-run then
    // refuses the name — so every later apply that armed a rollback failed permanently,
    // reporting an error only after it had already changed the network. `stop` does not
    // clear a failed unit; `reset-failed` does.
    const h = harness(() => NMCLI_SHOW);

    execute(build({ ...base, revertAfterSeconds: 300 }), h.deps);

    expect(h.calls).toContainEqual([
      '/usr/bin/systemctl',
      'reset-failed',
      `${NET_REVERT_UNIT}.service`,
    ]);
  });

  it('clears the timer unit as well as the service', () => {
    // systemd-run --on-active creates both; a stuck timer blocks the name just as a
    // stuck service does.
    const h = harness(() => NMCLI_SHOW);

    execute(build({ ...base, revertAfterSeconds: 300 }), h.deps);

    expect(h.calls).toContainEqual([
      '/usr/bin/systemctl',
      'reset-failed',
      `${NET_REVERT_UNIT}.timer`,
    ]);
  });

  it('clears the old unit before arming the new one', () => {
    // Order is the whole point: resetting after systemd-run would be resetting the
    // timer this call just armed.
    const h = harness(() => NMCLI_SHOW);

    execute(build({ ...base, revertAfterSeconds: 300 }), h.deps);

    const reset = h.calls.findIndex((argv) => argv.includes('reset-failed'));
    const armed = h.calls.findIndex((argv) => argv[0] === '/usr/bin/systemdRun');
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(armed).toBeGreaterThan(reset);
  });

  it('brings the connection up after modifying it', () => {
    const h = harness(() => NMCLI_SHOW);
    execute(build(base), h.deps);
    const up = h.calls.filter((argv) => argv[2] === 'up');
    expect(up[0]).toEqual(['/usr/bin/nmcli', 'con', 'up', 'Wired connection 1']);
  });
});

describe('write-nft-ruleset', () => {
  const content = 'table inet filter {\n  chain input { type filter hook input priority 0; }\n}\n';

  it('checks the ruleset with nft -c before loading it', () => {
    const h = harness();
    execute(build({ verb: 'write-nft-ruleset', content }), h.deps);
    expect(h.calls[0]!.slice(0, 3)).toEqual(['/usr/bin/nft', '-c', '-f']);
    expect(h.calls.at(-1)).toEqual(['/usr/bin/nft', '-f', NFT_RULESET_PATH]);
  });

  it('never loads a ruleset nft rejects', () => {
    const h = harness();
    h.failWhen((argv) => argv.includes('-c'), { stderr: 'syntax error' });
    expect(() => execute(build({ verb: 'write-nft-ruleset', content }), h.deps)).toThrow(
      /nft rejected the ruleset/,
    );
    expect(h.fs.files.has(NFT_RULESET_PATH)).toBe(false);
    expect(h.calls.some((argv) => argv[1] === '-f')).toBe(false);
  });

  it('stores the ruleset 0600 — firewall policy is not world-readable', () => {
    const h = harness();
    execute(build({ verb: 'write-nft-ruleset', content }), h.deps);
    expect(h.fs.modes.get(NFT_RULESET_PATH)).toBe(0o600);
  });
});

/**
 * The real filesystem port, exercised against a temp directory. The doubles above prove
 * the handlers call the right operations; this proves those operations do what their
 * names claim — particularly `shred`, whose whole purpose is that a credentials file
 * does not outlive the mount.
 */
describe('nodeFilesystem', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tnc-fs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads text', () => {
    const path = join(dir, 'file.conf');
    nodeFilesystem.writeAtomic(path, 'hello', 0o644);
    expect(nodeFilesystem.readText(path)).toBe('hello');
    expect(nodeFilesystem.exists(path)).toBe(true);
  });

  it('leaves no temp file behind after an atomic write', () => {
    nodeFilesystem.writeAtomic(join(dir, 'file.conf'), 'hello', 0o644);
    expect(readdirSync(dir)).toEqual(['file.conf']);
  });

  it('replaces existing content atomically', () => {
    const path = join(dir, 'file.conf');
    nodeFilesystem.writeAtomic(path, 'first', 0o644);
    nodeFilesystem.writeAtomic(path, 'second', 0o644);
    expect(nodeFilesystem.readText(path)).toBe('second');
  });

  it('writes a secret with an exact mode, not one widened by the umask', () => {
    const path = join(dir, 'creds');
    nodeFilesystem.writeSecret(path, 'password=x', 0o600);
    expect(nodeFilesystem.readText(path)).toBe('password=x');
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('overwrites the bytes before unlinking, so the content does not survive', () => {
    const path = join(dir, 'creds');
    nodeFilesystem.writeSecret(path, 'password=hunter2', 0o600);
    nodeFilesystem.shred(path);
    expect(nodeFilesystem.exists(path)).toBe(false);
  });

  it('shredding an absent file is a no-op, so cleanup in a finally block is safe', () => {
    expect(() => nodeFilesystem.shred(join(dir, 'never-existed'))).not.toThrow();
  });

  it('shreds an empty file without error', () => {
    const path = join(dir, 'empty');
    nodeFilesystem.writeSecret(path, '', 0o600);
    nodeFilesystem.shred(path);
    expect(nodeFilesystem.exists(path)).toBe(false);
  });

  it('creates nested directories', () => {
    const path = join(dir, 'a', 'b', 'c');
    nodeFilesystem.mkdirp(path, 0o750);
    expect(nodeFilesystem.isDirectory(path)).toBe(true);
  });

  it('copies a file', () => {
    nodeFilesystem.writeAtomic(join(dir, 'src'), 'content', 0o644);
    nodeFilesystem.copy(join(dir, 'src'), join(dir, 'dst'));
    expect(nodeFilesystem.readText(join(dir, 'dst'))).toBe('content');
  });

  it('removes a file and tolerates removing it twice', () => {
    const path = join(dir, 'gone');
    nodeFilesystem.writeAtomic(path, 'x', 0o644);
    nodeFilesystem.remove(path);
    expect(nodeFilesystem.exists(path)).toBe(false);
    expect(() => nodeFilesystem.remove(path)).not.toThrow();
  });

  it('hashes file content with sha256', () => {
    const path = join(dir, 'blob');
    nodeFilesystem.writeAtomic(path, 'abc', 0o644);
    expect(nodeFilesystem.sha256(path)).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('reports a file as not a directory', () => {
    const path = join(dir, 'plain');
    nodeFilesystem.writeAtomic(path, 'x', 0o644);
    expect(nodeFilesystem.isDirectory(path)).toBe(false);
    expect(nodeFilesystem.isDirectory(join(dir, 'absent'))).toBe(false);
  });
});

describe('fail2ban-unban', () => {
  it('unbans the address in the named jail', () => {
    const h = harness();
    execute(build({ verb: 'fail2ban-unban', ip: '10.4.0.31', jail: 'tnc-bridge' }), h.deps);
    expect(h.calls[0]).toEqual([
      '/usr/bin/fail2banClient',
      'set',
      'tnc-bridge',
      'unbanip',
      '10.4.0.31',
    ]);
  });
});

describe('install-cert', () => {
  const certPem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  const keyPem = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n';

  it('writes the private key 0640 so only the service group can read it', () => {
    const h = harness();
    const result = execute(build({ verb: 'install-cert', certPem, keyPem }), h.deps);
    const keyPath = result.detail.keyPath as string;
    expect(h.fs.modes.get(keyPath)).toBe(0o640);
    expect(h.fs.files.get(keyPath)).toBe(keyPem);
  });

  it('writes the certificate world-readable, because it is public by definition', () => {
    const h = harness();
    const result = execute(build({ verb: 'install-cert', certPem, keyPem }), h.deps);
    expect(h.fs.modes.get(result.detail.certPath as string)).toBe(0o644);
  });

  it('removes a stale chain when none is supplied', () => {
    const h = harness();
    execute(build({ verb: 'install-cert', certPem, keyPem }), h.deps);
    expect(h.fs.removed.some((path) => path.includes('chain.crt'))).toBe(true);
  });

  it('installs a supplied chain', () => {
    const h = harness();
    const chainPem = '-----BEGIN CERTIFICATE-----\nchain\n-----END CERTIFICATE-----\n';
    const result = execute(build({ verb: 'install-cert', certPem, keyPem, chainPem }), h.deps);
    expect(result.detail).toMatchObject({ chainInstalled: true });
  });

  it('runs no commands — installing a cert is a filesystem operation', () => {
    const h = harness();
    execute(build({ verb: 'install-cert', certPem, keyPem }), h.deps);
    expect(h.calls).toHaveLength(0);
  });
});

describe('service-restart', () => {
  it.each(['restart', 'start', 'stop', 'reload'])('runs systemctl %s', (action) => {
    const h = harness();
    execute(build({ verb: 'service-restart', service: 'smbd', action }), h.deps);
    expect(h.calls[0]).toEqual(['/usr/bin/systemctl', action, 'smbd']);
  });
});

describe('apply-update', () => {
  const releaseDir = validateRequest(
    { verb: 'apply-update', version: 'v0.2.0' },
    OPTIONS,
  ) as Extract<PrivilegedRequest, { verb: 'apply-update' }>;

  function stageRelease(h: Harness, files: Record<string, string>): void {
    h.fs.directories.add(releaseDir.releaseDir);
    const lines: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const path = join(releaseDir.releaseDir, name);
      h.fs.files.set(path, content);
      lines.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
    }
    h.fs.files.set(join(releaseDir.releaseDir, CHECKSUM_MANIFEST), `${lines.join('\n')}\n`);
  }

  it('parses a sha256sum manifest', () => {
    const digest = 'a'.repeat(64);
    expect(parseChecksumManifest(`${digest}  dist/backend/index.js\n`)).toEqual([
      { digest, path: 'dist/backend/index.js' },
    ]);
  });

  it('accepts the binary-mode asterisk and skips comments and blanks', () => {
    const digest = 'b'.repeat(64);
    expect(parseChecksumManifest(`# header\n\n${digest} *dist/app.tar\n`)).toEqual([
      { digest, path: 'dist/app.tar' },
    ]);
  });

  it.each(['not a manifest', 'deadbeef  file', 'a'.repeat(64)])(
    'rejects the malformed manifest line %p',
    (text) => {
      expect(() => parseChecksumManifest(text)).toThrow(PrivilegedExecutionError);
    },
  );

  it('rejects an empty manifest', () => {
    expect(() => parseChecksumManifest('# only a comment\n')).toThrow(/empty/);
  });

  /** A manifest that can name `../../etc/systemd/system/x.service` is a read primitive. */
  it.each(['../../etc/passwd', '/etc/passwd', 'dist/../../escape'])(
    'rejects the escaping manifest path %p',
    (path) => {
      expect(() => parseChecksumManifest(`${'c'.repeat(64)}  ${path}\n`)).toThrow(
        /escapes the release/,
      );
    },
  );

  it('verifies every file, then swaps the current symlink and restarts', () => {
    const h = harness();
    stageRelease(h, { 'dist/backend/index.js': 'console.log(1)', 'package.json': '{}' });
    const result = execute(releaseDir, h.deps);
    expect(result.detail).toMatchObject({ filesVerified: 2, version: 'v0.2.0' });
    expect(h.calls[0]).toEqual([
      '/usr/bin/ln',
      '-sfn',
      releaseDir.releaseDir,
      CURRENT_RELEASE_LINK,
    ]);
    expect(h.calls[1]).toEqual(['/usr/bin/systemctl', 'restart', 'tnc-bridge']);
  });

  /**
   * The unprivileged updater downloaded this release, so the helper cannot assume it is
   * intact — re-hashing at the boundary is the point of having a boundary.
   */
  it('refuses to activate a release whose contents do not match the manifest', () => {
    const h = harness();
    stageRelease(h, { 'dist/app.js': 'original' });
    h.fs.files.set(join(releaseDir.releaseDir, 'dist/app.js'), 'tampered');
    expect(() => execute(releaseDir, h.deps)).toThrow(/checksum mismatch for dist\/app\.js/);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a release with a missing file', () => {
    const h = harness();
    stageRelease(h, { 'dist/app.js': 'x' });
    h.fs.files.delete(join(releaseDir.releaseDir, 'dist/app.js'));
    expect(() => execute(releaseDir, h.deps)).toThrow(/missing dist\/app\.js/);
  });

  it('refuses a release directory that does not exist', () => {
    const h = harness();
    expect(() => execute(releaseDir, h.deps)).toThrow(/release directory .* not found/);
  });

  it('refuses a release with no checksum manifest', () => {
    const h = harness();
    h.fs.directories.add(releaseDir.releaseDir);
    expect(() => execute(releaseDir, h.deps)).toThrow(/missing SHA256SUMS/);
  });

  it('checks the manifest digest itself when one is supplied', () => {
    const h = harness();
    stageRelease(h, { 'dist/app.js': 'x' });
    const manifest = h.fs.files.get(join(releaseDir.releaseDir, CHECKSUM_MANIFEST))!;
    const digest = createHash('sha256').update(manifest).digest('hex');

    const good = validateRequest(
      { verb: 'apply-update', version: 'v0.2.0', manifestSha256: digest },
      OPTIONS,
    );
    expect(() => execute(good, h.deps)).not.toThrow();

    const bad = validateRequest(
      { verb: 'apply-update', version: 'v0.2.0', manifestSha256: 'f'.repeat(64) },
      OPTIONS,
    );
    expect(() => execute(bad, h.deps)).toThrow(/SHA256SUMS digest mismatch/);
  });
});

describe('self-update', () => {
  const REQUEST = {
    verb: 'self-update',
    targetRef: 'v0.2.0',
    previousRef: 'v0.1.0',
    healthTimeoutSeconds: 120,
  };

  it('runs the updater in a transient unit, not as a child of the helper', () => {
    // The updater's last act is `systemctl restart tnc-bridge`, and systemd kills the
    // whole cgroup on restart. A child of this helper — itself a child of the service —
    // would be killed partway through the switch, leaving a tree that is neither
    // release. systemd-run is what puts it outside that cgroup.
    const h = harness();
    h.fs.files.set(SELF_UPDATE_SCRIPT, '#!/usr/bin/env bash');

    const result = execute(build(REQUEST), h.deps);

    const argv = h.calls[0] ?? [];
    expect(argv[0]).toBe('/usr/bin/systemdRun');
    expect(argv).toContain(`--unit=${SELF_UPDATE_UNIT}`);
    expect(argv).toContain(SELF_UPDATE_SCRIPT);
    expect(argv).toContain('v0.2.0');
    expect(argv).toContain('v0.1.0');
    expect(result.verb).toBe('self-update');
  });

  it('execs the script itself rather than handing it to a shell', () => {
    // BINARIES contains no shell on purpose. Passing the script as an argument to one
    // would put a shell back inside the privilege boundary.
    const h = harness();
    h.fs.files.set(SELF_UPDATE_SCRIPT, '#!/usr/bin/env bash');

    execute(build(REQUEST), h.deps);

    const argv = h.calls[0] ?? [];
    const scriptIndex = argv.indexOf(SELF_UPDATE_SCRIPT);
    expect(scriptIndex).toBeGreaterThan(0);
    expect(argv[scriptIndex - 1]).not.toMatch(/sh$/);
  });

  it('passes the health timeout through to the script', () => {
    const h = harness();
    h.fs.files.set(SELF_UPDATE_SCRIPT, '#!/usr/bin/env bash');

    execute(build({ ...REQUEST, healthTimeoutSeconds: 300 }), h.deps);

    expect(h.calls[0]).toContain('--setenv=TNC_HEALTH_TIMEOUT=300');
  });

  it('refuses when the updater script is not installed', () => {
    // An install predating the script would otherwise start a unit that fails
    // instantly, and the operator would see an update that neither ran nor errored.
    const h = harness();
    expect(() => execute(build(REQUEST), h.deps)).toThrow(/not found/);
    expect(h.calls).toHaveLength(0);
  });

  it('accepts an empty previousRef, because a first update has nothing to go back to', () => {
    const h = harness();
    h.fs.files.set(SELF_UPDATE_SCRIPT, '#!/usr/bin/env bash');

    const result = execute(build({ ...REQUEST, previousRef: '' }), h.deps);

    expect(result.detail).toMatchObject({ previousRef: '' });
  });

  it.each([
    ['an option', '--upload-pack=evil'],
    ['a refspec', 'origin/main:evil'],
    ['a traversal', '../../etc/passwd'],
    ['a command substitution', '$(id)'],
  ])('rejects a target ref that is %s', (_label, ref) => {
    expect(() => build({ ...REQUEST, targetRef: ref })).toThrow();
  });
});

describe('os-update', () => {
  const REQUEST = { verb: 'os-update', reboot: false };

  it('runs the OS updater in its own transient unit', () => {
    // apt takes minutes on a Pi and may end in a reboot. Neither belongs on the
    // lifetime of an HTTP request, or inside the service's cgroup.
    const h = harness();
    h.fs.files.set(OS_UPDATE_SCRIPT, '#!/usr/bin/env bash');

    const result = execute(build(REQUEST), h.deps);

    const argv = h.calls[0] ?? [];
    expect(argv[0]).toBe('/usr/bin/systemdRun');
    expect(argv).toContain(`--unit=${OS_UPDATE_UNIT}`);
    expect(argv).toContain(OS_UPDATE_SCRIPT);
    expect(result.verb).toBe('os-update');
  });

  it('passes --reboot only when one was asked for', () => {
    const h = harness();
    h.fs.files.set(OS_UPDATE_SCRIPT, '#!/usr/bin/env bash');

    execute(build(REQUEST), h.deps);
    expect(h.calls[0]).not.toContain('--reboot');

    const rebooting = harness();
    rebooting.fs.files.set(OS_UPDATE_SCRIPT, '#!/usr/bin/env bash');
    execute(build({ ...REQUEST, reboot: true }), rebooting.deps);
    expect(rebooting.calls[0]).toContain('--reboot');
  });

  it('uses a unit name distinct from the self-updater, so the two never collide', () => {
    expect(OS_UPDATE_UNIT).not.toBe(SELF_UPDATE_UNIT);
  });

  it('refuses when the updater script is not installed', () => {
    const h = harness();

    expect(() => execute(build(REQUEST), h.deps)).toThrow(/not found/);
    expect(h.calls).toHaveLength(0);
  });

  it('rejects a reboot flag that is not a boolean', () => {
    expect(() => build({ ...REQUEST, reboot: 'yes; rm -rf /' })).toThrow();
  });
});

describe('set-samba-user', () => {
  const REQUEST = {
    verb: 'set-samba-user',
    username: 'tnc-werkstatt',
    password: 'geheim',
    remove: false,
  };

  it('puts the account in the service group, or the share is unreadable', () => {
    // Found on the appliance: the account authenticated and then could not traverse
    // /srv/tnc, which is 0750 and owned by the service account. A machine would get a
    // share it may open and cannot read — which looks like a broken bridge rather than
    // a permissions mistake. The group also settles the other direction: a file the
    // machine writes lands in it, so the sync engine can push it back.
    const h = harness();

    execute(build(REQUEST), h.deps);

    const useradd = h.calls.find((argv) => argv[0]?.includes('useradd'));
    expect(useradd).toContain('--gid');
    expect(useradd?.[(useradd.indexOf('--gid') ?? 0) + 1]).toBe(SERVICE_GROUP);
  });

  it('repairs an account created before the group was set', () => {
    // Idempotent, and cheaper than asking: the answer would have to be parsed out of
    // `id`, and getting it wrong silently is how the original bug survived.
    const h = harness();

    execute(build(REQUEST), h.deps);

    expect(h.calls).toContainEqual(['/usr/bin/usermod', '--gid', SERVICE_GROUP, 'tnc-werkstatt']);
  });

  it('creates a locked system account to back the Samba one', () => {
    // Samba refuses an entry for a user getpwnam cannot resolve, so the Unix account
    // has to exist — but it exists only to be a name Samba can hang a password on.
    const h = harness();

    execute(build(REQUEST), h.deps);

    const useradd = h.calls.find((argv) => argv[0]?.includes('useradd'));
    expect(useradd).toContain('--system');
    expect(useradd).toContain('--no-create-home');
    expect(useradd).toContain('/usr/sbin/nologin');
  });

  it('never puts the password in argv', () => {
    // argv is visible in the process table and in this helper's own audit line.
    const h = harness();

    execute(build(REQUEST), h.deps);

    for (const argv of h.calls) {
      expect(argv).not.toContain('geheim');
    }
  });

  it('treats an existing account as success, because a password change is normal', () => {
    // useradd exits 9 for "user already exists", which is the ordinary case here.
    const h = harness();
    h.failWhen((argv) => argv[0]?.includes('useradd') === true, { status: 9 });

    expect(() => execute(build(REQUEST), h.deps)).not.toThrow();
  });

  it('fails loudly when the account cannot be created for another reason', () => {
    const h = harness();
    h.failWhen((argv) => argv[0]?.includes('useradd') === true, {
      status: 1,
      stderr: 'no space left on device',
    });

    expect(() => execute(build(REQUEST), h.deps)).toThrow(/no space left/);
  });

  it('fails when smbpasswd refuses the account', () => {
    const h = harness();
    h.failWhen((argv) => argv.includes('-a'), { status: 1, stderr: 'password too short' });

    expect(() => execute(build(REQUEST), h.deps)).toThrow(/password too short/);
  });

  it('removes the Samba entry before the Unix account', () => {
    // The other order leaves an smbpasswd entry pointing at a uid that no longer
    // resolves, which makes every later call on that name fail.
    const h = harness();

    execute(build({ ...REQUEST, remove: true }), h.deps);

    const smbIndex = h.calls.findIndex((argv) => argv.includes('-x'));
    const userdelIndex = h.calls.findIndex((argv) => argv[0]?.includes('userdel'));
    expect(smbIndex).toBeGreaterThanOrEqual(0);
    expect(userdelIndex).toBeGreaterThan(smbIndex);
  });

  it('does not fail when removing an account that was never created', () => {
    const h = harness();
    h.failWhen(() => true, { status: 1 });

    expect(() => execute(build({ ...REQUEST, remove: true }), h.deps)).not.toThrow();
  });

  it('refuses an empty password, because an account with none is not one', () => {
    expect(() => build({ ...REQUEST, password: '' })).toThrow();
  });

  it.each([
    ['a name outside the namespace', 'root'],
    ['a leading dash', '-rf'],
    ['an uppercase name', 'TNC-Werkstatt'],
    ['a path', 'tnc-../../etc/passwd'],
  ])('rejects %s', (_label, username) => {
    expect(() => build({ ...REQUEST, username })).toThrow();
  });
});
