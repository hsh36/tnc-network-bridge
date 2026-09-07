import {
  classifyFailure,
  type CommandOutput,
  FAILURE_RULES,
  parseAuthMethod,
  parseDialect,
  parseEncryption,
  parseFreeBytes,
  parseShares,
  parseSigning,
  parseUnc,
  type SmbRunner,
  testSmbConnection,
} from './tester';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LISTING_OK = `
Domain=[WORK] OS=[Windows Server 2019] Server=[]
negotiated dialect[SMB3_11]
gensec backend ntlmssp selected

	Sharename       Type      Comment
	---------       ----      -------
	programs        Disk      NC programs
	tools           Disk      Tool tables
	IPC$            IPC       IPC Service
	ADMIN$          Disk      Remote Admin

SMB1 disabled -- no workgroup available
`;

const DU_OK = `
		61440 blocks of size 1048576. 40960 blocks available
`;

const ok = (stdout: string): CommandOutput => ({ stdout, stderr: '', code: 0, timedOut: false });
const fail = (stderr: string, code = 1): CommandOutput => ({
  stdout: '',
  stderr,
  code,
  timedOut: false,
});

/** Drives the tester through its three phases with scripted `smbclient` output. */
function scriptedRunner(steps: {
  list?: CommandOutput;
  connect?: CommandOutput;
  put?: CommandOutput;
  get?: CommandOutput;
  del?: CommandOutput;
}): { run: SmbRunner; argvLog: string[][]; envLog: (string | undefined)[] } {
  const argvLog: string[][] = [];
  const envLog: (string | undefined)[] = [];

  const run: SmbRunner = (argv, options) => {
    argvLog.push([...argv]);
    envLog.push(options.password);
    const joined = argv.join(' ');
    if (joined.includes('-L ')) {
      return Promise.resolve(steps.list ?? ok(LISTING_OK));
    }
    if (joined.includes(' du')) {
      return Promise.resolve(steps.connect ?? ok(DU_OK));
    }
    if (joined.includes('put ')) {
      return Promise.resolve(steps.put ?? ok('putting file'));
    }
    if (joined.includes('get ')) {
      return Promise.resolve(steps.get ?? ok('getting file'));
    }
    if (joined.includes('del ')) {
      return Promise.resolve(steps.del ?? ok(''));
    }
    return Promise.resolve(ok(''));
  };

  return { run, argvLog, envLog };
}

/** In-memory filesystem so the write probe's round-trip can be simulated exactly. */
function fakeFs(options: { corrupt?: boolean } = {}) {
  const files = new Map<string, string>();
  return {
    files,
    writeFile: (path: string, data: string) => {
      files.set(path, data);
      return Promise.resolve();
    },
    readFile: (_path: string, _encoding: 'utf8') => {
      if (options.corrupt === true) {
        return Promise.resolve('something else entirely\n');
      }
      // The probe writes `<token>.tmp` and reads back `<token>.back`; a healthy server
      // round-trips the bytes, which is what this mirrors.
      const source = [...files.entries()].find(([key]) => key.endsWith('.tmp'));
      return Promise.resolve(source?.[1] ?? '');
    },
    rm: (path: string, _options: { force: true }) => {
      files.delete(path);
      return Promise.resolve();
    },
  };
}

const baseDeps = {
  smbclientPath: '/usr/bin/smbclient',
  now: (() => {
    let t = 1000;
    return () => (t += 5);
  })(),
  tmpDir: '/tmp',
  randomToken: () => 'deadbeef',
};

// ---------------------------------------------------------------------------
// UNC parsing
// ---------------------------------------------------------------------------

describe('parseUnc', () => {
  it('splits host, share and sub-path', () => {
    expect(parseUnc('//fileserver/cnc$/programs/2026')).toEqual({
      host: 'fileserver',
      share: 'cnc$',
      path: 'programs/2026',
    });
  });

  it('accepts backslash form and normalises it', () => {
    expect(parseUnc('\\\\fileserver\\cnc$')).toEqual({
      host: 'fileserver',
      share: 'cnc$',
      path: '',
    });
  });

  it('reports an empty sub-path for a bare share', () => {
    expect(parseUnc('//srv/share').path).toBe('');
  });

  it('strips a trailing slash', () => {
    expect(parseUnc('//srv/share/sub/').path).toBe('sub');
  });

  it('rejects a path that is not a UNC', () => {
    expect(() => parseUnc('/mnt/local')).toThrow(/not a UNC/);
    expect(() => parseUnc('//hostonly')).toThrow(/not a UNC/);
  });
});

// ---------------------------------------------------------------------------
// Failure taxonomy — the point of the whole task
// ---------------------------------------------------------------------------

