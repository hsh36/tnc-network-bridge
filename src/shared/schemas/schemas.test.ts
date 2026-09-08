import {
  configSectionSchemas,
  createShareRequestSchema,
  bridgeEventSchema,
  fileIndexEntrySchema,
  loginRequestSchema,
  networkConfigSchema,
  relPathSchema,
  smbConfigSchema,
  uncPathSchema,
} from './index';

describe('configuration defaults', () => {
  /**
   * These are the values a fresh install boots with. They are transcribed from
   * IMPLEMENTATION_PLAN §6, so a silent drift in a default is a test failure rather
   * than a support call six months later.
   */
  it('matches §6 for the sync section', () => {
    expect(configSectionSchemas.sync.parse({})).toEqual({
      conflictMode: 'last_write_wins',
      mtimeToleranceMs: 2000,
      scanIntervalMs: 15_000,
      concurrency: 4,
      bandwidthLimitKbps: null,
      protectDeletes: true,
      excludePatterns: ['**/.DS_Store', '**/Thumbs.db', '**/~$*', '**/.tnc-tmp-*'],
      failoverReadOnly: true,
      maxFileSizeMb: 512,
      // T40's advanced policies. Empty on a fresh install: every one of these changes
      // what syncs or how fast, so none of them may be on by default.
      policies: {
        bandwidthWindows: [],
        priorityRules: [],
        excludeRules: [],
        readOnlyRules: [],
      },
    });
  });

  it('matches §6 for the locking section, with schedules off by default', () => {
    expect(configSectionSchemas.locking.parse({})).toEqual({
      enabled: true,
      serverProjection: 'sidecar',
      tncLockTtlS: 900,
      releaseLingerS: 5,
      scheduleDefault: 'none',
      blockPullWhenLocked: true,
    });
  });

  it('matches §6 for the security section', () => {
    expect(configSectionSchemas.security.parse({})).toEqual({
      sessionIdleMin: 30,
      sessionAbsoluteH: 12,
      loginMaxAttempts: 5,
      fail2banEnabled: true,
      firewallDefault: 'allow',
      tlsMin: 'TLSv1.2',
    });
  });

  it('matches §6 for the updates section', () => {
    expect(configSectionSchemas.updates.parse({})).toEqual({
      enabled: true,
      channel: 'stable',
      scheduleCron: '0 3 * * 0',
      autoRestart: true,
      githubRepo: 'hsh36/tnc-network-bridge',
      rollbackOnFailure: true,
      healthTimeoutS: 120,
    });
  });

  it('defaults the TNC side to NT1 — the entire point of the product', () => {
    const smb = smbConfigSchema.parse({});
    expect(smb.tnc.minProtocol).toBe('NT1');
    expect(smb.tnc.dosCharset).toBe('CP850');
    expect(smb.tnc.lanmanAuth).toBe(false);
    expect(smb.server.minProtocol).toBe('SMB3_11');
    expect(smb.server.seal).toBe(true);
  });

  it('defaults DHCP to off with the documented range', () => {
    const dhcp = configSectionSchemas.dhcp.parse({});
    expect(dhcp.enabled).toBe(false);
    expect(dhcp.range).toBe('192.168.42.100-192.168.42.199');
    expect(dhcp.leaseTime).toBe('12h');
  });

  it('parses every section from an empty object', () => {
    for (const [name, schema] of Object.entries(configSectionSchemas)) {
      expect(schema.safeParse({}).success).toBe(true);
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe('network configuration cross-field rules', () => {
  it('rejects a static LAN configuration with no address', () => {
    const result = networkConfigSchema.safeParse({ lan: { method: 'static' } });
    expect(result.success).toBe(false);
  });

  it('accepts a static LAN configuration that is complete', () => {
    const result = networkConfigSchema.safeParse({
      lan: { method: 'static', address: '10.0.0.5/24', gateway: '10.0.0.1' },
    });
    expect(result.success).toBe(true);
  });

  it('refuses to put both legs on one interface', () => {
    // Bridging the machine segment onto the LAN NIC would expose SMB1 to the LAN,
    // which is precisely the exposure this product exists to remove.
    const result = networkConfigSchema.safeParse({
      lan: { interface: 'eth0' },
      tnc: { interface: 'eth0' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a TNC address that is not CIDR-qualified', () => {
    expect(networkConfigSchema.safeParse({ tnc: { address: '192.168.42.1' } }).success).toBe(false);
  });
});

describe('relPathSchema', () => {
  it.each(['programs/part1.h', 'a.nc', 'deep/nested/folder/file.H', 'file with spaces.nc'])(
    'accepts %s',
    (p) => {
      expect(relPathSchema.safeParse(p).success).toBe(true);
    },
  );

  it.each([
    ['../etc/passwd', 'parent traversal'],
    ['programs/../../etc/passwd', 'traversal in the middle'],
    ['/etc/passwd', 'absolute'],
    ['C:/Windows/System32', 'drive qualified'],
    ['programs\\part1.h', 'backslash'],
    ['programs/\0hidden', 'NUL byte'],
    ['', 'empty'],
  ])('rejects %s (%s)', (p) => {
    expect(relPathSchema.safeParse(p).success).toBe(false);
  });

  it('allows a filename that merely starts with dots', () => {
    expect(relPathSchema.safeParse('..hidden.nc').success).toBe(true);
  });
});

describe('uncPathSchema', () => {
  it.each(['//fileserver/cnc$/programs', '//10.0.0.5/share', '//srv.example.com/a/b/c'])(
    'accepts %s',
    (p) => {
      expect(uncPathSchema.safeParse(p).success).toBe(true);
    },
  );

  it.each(['\\\\fileserver\\share', '/fileserver/share', 'fileserver/share', '//fileserver'])(
    'rejects %s',
    (p) => {
      expect(uncPathSchema.safeParse(p).success).toBe(false);
    },
  );
});

describe('createShareRequestSchema', () => {
  it('rejects unknown keys rather than silently dropping them', () => {
    const result = createShareRequestSchema.safeParse({
      name: 'programs',
      serverUnc: '//srv/share',
      mountPoint: '/tmp/anywhere',
    });
    expect(result.success).toBe(false);
  });

  it('does not let a caller choose the mount point or cache path', () => {
    const shape = Object.keys(createShareRequestSchema.shape);
    expect(shape).not.toContain('mountPoint');
    expect(shape).not.toContain('cachePath');
  });

  it('fills the documented defaults', () => {
    const parsed = createShareRequestSchema.parse({
      name: 'programs',
      serverUnc: '//srv/share',
    });
    expect(parsed.conflictMode).toBe('last_write_wins');
    expect(parsed.smbVersion).toBe('3.1.1');
    expect(parsed.maxFileSizeMb).toBe(512);
  });

  it.each(['with space', '../escape', 'a'.repeat(33), 'semi;colon'])(
    'rejects the unsafe share name %s',
    (name) => {
      expect(createShareRequestSchema.safeParse({ name, serverUnc: '//srv/share' }).success).toBe(
        false,
      );
    },
  );
});

describe('fileIndexEntrySchema', () => {
  it('treats an absent side as null rather than missing', () => {
    const entry = fileIndexEntrySchema.parse({
      id: 1,
      shareId: 1,
      relPath: 'a.nc',
      isDir: false,
      local: { size: 10, mtime: 1_700_000_000_000, hash: null },
      remote: null,
      base: null,
      state: 'pending_push',
      lastSyncAt: null,
      lastError: null,
      retryCount: 0,
      nextRetryAt: null,
    });
    expect(entry.remote).toBeNull();
    expect(entry.local?.hash).toBeNull();
  });

  it('rejects an unknown reconciliation state', () => {
    const result = fileIndexEntrySchema.safeParse({
      id: 1,
      shareId: 1,
      relPath: 'a.nc',
      isDir: false,
      local: null,
      remote: null,
      base: null,
      state: 'probably_fine',
      lastSyncAt: null,
      lastError: null,
      retryCount: 0,
      nextRetryAt: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('bridgeEventSchema', () => {
  it('discriminates on type', () => {
    const parsed = bridgeEventSchema.parse({ type: 'heartbeat', ts: 1_700_000_000_000 });
    expect(parsed.type).toBe('heartbeat');
  });

  it('rejects an unknown event type', () => {
    expect(bridgeEventSchema.safeParse({ type: 'nope', ts: 1 }).success).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('rejects extra fields', () => {
    expect(
      loginRequestSchema.safeParse({ username: 'admin', password: 'x', role: 'root' }).success,
    ).toBe(false);
  });
});
