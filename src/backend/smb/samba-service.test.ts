import { buildSmbConf, type SmbConfInput } from './smb-conf';
import {
  checkNt1Support,
  type CommandOutput,
  decideApplyStrategy,
  parseSmbStatusJson,
  parseSmbStatusText,
  SambaService,
  SambaUnsupportedError,
  type SmbOpenFile,
  toRelativePath,
} from './samba-service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE: SmbConfInput = {
  tncInterface: 'eth1',
  lanInterface: 'eth0',
  shares: [{ name: 'programs', path: '/srv/tnc/programs' }],
};

const ok = (stdout: string): CommandOutput => ({ stdout, stderr: '', code: 0 });
const failed = (stderr: string): CommandOutput => ({ stdout: '', stderr, code: 1 });

const SMBSTATUS_JSON = JSON.stringify({
  version: '4.17.12-Debian',
  sessions: {
    '3437877139': {
      session_id: '3437877139',
      server_id: { pid: '1234' },
      username: 'tnc',
      groupname: 'tnc',
      remote_machine: '192.168.42.50',
      session_dialect: 'NT1',
      encryption: { degree: 'none' },
      signing: { degree: 'none' },
    },
  },
  tcons: {
    '2': { service: 'programs', server_id: { pid: '1234' }, machine: '192.168.42.50' },
  },
  open_files: {
    '/srv/tnc/programs/12345.H': {
      service_path: '/srv/tnc/programs',
      filename: '12345.H',
      opens: {
        '0': {
          server_id: { pid: '1234' },
          uid: 1000,
          sharemode: { text: 'DENY_NONE' },
          access_mask: { text: 'RDWR' },
          oplock: { text: 'NONE' },
          opened_at: '2026-09-07T10:00:01+02:00',
        },
      },
    },
  },
});

const SMBSTATUS_TEXT = `
Samba version 4.13.13-Debian
PID     Username     Group        Machine                            Protocol Version  Encryption   Signing
----------------------------------------------------------------------------------------------------------
1234    tnc          tnc          192.168.42.50                      NT1               -            -

Service      pid     Machine          Connected at
--------------------------------------------------------
programs     1234    192.168.42.50    Sun Sep  7 10:00:00 2026

Locked files:
Pid          User(ID)   DenyMode   Access      R/W        Oplock           SharePath           Name       Time
---------------------------------------------------------------------------------------------------------------
1234         1000       DENY_NONE  0x100081    RDWR       NONE             /srv/tnc/programs   12345.H    Sun Sep  7 10:00:01 2026
`;

// ---------------------------------------------------------------------------
// Reload vs restart
// ---------------------------------------------------------------------------

