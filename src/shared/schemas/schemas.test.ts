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
    // LANMAN is not a setting any more: it is a lookup table rather than encryption,
    // and every SMB1 control this bridge exists for speaks NTLM.
    expect('lanmanAuth' in smb.tnc).toBe(false);
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

  it('allows one interface when 802.1Q keeps the two segments apart', () => {
    // A single-NIC bridge is a legitimate deployment as long as the machine segment is
    // tagged onto its own VLAN; that is what stops SMB1 reaching the corporate LAN.
    const result = networkConfigSchema.safeParse({
      lan: { interface: 'eth0', vlan: 10 },
      tnc: { interface: 'eth0', vlan: 20 },
    });
    expect(result.success).toBe(true);
  });

  it('still refuses one interface when both sides carry the same VLAN', () => {
    const result = networkConfigSchema.safeParse({
      lan: { interface: 'eth0', vlan: 10 },
      tnc: { interface: 'eth0', vlan: 10 },
    });
    expect(result.success).toBe(false);
  });

  it('still refuses one interface when only one side is tagged', () => {
    const result = networkConfigSchema.safeParse({
      lan: { interface: 'eth0', vlan: 10 },
      tnc: { interface: 'eth0' },
    });
    expect(result.success).toBe(false);
  });

  it('requires an address for a static TNC side but not a gateway', () => {
    // The bridge is the gateway on the machine segment, so asking for one would be
    // asking the operator to point it at this device.
    expect(networkConfigSchema.safeParse({ tnc: { method: 'static' } }).success).toBe(true);
    expect(
      networkConfigSchema.safeParse({ tnc: { method: 'static', address: undefined } }).success,
    ).toBe(true);
  });

  it('defaults each side independently', () => {
    const parsed = networkConfigSchema.parse({});
    expect(parsed.lan).toMatchObject({ method: 'dhcp', vlan: null, mtu: 1500, ipv6: false });
    expect(parsed.tnc).toMatchObject({ method: 'static', address: '192.168.42.1/24', mtu: 1500 });
  });

  it('accepts a jumbo-frame LAN alongside a standard TNC segment', () => {
    // The case the old single global MTU could not express at all.
    const result = networkConfigSchema.safeParse({
      lan: { method: 'dhcp', mtu: 9000 },
      tnc: { mtu: 1500 },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.lan.mtu).toBe(9000);
  });

  it('takes at most two resolvers per side', () => {
    expect(networkConfigSchema.safeParse({ lan: { dns: ['1.1.1.1', '9.9.9.9'] } }).success).toBe(
      true,
    );
    expect(
      networkConfigSchema.safeParse({ lan: { dns: ['1.1.1.1', '9.9.9.9', '8.8.8.8'] } }).success,
    ).toBe(false);
  });

  it('bounds the VLAN id to the 802.1Q range', () => {
    expect(networkConfigSchema.safeParse({ lan: { vlan: 1 } }).success).toBe(true);
    expect(networkConfigSchema.safeParse({ lan: { vlan: 4094 } }).success).toBe(true);
    expect(networkConfigSchema.safeParse({ lan: { vlan: 0 } }).success).toBe(false);
    expect(networkConfigSchema.safeParse({ lan: { vlan: 4095 } }).success).toBe(false);
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