describe('classifyFailure', () => {
  it('distinguishes a wrong password from a wrong share name', () => {
    // The distinction T11 exists to provide. If these two collapse into one message,
    // the installer is back to guessing.
    expect(classifyFailure('session setup failed: NT_STATUS_LOGON_FAILURE').kind).toBe(
      'auth_failed',
    );
    expect(classifyFailure('tree connect failed: NT_STATUS_BAD_NETWORK_NAME').kind).toBe(
      'share_not_found',
    );
  });

  it('distinguishes a refused port from a silently dropped packet', () => {
    expect(classifyFailure('Error NT_STATUS_CONNECTION_REFUSED').kind).toBe('port_blocked');
    expect(classifyFailure('Error NT_STATUS_IO_TIMEOUT').kind).toBe('host_unreachable');
  });

  it.each([
    ['NT_STATUS_ACCOUNT_LOCKED_OUT', 'account_locked'],
    ['NT_STATUS_PASSWORD_EXPIRED', 'account_expired'],
    ['NT_STATUS_ACCOUNT_DISABLED', 'account_expired'],
    ['NT_STATUS_ACCESS_DENIED', 'access_denied'],
    ['NT_STATUS_TIME_DIFFERENCE_AT_DC', 'clock_skew'],
    ['Failed to resolve fileserver', 'name_resolution_failed'],
    ['NT_STATUS_INVALID_NETWORK_RESPONSE', 'protocol_negotiation_failed'],
    ['NT_STATUS_HOST_UNREACHABLE', 'host_unreachable'],
  ])('maps %s to %s', (output, expected) => {
    expect(classifyFailure(output).kind).toBe(expected);
  });

  it('prefers the account-state diagnosis over the generic access denial', () => {
    // A locked account can report both; the specific one is the actionable one.
    const output = 'NT_STATUS_ACCOUNT_LOCKED_OUT and also NT_STATUS_ACCESS_DENIED';
    expect(classifyFailure(output).kind).toBe('account_locked');
  });

  it('matches case-insensitively', () => {
    expect(classifyFailure('nt_status_logon_failure').kind).toBe('auth_failed');
  });

  it('falls back to unknown rather than mis-diagnosing', () => {
    const result = classifyFailure('something nobody has seen before');
    expect(result.kind).toBe('unknown');
    expect(result.remediation.en).toMatch(/bug report/);
  });

  it('gives every failure kind a non-empty message and remediation in both languages', () => {
    // A diagnosis with no advice attached is only half of what this task promises.
    for (const rule of FAILURE_RULES) {
      expect(rule.message.de.length).toBeGreaterThan(10);
      expect(rule.message.en.length).toBeGreaterThan(10);
      expect(rule.remediation.de.length).toBeGreaterThan(10);
      expect(rule.remediation.en.length).toBeGreaterThan(10);
      expect(rule.message.de).not.toBe(rule.message.en);
    }
  });
});

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

describe('parseShares', () => {
  it('lists disk shares and drops administrative ones', () => {
    expect(parseShares(LISTING_OK)).toEqual(['programs', 'tools']);
  });

  it('returns nothing when there is no share table', () => {
    expect(parseShares('NT_STATUS_ACCESS_DENIED')).toEqual([]);
  });

  it('stops at the blank line ending the table', () => {
    const output = `
	Sharename       Type      Comment
	---------       ----      -------
	one             Disk      x

	Server               Comment
	---------            -------
	OTHERBOX             not a share
`;
    expect(parseShares(output)).toEqual(['one']);
  });
});

describe('parseDialect', () => {
  it('reads the bracketed negotiated dialect and normalises SMB3_11', () => {
    expect(parseDialect('negotiated dialect[SMB3_11]')).toBe('SMB3.1.1');
  });

  it('accepts the alternative wording older builds print', () => {
    expect(parseDialect('Selected protocol [SMB3_00]')).toBe('SMB3_00');
  });

  it('returns null when the dialect is not stated', () => {
    // Diagnostic colour, not a value any decision depends on.
    expect(parseDialect('nothing here')).toBeNull();
  });
});

describe('parseAuthMethod', () => {
  it('detects NTLMSSP', () => {
    expect(parseAuthMethod('gensec backend ntlmssp selected')).toBe('NTLMSSP');
  });

  it('prefers Kerberos when both appear', () => {
    expect(parseAuthMethod('krb5 then ntlmssp')).toBe('Kerberos');
  });

  it('reports anonymous sessions', () => {
    expect(parseAuthMethod('Anonymous login successful')).toBe('Anonymous');
  });

  it('returns null when nothing is stated', () => {
    expect(parseAuthMethod('')).toBeNull();
  });
});

