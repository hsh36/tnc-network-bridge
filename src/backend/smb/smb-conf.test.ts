import {
  assertSafeConfig,
  assertSmbBoundTo,
  AUDIT_VERBS,
  buildSmbConf,
  DEFAULT_VETO_FILES,
  normaliseKey,
  parseListeningSockets,
  parseSmbConf,
  renderSmbConf,
  sanitiseValue,
  type SmbConfInput,
  SmbConfError,
} from './smb-conf';

const BASE: SmbConfInput = {
  tncInterface: 'eth1',
  lanInterface: 'eth0',
  shares: [{ name: 'programs', path: '/srv/tnc/programs' }],
};

const build = (overrides: Partial<SmbConfInput> = {}): string =>
  buildSmbConf({ ...BASE, ...overrides });

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('renderSmbConf', () => {
  it('binds the listener to the TNC interface only', () => {
    // The single most important pair of lines in the product.
    const content = build();
    expect(content).toContain('interfaces = eth1');
    expect(content).toContain('bind interfaces only = yes');
  });

  it('sets NT1 as the protocol floor so an iTNC 530 can connect', () => {
    expect(build()).toContain('server min protocol = NT1');
  });

  it('lets modern controls negotiate up to SMB3 on the same listener', () => {
    expect(build()).toContain('server max protocol = SMB3');
    expect(build({ maxProtocol: 'NT1' })).toContain('server max protocol = NT1');
  });

  it('enables NTLM and disables signing, which NT1 clients cannot do', () => {
    const content = build();
    expect(content).toContain('ntlm auth = yes');
    expect(content).toContain('server signing = disabled');
  });

  it('never enables lanman auth, whatever is asked of it', () => {
    // R2: some very old controls need it. It is off by default and opt-in only.
    // Not written at all. Samba has defaulted it off since 4.0 and now warns that the
    // option is deprecated, so naming it produced a warning on every smbclient and
    // testparm call for a value that was already the default.
    expect(build({})).not.toMatch(/^\s*lanman auth/m);
    expect(build({})).not.toMatch(/^\s*client lanman auth/m);
  });

  it('uses CP850 for the DOS charset', () => {
    // R7: a mismatch mangles every umlaut in a filename.
    expect(build()).toContain('dos charset = CP850');
    expect(build()).toContain('unix charset = UTF-8');
  });

  it('keeps NetBIOS enabled for the iTNC 530', () => {
    expect(build()).toContain('disable netbios = no');
  });

  it('audits exactly the eight verbs the lock manager consumes', () => {
    const content = build();
    expect(content).toContain(`full_audit:success = ${AUDIT_VERBS.join(' ')}`);
    // R16: failures are not logged at all, or a busy share fills the disk.
    expect(content).toContain('full_audit:failure = none');
    expect(content).toContain('full_audit:facility = LOCAL5');
    expect(content).toContain('full_audit:prefix = %I|%u|%S');
  });

  it('vetoes temp files, sidecar locks and the version store', () => {
    const content = build();
    for (const pattern of DEFAULT_VETO_FILES) {
      expect(content).toContain(pattern);
    }
  });

  it('accepts extra veto patterns per share', () => {
    const content = build({
      shares: [{ name: 'programs', path: '/srv/tnc/programs', extraVetoFiles: ['*.bak'] }],
    });
    expect(content).toContain('*.bak');
  });

  it('renders one section per share', () => {
    const content = build({
      shares: [
        { name: 'programs', path: '/srv/tnc/programs' },
        { name: 'tools', path: '/srv/tnc/tools' },
      ],
    });
    expect(content).toContain('[programs]');
    expect(content).toContain('[tools]');
    expect(content).toContain('path = /srv/tnc/programs');
    expect(content).toContain('path = /srv/tnc/tools');
  });

  it('marks a share read-only when the failover controller says so', () => {
    const content = build({ globalReadOnly: true });
    expect(content).toContain('read only = yes');
  });

  it('marks a single share read-only without affecting the others', () => {
    const content = build({
      shares: [
        { name: 'programs', path: '/srv/tnc/programs', readOnly: true },
        { name: 'tools', path: '/srv/tnc/tools' },
      ],
    });
    const programs = content.slice(content.indexOf('[programs]'), content.indexOf('[tools]'));
    const tools = content.slice(content.indexOf('[tools]'));
    expect(programs).toContain('read only = yes');
    expect(tools).toContain('read only = no');
  });

  it('emits valid users only when the list is non-empty', () => {
    expect(build()).not.toContain('valid users');
    const content = build({
      shares: [{ name: 'programs', path: '/srv/tnc/programs', validUsers: ['tnc', 'ops'] }],
    });
    expect(content).toContain('valid users = tnc ops');
  });

  it('produces a safely-bound config even with no shares configured yet', () => {
    // The wizard must be able to finish before any share exists.
    const content = build({ shares: [] });
    expect(content).toContain('bind interfaces only = yes');
    expect(() => assertSafeConfig(content, { tncInterface: 'eth1' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

describe('sanitiseValue', () => {
  it('rejects a newline, which would inject a directive', () => {
    // A comment of "NC programs\n  interfaces = eth0 eth1" would otherwise append a
    // real global directive and undo the interface binding.
    expect(() => sanitiseValue('a\nb', 'comment')).toThrow(SmbConfError);
    expect(() => sanitiseValue('a\rb', 'comment')).toThrow(/line break/);
    expect(() => sanitiseValue('a\0b', 'comment')).toThrow();
  });

  it('trims but otherwise preserves the value', () => {
    expect(sanitiseValue('  NC Programme (Halle 2)  ', 'comment')).toBe('NC Programme (Halle 2)');
  });
});

describe('injection resistance', () => {
  it('refuses a share comment carrying a second directive', () => {
    expect(() =>
      build({
        shares: [
          {
            name: 'programs',
            path: '/srv/tnc/programs',
            comment: 'nice\n  interfaces = eth0 eth1',
          },
        ],
      }),
    ).toThrow(SmbConfError);
  });

  it('refuses a server string carrying a line break', () => {
    expect(() => build({ serverString: 'bridge\nbind interfaces only = no' })).toThrow(
      SmbConfError,
    );
  });

  it('does not HTML-escape ampersands and dollars in values', () => {
    // noEscape is deliberate: this is an INI file. Escaping would corrupt real values.
    const content = build({ serverString: 'R&D $tuff' });
    expect(content).toContain('R&D $tuff');
    expect(content).not.toContain('&amp;');
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('input validation', () => {
  it('rejects a share name outside the allowed pattern', () => {
    expect(() => build({ shares: [{ name: 'bad name!', path: '/srv/tnc/x' }] })).toThrow(
      /share name/,
    );
  });

  it('rejects a share path outside the cache root', () => {
    // Samba would otherwise serve a directory the bridge does not manage.
    expect(() => build({ shares: [{ name: 'etc', path: '/etc' }] })).toThrow(/outside/);
  });

  it('rejects a traversal segment in a share path', () => {
    expect(() => build({ shares: [{ name: 'x', path: '/srv/tnc/../../etc' }] })).toThrow(
      SmbConfError,
    );
  });

  it('rejects duplicate share sections', () => {
    // Samba silently keeps the last of two identically-named sections.
    expect(() =>
      build({
        shares: [
          { name: 'programs', path: '/srv/tnc/programs' },
          { name: 'PROGRAMS', path: '/srv/tnc/other' },
        ],
      }),
    ).toThrow(/duplicate/);
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseSmbConf', () => {
  it('normalises parameter names the way Samba does', () => {
    // Security-relevant: a validator comparing raw strings would read
    // "bindinterfacesonly = no" as "parameter not specified" while Samba honours it.
    expect(normaliseKey('Bind Interfaces Only')).toBe('bindinterfacesonly');
    expect(normaliseKey('bindinterfacesonly')).toBe('bindinterfacesonly');

    const parsed = parseSmbConf('[global]\n  BindInterfacesOnly = yes\n');
    expect(parsed.sections.get('global')?.get('bindinterfacesonly')).toBe('yes');
  });

  it('ignores comments and blank lines', () => {
    const parsed = parseSmbConf('# comment\n; other\n\n[global]\n  a = 1\n');
    expect(parsed.sections.get('global')?.get('a')).toBe('1');
  });

  it('keeps values containing an equals sign intact', () => {
    const parsed = parseSmbConf('[global]\n  full_audit:prefix = %I|%u=x|%S\n');
    expect(parsed.sections.get('global')?.get('full_audit:prefix')).toBe('%I|%u=x|%S');
  });

  it('lower-cases section names', () => {
    const parsed = parseSmbConf('[Programs]\n path = /srv/tnc/programs\n');
    expect(parsed.sections.has('programs')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Safety assertions — the security control
// ---------------------------------------------------------------------------

describe('assertSafeConfig', () => {
  const options = { tncInterface: 'eth1', lanInterface: 'eth0' };

  it('accepts a config generated by this module', () => {
    expect(() => assertSafeConfig(build(), options)).not.toThrow();
  });

  it('refuses a config that binds the LAN interface', () => {
    // The condition the whole product exists to prevent.
    const bad = build().replace('interfaces = eth1', 'interfaces = eth1 eth0');
    expect(() => assertSafeConfig(bad, options)).toThrow(/LAN interface/);
  });

  it('refuses a config with no interfaces line at all', () => {
    const bad = build().replace('interfaces = eth1', 'interfaces =');
    expect(() => assertSafeConfig(bad, options)).toThrow(/empty/);
  });

  it('refuses a config missing the TNC interface', () => {
    const bad = build().replace('interfaces = eth1', 'interfaces = eth2');
    expect(() => assertSafeConfig(bad, options)).toThrow(/does not include the TNC interface/);
  });

  it('refuses any unexpected extra interface, including a wildcard', () => {
    const bad = build().replace('interfaces = eth1', 'interfaces = eth1 0.0.0.0/0');
    expect(() => assertSafeConfig(bad, options)).toThrow(/unexpected entries/);
  });

  it('permits loopback alongside the TNC interface', () => {
    const ok = build().replace('interfaces = eth1', 'interfaces = lo eth1');
    expect(() => assertSafeConfig(ok, options)).not.toThrow();
  });

  it('refuses a config where bind interfaces only is off', () => {
    const bad = build().replace('bind interfaces only = yes', 'bind interfaces only = no');
    expect(() => assertSafeConfig(bad, options)).toThrow(/bind interfaces only/);
  });

  it('catches the whitespace-collapsed spelling of that parameter', () => {
    // The bypass a naive validator would miss.
    const bad = build().replace('bind interfaces only = yes', 'bindinterfacesonly = no');
    expect(() => assertSafeConfig(bad, options)).toThrow(/bind interfaces only/);
  });

  it('refuses a config whose protocol floor is above NT1', () => {
    const bad = build().replace('server min protocol = NT1', 'server min protocol = SMB2');
    expect(() => assertSafeConfig(bad, options)).toThrow(/expected NT1/);
  });

  it('refuses a config enabling wide links', () => {
    const bad = build().replace('wide links = no', 'wide links = yes');
    expect(() => assertSafeConfig(bad, options)).toThrow(/wide links/);
  });

  it('refuses a share exporting a path outside the cache root', () => {
    const bad = build().replace('path = /srv/tnc/programs', 'path = /etc');
    expect(() => assertSafeConfig(bad, options)).toThrow(/outside/);
  });

  it('refuses a share that does not veto in-flight temp files', () => {
    const bad = build().replace(/veto files = .*/g, 'veto files = /nothing/');
    expect(() => assertSafeConfig(bad, options)).toThrow(/half-written/);
  });

  it('reports every violation at once rather than one per attempt', () => {
    // An operator fixing a config one error at a time is an operator who reboots the
    // shop floor five times.
    const bad = build()
      .replace('interfaces = eth1', 'interfaces = eth0')
      .replace('bind interfaces only = yes', 'bind interfaces only = no')
      .replace('server min protocol = NT1', 'server min protocol = SMB3');

    const error: unknown = (() => {
      try {
        assertSafeConfig(bad, options);
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();

    const message = (error as Error).message;
    expect(message).toMatch(/LAN interface/);
    expect(message).toMatch(/bind interfaces only/);
    expect(message).toMatch(/NT1/);
  });

  it('is enforced by buildSmbConf, so an unsafe config cannot be obtained', () => {
    // renderSmbConf alone can produce anything its input asks for; buildSmbConf is the
    // door everyone else uses, and the assertion is behind it.
    const rendered = renderSmbConf({ ...BASE, tncInterface: 'eth1' });
    expect(rendered).toContain('interfaces = eth1');
    expect(() => buildSmbConf({ ...BASE, lanInterface: 'eth1' })).toThrow(/LAN interface/);
  });
});

// ---------------------------------------------------------------------------
// Runtime listener verification
// ---------------------------------------------------------------------------

describe('parseListeningSockets', () => {
  it('parses ss -H -ltn output', () => {
    const output = [
      'LISTEN 0      50     192.168.42.1:445        0.0.0.0:*',
      'LISTEN 0      50     192.168.42.1:139        0.0.0.0:*',
      'LISTEN 0      511          0.0.0.0:443       0.0.0.0:*',
    ].join('\n');

    expect(parseListeningSockets(output)).toEqual([
      { address: '192.168.42.1', port: 445 },
      { address: '192.168.42.1', port: 139 },
      { address: '0.0.0.0', port: 443 },
    ]);
  });

  it('unwraps bracketed IPv6 addresses', () => {
    expect(parseListeningSockets('LISTEN 0 50 [::1]:445 [::]:*')).toEqual([
      { address: '::1', port: 445 },
    ]);
  });

  it('ignores blank and malformed lines', () => {
    expect(parseListeningSockets('\n\ngarbage\n')).toEqual([]);
  });
});

describe('assertSmbBoundTo', () => {
  it('accepts SMB bound to the TNC address only', () => {
    expect(() =>
      assertSmbBoundTo(
        [
          { address: '192.168.42.1', port: 445 },
          { address: '192.168.42.1', port: 139 },
        ],
        ['192.168.42.1'],
      ),
    ).not.toThrow();
  });

  it('rejects SMB listening on the LAN address', () => {
    // The assertion the AC calls for: smbd on the TNC interface ONLY.
    expect(() => assertSmbBoundTo([{ address: '10.0.0.5', port: 445 }], ['192.168.42.1'])).toThrow(
      /outside the TNC network/,
    );
  });

  it('rejects a wildcard bind, which includes the LAN address by definition', () => {
    expect(() => assertSmbBoundTo([{ address: '0.0.0.0', port: 445 }], ['192.168.42.1'])).toThrow(
      /0\.0\.0\.0:445/,
    );
  });

  it('rejects an IPv6 wildcard bind', () => {
    expect(() => assertSmbBoundTo([{ address: '::', port: 139 }], ['192.168.42.1'])).toThrow();
  });

  it('ignores non-SMB ports such as the management UI on 443', () => {
    expect(() =>
      assertSmbBoundTo([{ address: '0.0.0.0', port: 443 }], ['192.168.42.1']),
    ).not.toThrow();
  });
});