describe('decideApplyStrategy', () => {
  it('does nothing when the config is unchanged', () => {
    const conf = buildSmbConf(BASE);
    expect(decideApplyStrategy(conf, conf).strategy).toBe('none');
  });

  it('does nothing when only comments or whitespace differ', () => {
    // Restarting the shop floor because a comment changed would be indefensible.
    const conf = buildSmbConf(BASE);
    const commented = `# a new comment\n${conf}\n\n`;
    expect(decideApplyStrategy(conf, commented).strategy).toBe('none');
  });

  it('reloads for a share parameter change, preserving open sessions', () => {
    // The AC: reload applies config without dropping connections.
    const before = buildSmbConf(BASE);
    const after = buildSmbConf({
      ...BASE,
      shares: [{ name: 'programs', path: '/srv/tnc/programs', readOnly: true }],
    });

    const decision = decideApplyStrategy(before, after);
    expect(decision.strategy).toBe('reload');
    expect(decision.changed).toContain('programs/readonly');
    expect(decision.restartTriggers).toEqual([]);
  });

  it('reloads when a share is added', () => {
    const before = buildSmbConf(BASE);
    const after = buildSmbConf({
      ...BASE,
      shares: [
        { name: 'programs', path: '/srv/tnc/programs' },
        { name: 'tools', path: '/srv/tnc/tools' },
      ],
    });
    expect(decideApplyStrategy(before, after).strategy).toBe('reload');
  });

  it('restarts when the interface binding changes, and says which parameter forced it', () => {
    const before = buildSmbConf(BASE);
    const after = buildSmbConf({ ...BASE, tncInterface: 'eth2', lanInterface: 'eth0' });

    const decision = decideApplyStrategy(before, after);
    expect(decision.strategy).toBe('restart');
    expect(decision.restartTriggers).toContain('interfaces');
  });

  it('restarts when the protocol range changes', () => {
    const before = buildSmbConf(BASE);
    const after = buildSmbConf({ ...BASE, maxProtocol: 'NT1' });
    const decision = decideApplyStrategy(before, after);
    expect(decision.strategy).toBe('restart');
    expect(decision.restartTriggers).toContain('servermaxprotocol');
  });

  it('restarts when the audit configuration changes, since the VFS is loaded at init', () => {
    const before = buildSmbConf(BASE);
    const after = buildSmbConf({ ...BASE, auditFacility: 'LOCAL6' });
    expect(decideApplyStrategy(before, after).strategy).toBe('restart');
  });

  it('restarts when the workgroup or netbios name changes', () => {
    const before = buildSmbConf(BASE);
    expect(
      decideApplyStrategy(before, buildSmbConf({ ...BASE, workgroup: 'OTHER' })).strategy,
    ).toBe('restart');
    expect(
      decideApplyStrategy(before, buildSmbConf({ ...BASE, netbiosName: 'OTHER' })).strategy,
    ).toBe('restart');
  });
});

// ---------------------------------------------------------------------------
// NT1 support (R1)
// ---------------------------------------------------------------------------

describe('checkNt1Support', () => {
  it('confirms support from the build flag', () => {
    expect(checkNt1Support('WITH_SMB1_SERVER\nWITH_ADS').support).toBe('supported');
  });

  it('detects a build with SMB1 compiled out', () => {
    // R1 rates this fatal: the bridge would look healthy and fail every TNC connection.
    expect(checkNt1Support('--without-smb1-server').support).toBe('unsupported');
  });

  it('treats an old Samba that predates the toggle as supported', () => {
    expect(checkNt1Support('Samba version 4.9.5-Debian').support).toBe('supported');
  });

  it('returns unknown rather than guessing when the flags say nothing', () => {
    // An honest third state. Refusing to start on a string match we are unsure about
    // would be its own outage; claiming support that is absent would be worse.
    expect(checkNt1Support('some unrelated output').support).toBe('unknown');
  });
});