describe('parseFreeBytes', () => {
  it('multiplies available blocks by block size', () => {
    expect(parseFreeBytes(DU_OK)).toBe(40960 * 1048576);
  });

  it('returns null when the summary is absent', () => {
    expect(parseFreeBytes('no summary')).toBeNull();
  });
});

describe('parseSigning and parseEncryption', () => {
  it('reads a positive statement', () => {
    expect(parseSigning('signing: required')).toBe(true);
    expect(parseEncryption('encryption: on')).toBe(true);
  });

  it('reads a negative statement', () => {
    expect(parseSigning('signing: off')).toBe(false);
    expect(parseEncryption('encryption: disabled')).toBe(false);
  });

  it('returns null for silence rather than assuming off', () => {
    // "Not stated" and "off" are different claims, and conflating them would let the
    // UI report encryption as disabled on a server that never mentioned it.
    expect(parseSigning('')).toBeNull();
    expect(parseEncryption('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end
// ---------------------------------------------------------------------------

describe('testSmbConnection', () => {
  it('reports a structured success with dialect, shares, free space and writability', async () => {
    const { run } = scriptedRunner({});
    const result = await testSmbConnection(
      { unc: '//fileserver/programs', domain: 'WORK', username: 'svc', password: 'pw' },
      { ...baseDeps, run, fs: fakeFs() },
    );

    expect(result.success).toBe(true);
    expect(result.dialect).toBe('SMB3.1.1');
    expect(result.authMethod).toBe('NTLMSSP');
    expect(result.shares).toEqual(['programs', 'tools']);
    expect(result.freeBytes).toBe(40960 * 1048576);
    expect(result.writable).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('never puts the password in argv', async () => {
    // /proc/<pid>/cmdline is world-readable. This test is the guard on that.
    const { run, argvLog, envLog } = scriptedRunner({});
    await testSmbConnection(
      { unc: '//fileserver/programs', domain: 'WORK', username: 'svc', password: 'hunter2' },
      { ...baseDeps, run, fs: fakeFs() },
    );

    expect(argvLog.length).toBeGreaterThan(0);
    for (const argv of argvLog) {
      expect(argv.join(' ')).not.toContain('hunter2');
    }
    expect(envLog).toContain('hunter2');
  });

  it('passes the username as DOMAIN\\user', async () => {
    const { run, argvLog } = scriptedRunner({});
    await testSmbConnection(
      { unc: '//fileserver/programs', domain: 'WORK', username: 'svc', password: 'pw' },
      { ...baseDeps, run, fs: fakeFs() },
    );
    expect(argvLog[0]).toContain('WORK\\svc');
  });

  it('uses an anonymous session when no username is supplied', async () => {
    const { run, argvLog } = scriptedRunner({});
    await testSmbConnection(
      { unc: '//fileserver/programs' },
      { ...baseDeps, run, fs: fakeFs() },
    );
    expect(argvLog[0]).toContain('-N');
  });

  it('rejects a malformed UNC before running anything', async () => {
    const { run, argvLog } = scriptedRunner({});
    const result = await testSmbConnection(
      { unc: 'not-a-unc' },
      { ...baseDeps, run, fs: fakeFs() },
    );

    expect(result.success).toBe(false);
    expect(argvLog).toHaveLength(0);
    expect(result.message.de).toContain('UNC');
  });

  it('surfaces a wrong password from the listing phase with remediation', async () => {
    const { run } = scriptedRunner({
      list: fail('session setup failed: NT_STATUS_LOGON_FAILURE'),
    });
    const result = await testSmbConnection(
      { unc: '//fileserver/programs', username: 'svc', password: 'wrong' },
      { ...baseDeps, run, fs: fakeFs() },
    );

    expect(result.success).toBe(false);
    expect(result.failure).toBe('auth_failed');
    expect(result.remediation?.de).toBeTruthy();
    expect(result.remediation?.en).toContain('credentials');
  });

  it('reaches the connect phase to diagnose a wrong share name', async () => {
    // The listing succeeds — credentials are fine — and only the tree connect fails.
    // Separating the phases is exactly what makes this distinguishable.
    const { run } = scriptedRunner({
      connect: fail('tree connect failed: NT_STATUS_BAD_NETWORK_NAME'),
    });
    const result = await testSmbConnection(
      { unc: '//fileserver/typo', username: 'svc', password: 'pw' },
      { ...baseDeps, run, fs: fakeFs() },
    );

    expect(result.failure).toBe('share_not_found');
    // The share list is still reported, so the UI can show what does exist.
    expect(result.shares).toEqual(['programs', 'tools']);
  });

  it('reports a timeout as a dropped packet, not a refused port', async () => {
    const { run } = scriptedRunner({
      list: { stdout: '', stderr: '', code: -1, timedOut: true },
    });
    const result = await testSmbConnection(
      { unc: '//fileserver/programs' },
      { ...baseDeps, run, fs: fakeFs() },
    );

    expect(result.failure).toBe('host_unreachable');
    expect(result.message.en).toMatch(/did not answer/);
    expect(result.remediation?.en).toMatch(/DROP|VLAN/);
  });

  it('detects a read-only share that lists and connects but refuses writes', async () => {
    // Finding this at installation time rather than during the first push is the
    // difference between a config note and a support call.
    const { run } = scriptedRunner({ put: fail('NT_STATUS_ACCESS_DENIED') });
    const result = await testSmbConnection(
      { unc: '//fileserver/programs', username: 'svc', password: 'pw' },
      { ...baseDeps, run, fs: fakeFs() },
    );

    expect(result.success).toBe(false);
    expect(result.writable).toBe(false);
    expect(result.failure).toBe('access_denied');
  });

  it('detects content corrupted in transit by reading the file back', async () => {
    // An exit code of zero is not proof the right bytes landed; an antivirus product
    // that stubs the file returns success and stores something else.
    const { run } = scriptedRunner({});
    const result = await testSmbConnection(
      { unc: '//fileserver/programs', username: 'svc', password: 'pw' },
      { ...baseDeps, run, fs: fakeFs({ corrupt: true }) },
    );

    expect(result.success).toBe(false);
    expect(result.writable).toBe(false);
    expect(result.message.en).toMatch(/does not match/);
  });

  it('always deletes the remote probe file, even after a failed read-back', async () => {
    // Leaving `.tnc-bridge-probe-*` litter on a customer share erodes trust in
    // everything else the product claims to do.
    const { run, argvLog } = scriptedRunner({ get: fail('NT_STATUS_ACCESS_DENIED') });
    await testSmbConnection(
      { unc: '//fileserver/programs', username: 'svc', password: 'pw' },
      { ...baseDeps, run, fs: fakeFs() },
    );

    const deletions = argvLog.filter((argv) => argv.join(' ').includes('del '));
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.join(' ')).toContain('.tnc-bridge-probe-deadbeef');
  });

  it('probes inside the sub-path named by the UNC, where permissions may differ', async () => {
    const { run, argvLog } = scriptedRunner({});
    await testSmbConnection(
      { unc: '//fileserver/cnc$/programs/2026', username: 'svc', password: 'pw' },
      { ...baseDeps, run, fs: fakeFs() },
    );

    const put = argvLog.find((argv) => argv.join(' ').includes('put '));
    expect(put?.join(' ')).toContain('programs/2026/.tnc-bridge-probe-deadbeef');
  });

  it('skips the write probe when asked, leaving the test non-mutating', async () => {
    const { run, argvLog } = scriptedRunner({});
    const result = await testSmbConnection(
      { unc: '//fileserver/programs', username: 'svc', password: 'pw', probeWrite: false },
      { ...baseDeps, run, fs: fakeFs() },
    );

    expect(result.success).toBe(true);
    expect(result.writable).toBeNull();
    expect(argvLog.some((argv) => argv.join(' ').includes('put '))).toBe(false);
  });

  it('requests the dialect the share is configured for', async () => {
    const { run, argvLog } = scriptedRunner({});
    await testSmbConnection(
      { unc: '//fileserver/programs', smbVersion: '3.0' },
      { ...baseDeps, run, fs: fakeFs() },
    );
    expect(argvLog[0]?.join(' ')).toContain('client max protocol=SMB3_00');
  });

  it('asks for encryption unless sealing is explicitly disabled', async () => {
    const { run, argvLog } = scriptedRunner({});
    await testSmbConnection(
      { unc: '//fileserver/programs', seal: false },
      { ...baseDeps, run, fs: fakeFs() },
    );
    expect(argvLog[0]?.join(' ')).not.toContain('smb encrypt');

    const second = scriptedRunner({});
    await testSmbConnection(
      { unc: '//fileserver/programs' },
      { ...baseDeps, run: second.run, fs: fakeFs() },
    );
    expect(second.argvLog[0]?.join(' ')).toContain('smb encrypt=desired');
  });

  it('never negotiates SMB1 on the LAN side', async () => {
    // The product exists to remove SMB1 from the corporate network. Offering it here
    // would be self-defeating.
    const { run, argvLog } = scriptedRunner({});
    await testSmbConnection(
      { unc: '//fileserver/programs' },
      { ...baseDeps, run, fs: fakeFs() },
    );
    expect(argvLog[0]?.join(' ')).toContain('client min protocol=SMB2');
  });
});