describe('SambaService.assertNt1Supported', () => {
  const service = (output: CommandOutput, logger?: never) =>
    new SambaService({
      run: () => Promise.resolve(output),
      ...(logger === undefined ? {} : { logger }),
    });

  it('passes on a build with SMB1', async () => {
    const result = await service(ok('WITH_SMB1_SERVER')).assertNt1Supported();
    expect(result.support).toBe('supported');
  });

  it('fails startup loudly on a build without SMB1 instead of degrading silently', async () => {
    await expect(service(ok('--without-smb1-server')).assertNt1Supported()).rejects.toThrow(
      SambaUnsupportedError,
    );
  });

  it('explains the consequence and the remedy in the error', async () => {
    const error: unknown = await service(ok('--without-smb1-server'))
      .assertNt1Supported()
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/iTNC 530/);
    expect((error as Error).message).toMatch(/apt-mark|Pin and hold|build Samba/);
  });

  it('warns but continues when support cannot be determined', async () => {
    const warn = jest.fn();
    const svc = new SambaService({
      run: () => Promise.resolve(ok('nothing useful')),
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });

    const result = await svc.assertNt1Supported();

    expect(result.support).toBe('unknown');
    expect(warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// smbstatus JSON
// ---------------------------------------------------------------------------

describe('parseSmbStatusJson', () => {
  it('parses sessions, tcons and open files', () => {
    const status = parseSmbStatusJson(SMBSTATUS_JSON);

    expect(status.source).toBe('json');
    expect(status.version).toBe('4.17.12-Debian');
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]).toMatchObject({
      pid: 1234,
      username: 'tnc',
      remoteMachine: '192.168.42.50',
      dialect: 'NT1',
    });
    expect(status.tcons[0]).toMatchObject({ service: 'programs', pid: 1234 });
  });

  it('parses the open file a TNC is holding', () => {
    // The AC: open files on the TNC appear in parsed output.
    const status = parseSmbStatusJson(SMBSTATUS_JSON);
    expect(status.openFiles).toHaveLength(1);
    expect(status.openFiles[0]).toMatchObject({
      pid: 1234,
      uid: 1000,
      sharePath: '/srv/tnc/programs',
      filename: '12345.H',
      denyMode: 'DENY_NONE',
      oplock: 'NONE',
    });
  });

  it('reports one entry per open handle when a file is opened twice', () => {
    // R15: the second opener is write contention, and collapsing them would hide it.
    const doubled = JSON.parse(SMBSTATUS_JSON) as Record<string, unknown>;
    const files = doubled.open_files as Record<string, Record<string, unknown>>;
    const entry = files['/srv/tnc/programs/12345.H'];
    (entry!.opens as Record<string, unknown>)['1'] = {
      server_id: { pid: '5678' },
      uid: 1001,
    };

    const status = parseSmbStatusJson(JSON.stringify(doubled));
    expect(status.openFiles).toHaveLength(2);
    expect(status.openFiles.map((file) => file.pid).sort()).toEqual([1234, 5678]);
  });

  it('accepts sessions supplied as an array', () => {
    const status = parseSmbStatusJson(
      JSON.stringify({ sessions: [{ session_id: 'a', username: 'tnc' }] }),
    );
    expect(status.sessions[0]?.username).toBe('tnc');
  });

  it('degrades missing optional fields to null rather than throwing', () => {
    // A parse that loses one attribute is recoverable; one that throws takes the lock
    // reconciler down with it.
    const status = parseSmbStatusJson(JSON.stringify({ sessions: { a: {} } }));
    expect(status.sessions[0]).toMatchObject({ username: null, pid: null, dialect: null });
  });

  it('handles a file entry with no open handles', () => {
    const status = parseSmbStatusJson(
      JSON.stringify({ open_files: { '/srv/tnc/programs/x.H': { filename: 'x.H' } } }),
    );
    expect(status.openFiles).toHaveLength(1);
    expect(status.openFiles[0]?.pid).toBeNull();
  });

  it('returns empty collections for an empty status', () => {
    const status = parseSmbStatusJson('{}');
    expect(status.sessions).toEqual([]);
    expect(status.openFiles).toEqual([]);
  });

  it('throws on output that is not JSON at all', () => {
    expect(() => parseSmbStatusJson('not json')).toThrow(/valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// smbstatus text fallback
// ---------------------------------------------------------------------------

describe('parseSmbStatusText', () => {
  it('parses the three blocks of the plain-text report', () => {
    const status = parseSmbStatusText(SMBSTATUS_TEXT);

    expect(status.source).toBe('text');
    expect(status.version).toBe('4.13.13-Debian');
    expect(status.sessions[0]).toMatchObject({
      pid: 1234,
      username: 'tnc',
      remoteMachine: '192.168.42.50',
      dialect: 'NT1',
    });
    expect(status.tcons[0]).toMatchObject({ service: 'programs', pid: 1234 });
    expect(status.openFiles[0]).toMatchObject({
      pid: 1234,
      sharePath: '/srv/tnc/programs',
      filename: '12345.H',
    });
  });

  it('handles a report with no locked files', () => {
    const status = parseSmbStatusText('Samba version 4.13.13\n\nLocked files:\nNo locked files\n');
    expect(status.openFiles).toEqual([]);
  });

  it('ignores separator rules and blank lines', () => {
    expect(parseSmbStatusText('\n----\n\n').sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('toRelativePath', () => {
  const file = (overrides: Partial<SmbOpenFile>): SmbOpenFile => ({
    pid: 1,
    uid: 1,
    denyMode: null,
    access: null,
    rw: null,
    oplock: null,
    sharePath: '/srv/tnc/programs',
    filename: '12345.H',
    openedAt: null,
    ...overrides,
  });

  it('returns the name relative to the share root', () => {
    expect(toRelativePath(file({}), '/srv/tnc/programs')).toBe('12345.H');
  });

  it('keeps nested directories', () => {
    expect(toRelativePath(file({ filename: 'sub/12345.H' }), '/srv/tnc/programs')).toBe(
      'sub/12345.H',
    );
  });

  it('strips a leading ./', () => {
    expect(toRelativePath(file({ filename: './12345.H' }), '/srv/tnc/programs')).toBe('12345.H');
  });

  it('strips the cache root from an absolute name', () => {
    expect(
      toRelativePath(
        file({ filename: '/srv/tnc/programs/12345.H', sharePath: null }),
        '/srv/tnc/programs',
      ),
    ).toBe('12345.H');
  });

  it('returns null for a file belonging to a different share', () => {
    // Attributing another share's open file to this one would lock the wrong path.
    expect(toRelativePath(file({ sharePath: '/srv/tnc/tools' }), '/srv/tnc/programs')).toBeNull();
  });

  it('returns null for the share root itself', () => {
    expect(toRelativePath(file({ filename: '.' }), '/srv/tnc/programs')).toBeNull();
  });

  it('tolerates a trailing slash on either side', () => {
    expect(toRelativePath(file({ sharePath: '/srv/tnc/programs/' }), '/srv/tnc/programs')).toBe(
      '12345.H',
    );
  });
});

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

describe('SambaService.status', () => {
  it('prefers JSON when the build supports it', async () => {
    const calls: string[][] = [];
    const service = new SambaService({
      run: (argv) => {
        calls.push([...argv]);
        return Promise.resolve(ok(SMBSTATUS_JSON));
      },
    });

    const status = await service.status();

    expect(status.source).toBe('json');
    expect(calls[0]).toContain('--json');
  });

  it('falls back to the text parser on a build without --json', async () => {
    const service = new SambaService({
      run: (argv) =>
        Promise.resolve(
          argv.includes('--json') ? failed('unrecognized option') : ok(SMBSTATUS_TEXT),
        ),
    });

    const status = await service.status();

    expect(status.source).toBe('text');
    expect(status.sessions).toHaveLength(1);
  });

  it('falls back when --json returns unparseable output', async () => {
    const service = new SambaService({
      run: (argv) => Promise.resolve(argv.includes('--json') ? ok('{oops') : ok(SMBSTATUS_TEXT)),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    expect((await service.status()).source).toBe('text');
  });

  it('returns an empty status rather than throwing when smbstatus fails entirely', async () => {
    // A bridge that stops syncing because it could not enumerate sessions has confused
    // a diagnostic for a dependency.
    const service = new SambaService({
      run: () => Promise.resolve(failed('permission denied')),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    const status = await service.status();
    expect(status.sessions).toEqual([]);
    expect(status.openFiles).toEqual([]);
  });
});

describe('SambaService.apply', () => {
  it('issues no privileged call when nothing changed', async () => {
    const reload = jest.fn();
    const conf = buildSmbConf(BASE);
    const service = new SambaService({ reload });

    expect((await service.apply(conf, conf)).strategy).toBe('none');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads for a share change', async () => {
    const reload = jest.fn();
    const service = new SambaService({ reload });
    const before = buildSmbConf(BASE);
    const after = buildSmbConf({
      ...BASE,
      shares: [{ name: 'programs', path: '/srv/tnc/programs', readOnly: true }],
    });

    await service.apply(before, after);

    expect(reload).toHaveBeenCalledWith('reload');
  });

  it('restarts for an interface change and logs why sessions were dropped', async () => {
    const reload = jest.fn();
    const warn = jest.fn();
    const service = new SambaService({
      reload,
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });

    await service.apply(
      buildSmbConf(BASE),
      buildSmbConf({ ...BASE, tncInterface: 'eth2', lanInterface: 'eth0' }),
    );

    expect(reload).toHaveBeenCalledWith('restart');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ triggers: expect.arrayContaining(['interfaces']) }),
      expect.stringContaining('dropped'),
    );
  });
});
