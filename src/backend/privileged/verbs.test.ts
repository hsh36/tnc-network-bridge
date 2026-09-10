import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ALLOWED_SERVICES,
  assertNoMetacharacters,
  cachePathFor,
  isPrivilegedVerb,
  mountPointFor,
  PRIVILEGED_VERBS,
  PrivilegedValidationError,
  ROOTS,
  validateInterfaceName,
  validateIpAddress,
  validatePathWithin,
  validateRequest,
  validateServerUnc,
  validateService,
  validateShareName,
  validateVersion,
  type ValidateOptions,
} from './verbs';

/**
 * The argument-validation layer is the product's security boundary. These tests are
 * written adversarially: for every verb, take a request that is known good, corrupt one
 * field with something an attacker would actually send, and require a rejection.
 *
 * A passing suite here is the evidence that a web-tier RCE cannot become root.
 */

const INTERFACES = ['lo', 'eth0', 'eth1'];
const OPTIONS: ValidateOptions = { listInterfaces: () => INTERFACES };

/**
 * The payloads. Each targets a different escape an attacker would try:
 * shell metacharacters (if a shell were ever reached), path traversal, absolute-path
 * escape from a jailed root, and NUL truncation against C string handling.
 */
const INJECTION_PAYLOADS: readonly [string, string][] = [
  ['command chain', '; rm -rf /'],
  ['command substitution', '$(whoami)'],
  ['backtick substitution', '`id`'],
  ['pipe', '| sh'],
  ['and chain', '&& cat /etc/shadow'],
  ['background', '& id'],
  ['redirect', '> /etc/passwd'],
  ['relative traversal', '../../etc/passwd'],
  ['absolute path', '/etc/passwd'],
  ['newline', 'valid\nrm -rf /'],
  ['NUL truncation', 'valid\u0000/etc/passwd'],
  ['glob', '*'],
  ['appended traversal', 'share/../../../root'],
];

const VALID_REQUESTS = {
  'mount-share': {
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
  },
  'unmount-share': { verb: 'unmount-share', shareName: 'werkstatt', force: false },
  'reload-samba': { verb: 'reload-samba', mode: 'reload' },
  'write-samba-config': {
    verb: 'write-samba-config',
    content: '[global]\n  workgroup = WORKGROUP\n',
  },
  'write-dnsmasq-config': {
    verb: 'write-dnsmasq-config',
    content: 'interface=eth1\ndhcp-range=192.168.42.50,192.168.42.100,12h\n',
    enabled: true,
  },
  'apply-network': {
    verb: 'apply-network',
    interface: 'eth0',
    method: 'static',
    address: '192.168.1.5/24',
    gateway: '192.168.1.1',
    dns: ['192.168.1.1'],
    mtu: 1500,
    ipv6Enabled: false,
    revertAfterSeconds: 60,
  },
  'write-nft-ruleset': {
    verb: 'write-nft-ruleset',
    content: 'table inet filter {\n  chain input { type filter hook input priority 0; }\n}\n',
  },
  'fail2ban-unban': { verb: 'fail2ban-unban', ip: '10.4.0.31', jail: 'tnc-bridge' },
  'install-cert': {
    verb: 'install-cert',
    certPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    keyPem: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
  },
  'service-restart': { verb: 'service-restart', service: 'tnc-bridge', action: 'restart' },
  'apply-update': { verb: 'apply-update', version: 'v0.1.0' },
  'self-update': {
    verb: 'self-update',
    targetRef: 'v0.2.0',
    previousRef: 'v0.1.0',
    healthTimeoutSeconds: 120,
  },
  'os-update': { verb: 'os-update', reboot: false },
  'set-samba-user': {
    verb: 'set-samba-user',
    username: 'tnc-werkstatt',
    password: 'a-password',
    remove: false,
  },
} as const;

/** Fields a caller controls that must never accept a hostile value. */
const INJECTABLE_FIELDS: Record<string, readonly string[]> = {
  'mount-share': ['shareName', 'serverUnc', 'domain', 'username'],
  'unmount-share': ['shareName'],
  'reload-samba': ['mode'],
  'write-samba-config': [],
  'write-dnsmasq-config': [],
  'apply-network': ['interface', 'address', 'gateway'],
  'write-nft-ruleset': [],
  'fail2ban-unban': ['ip', 'jail'],
  'install-cert': ['certPem', 'keyPem'],
  'service-restart': ['service', 'action'],
  'apply-update': ['version'],
  'self-update': ['targetRef', 'previousRef'],
  // `reboot` is a boolean; there is no string for a payload to hide in.
  'os-update': [],
  // The password is not listed: it reaches smbpasswd on stdin and is never an argv
  // element, so a metacharacter in it has nothing to escape into.
  'set-samba-user': ['username'],
};

describe('the verb allowlist', () => {
  it('contains exactly the fourteen verbs of ARCHITECTURE §5.4', () => {
    expect(PRIVILEGED_VERBS).toHaveLength(14);
    expect([...PRIVILEGED_VERBS]).toEqual([
      'mount-share',
      'unmount-share',
      'reload-samba',
      'write-samba-config',
      'write-dnsmasq-config',
      'apply-network',
      'write-nft-ruleset',
      'fail2ban-unban',
      'install-cert',
      'service-restart',
      'apply-update',
      'self-update',
      'os-update',
      'set-samba-user',
    ]);
  });

  it('has a known-good fixture for every verb, so no verb goes untested', () => {
    expect(Object.keys(VALID_REQUESTS).sort()).toEqual([...PRIVILEGED_VERBS].sort());
    expect(Object.keys(INJECTABLE_FIELDS).sort()).toEqual([...PRIVILEGED_VERBS].sort());
  });

  it.each([
    'mount',
    'exec',
    'shell',
    'MOUNT-SHARE',
    'mount-share ',
    'mount-share; id',
    '../mount-share',
    '',
    '__proto__',
    'constructor',
  ])('rejects the unknown verb %p', (verb) => {
    expect(isPrivilegedVerb(verb)).toBe(false);
    expect(() => validateRequest({ verb }, OPTIONS)).toThrow(PrivilegedValidationError);
  });

  it.each([[null], [undefined], ['a string'], [42], [[]], [['mount-share']]])(
    'rejects a non-object request (%p)',
    (raw) => {
      expect(() => validateRequest(raw, OPTIONS)).toThrow(/must be a JSON object/);
    },
  );

  it('rejects a request with no verb at all', () => {
    expect(() => validateRequest({ shareName: 'werkstatt' }, OPTIONS)).toThrow(
      PrivilegedValidationError,
    );
  });
});

describe('every verb accepts its known-good request', () => {
  it.each(PRIVILEGED_VERBS)('%s', (verb) => {
    const request = validateRequest({ ...VALID_REQUESTS[verb] }, OPTIONS);
    expect(request.verb).toBe(verb);
  });
});

/**
 * The core matrix: 14 verbs × their controllable fields × 13 payloads.
 *
 * Every combination must throw. A single silent acceptance here is a root compromise,
 * which is why this is exhaustive rather than representative.
 */
describe('injection payloads are rejected, per verb and per field', () => {
  for (const verb of PRIVILEGED_VERBS) {
    const fields = INJECTABLE_FIELDS[verb] ?? [];
    if (fields.length === 0) {
      continue;
    }
    describe(verb, () => {
      for (const field of fields) {
        it.each(INJECTION_PAYLOADS)(`rejects ${field} containing a %s`, (_label, payload) => {
          const request: Record<string, unknown> = { ...VALID_REQUESTS[verb], [field]: payload };
          expect(() => validateRequest(request, OPTIONS)).toThrow(PrivilegedValidationError);
        });
      }
    });
  }
});

/**
 * The three verbs whose payload is a config-file body genuinely accept arbitrary text —
 * an `smb.conf` contains semicolons and an nft ruleset contains braces. Their safety
 * comes from elsewhere: the destination path is a constant the caller cannot influence,
 * the content is syntax-checked before activation, and a NUL byte (which would truncate
 * the file at the C layer) is still refused.
 */
describe('config-body verbs are bounded even though their content is free-form', () => {
  const bodyVerbs = ['write-samba-config', 'write-dnsmasq-config', 'write-nft-ruleset'] as const;

  it.each(bodyVerbs)('%s rejects a NUL byte in the body', (verb) => {
    expect(() =>
      validateRequest({ ...VALID_REQUESTS[verb], content: 'a\u0000b' }, OPTIONS),
    ).toThrow(/NUL byte/);
  });

  it.each(bodyVerbs)('%s rejects a body over 1 MiB', (verb) => {
    const content = 'x'.repeat(1024 * 1024 + 1);
    expect(() => validateRequest({ ...VALID_REQUESTS[verb], content }, OPTIONS)).toThrow(
      /exceeds \d+ bytes/,
    );
  });

  it.each(bodyVerbs)('%s rejects a non-string body', (verb) => {
    expect(() =>
      validateRequest({ ...VALID_REQUESTS[verb], content: { toString: 1 } }, OPTIONS),
    ).toThrow(/must be a string/);
  });

  it.each(bodyVerbs)('%s ignores any path the caller tries to supply', (verb) => {
    const request = validateRequest(
      { ...VALID_REQUESTS[verb], path: '/etc/shadow', target: '/etc/passwd' },
      OPTIONS,
    );
    // The validated request carries no caller-supplied destination at all.
    expect(request).not.toHaveProperty('path');
    expect(request).not.toHaveProperty('target');
  });
});

describe('mount-share', () => {
  it('derives the mount point rather than accepting one', () => {
    const request = validateRequest(
      { ...VALID_REQUESTS['mount-share'], mountPoint: '/etc' },
      OPTIONS,
    );
    expect(request).toMatchObject({ mountPoint: resolve(`${ROOTS.mount}/werkstatt`) });
  });

  it.each(['1.0', 'NT1', '3.1.2', '', 'smb3'])('rejects the SMB version %p', (smbVersion) => {
    expect(() =>
      validateRequest({ ...VALID_REQUESTS['mount-share'], smbVersion }, OPTIONS),
    ).toThrow(PrivilegedValidationError);
  });

  it.each([-1, 70_000, 1.5, '1000', null])('rejects the uid %p', (uid) => {
    expect(() => validateRequest({ ...VALID_REQUESTS['mount-share'], uid }, OPTIONS)).toThrow(
      /integer between/,
    );
  });

  it('rejects a password over 1024 bytes', () => {
    const password = 'x'.repeat(1025);
    expect(() => validateRequest({ ...VALID_REQUESTS['mount-share'], password }, OPTIONS)).toThrow(
      /exceeds/,
    );
  });

  it('rejects a non-boolean seal flag', () => {
    expect(() =>
      validateRequest({ ...VALID_REQUESTS['mount-share'], seal: 'yes' }, OPTIONS),
    ).toThrow(/must be a boolean/);
  });
});

describe('validateShareName', () => {
  it.each(['werkstatt', 'CNC-01', 'a', 'a_b-C9', 'x'.repeat(32)])('accepts %p', (name) => {
    expect(validateShareName('t', name)).toBe(name);
  });

  it.each([
    '',
    'x'.repeat(33),
    'has space',
    'has/slash',
    'has.dot',
    '../escape',
    'tab\there',
    'ümlaut',
    'null\u0000',
  ])('rejects %p', (name) => {
    expect(() => validateShareName('t', name)).toThrow(PrivilegedValidationError);
  });

  it.each([[null], [undefined], [42], [{}], [['werkstatt']]])(
    'rejects the non-string %p',
    (name) => {
      expect(() => validateShareName('t', name)).toThrow(PrivilegedValidationError);
    },
  );
});

describe('validateServerUnc', () => {
  it.each([
    '//server/share',
    '//fileserver.example.local/CNC',
    '//10.0.0.5/Programme/TNC',
    '//host/share$',
  ])('accepts %p', (unc) => {
    expect(validateServerUnc('t', unc)).toBe(unc);
  });

  it.each([
    '\\\\server\\share',
    '/server/share',
    '//server',
    '//server/../../etc',
    '//server/share;id',
    '//server/share`id`',
    '//$(id)/share',
    'http://server/share',
    '//server//share',
  ])('rejects %p', (unc) => {
    expect(() => validateServerUnc('t', unc)).toThrow(PrivilegedValidationError);
  });
});

describe('validateInterfaceName', () => {
  it('accepts an interface the kernel actually has', () => {
    expect(validateInterfaceName('t', 'eth0', () => INTERFACES)).toBe('eth0');
  });

  it('rejects a well-formed name that does not exist', () => {
    expect(() => validateInterfaceName('t', 'eth9', () => INTERFACES)).toThrow(
      /no such network interface/,
    );
  });

  it('names the available interfaces in the error, to make misconfiguration obvious', () => {
    expect(() => validateInterfaceName('t', 'eth9', () => INTERFACES)).toThrow(/lo, eth0, eth1/);
  });

  it('reports "none" when the host exposes no interfaces', () => {
    expect(() => validateInterfaceName('t', 'eth0', () => [])).toThrow(/available: none/);
  });

  it.each(['../../etc', 'eth0;id', 'x'.repeat(16), '', 'eth 0'])(
    'rejects the malformed name %p',
    (name) => {
      expect(() => validateInterfaceName('t', name, () => INTERFACES)).toThrow(
        /is not a valid interface name/,
      );
    },
  );

  it('falls back to an empty list when /sys/class/net cannot be read', () => {
    // The default reader is used here; on a non-Linux host the directory is absent and
    // the catch branch must yield a rejection rather than an unhandled ENOENT.
    expect(() => validateInterfaceName('t', 'definitely-not-real')).toThrow(
      PrivilegedValidationError,
    );
  });
});

describe('validateIpAddress', () => {
  it.each(['10.0.0.1', '192.168.42.255', '0.0.0.0', 'fe80::1', '::1'])('accepts %p', (ip) => {
    expect(validateIpAddress('t', ip)).toBe(ip);
  });

  it.each(['256.0.0.1', '10.0.0', '10.0.0.1;id', '$(id)', 'example.com', '', '10.0.0.1/24'])(
    'rejects %p',
    (ip) => {
      expect(() => validateIpAddress('t', ip)).toThrow(PrivilegedValidationError);
    },
  );
});

describe('validateService', () => {
  it.each(ALLOWED_SERVICES)('accepts the allowed unit %s', (service) => {
    expect(validateService('t', service)).toBe(service);
  });

  it.each(['sshd', 'root', 'systemd-logind', 'nginx', 'tnc-bridge-helper'])(
    'rejects the unlisted unit %p',
    (service) => {
      expect(() => validateService('t', service)).toThrow(/is not an allowed unit/);
    },
  );

  it.each(['tnc-bridge;id', '../sshd', 'x'.repeat(65), ''])(
    'rejects the malformed unit %p',
    (service) => {
      expect(() => validateService('t', service)).toThrow(/is not a valid unit name/);
    },
  );
});

describe('validateVersion', () => {
  it.each(['v0.1.0', '0.1.0', 'v1.2.3.4', 'v2.0.0-rc.1'])('accepts %p', (version) => {
    expect(validateVersion('t', version)).toBe(version);
  });

  it.each(['../../etc', 'v0.1.0; id', 'latest', '', 'v0.1.0/../../root', '$(id)'])(
    'rejects %p',
    (version) => {
      expect(() => validateVersion('t', version)).toThrow(PrivilegedValidationError);
    },
  );
});

describe('apply-update', () => {
  it('derives the release directory from the version, inside the release root', () => {
    const request = validateRequest(
      { ...VALID_REQUESTS['apply-update'], releaseDir: '/etc' },
      OPTIONS,
    );
    // `resolve` so the assertion holds on the Windows dev host as well as the Pi.
    expect(request).toMatchObject({ releaseDir: resolve(`${ROOTS.releases}/v0.1.0`) });
  });

  it('accepts a well-formed manifest digest', () => {
    const manifestSha256 = 'A'.repeat(64);
    const request = validateRequest({ ...VALID_REQUESTS['apply-update'], manifestSha256 }, OPTIONS);
    // Normalised to lower case so the comparison at use-site is a plain equality.
    expect(request).toMatchObject({ manifestSha256: 'a'.repeat(64) });
  });

  it.each(['deadbeef', 'z'.repeat(64), '', 'a'.repeat(63), 'a'.repeat(65), 123])(
    'rejects the malformed digest %p',
    (manifestSha256) => {
      expect(() =>
        validateRequest({ ...VALID_REQUESTS['apply-update'], manifestSha256 }, OPTIONS),
      ).toThrow(/SHA256 digest/);
    },
  );
});

describe('apply-network', () => {
  it('requires an address when the method is static', () => {
    const { address: _omitted, ...rest } = VALID_REQUESTS['apply-network'];
    expect(() => validateRequest(rest, OPTIONS)).toThrow(/is required for a static method/);
  });

  it('accepts dhcp without an address', () => {
    const { address: _omitted, ...rest } = VALID_REQUESTS['apply-network'];
    const request = validateRequest({ ...rest, method: 'dhcp' }, OPTIONS);
    expect(request).toMatchObject({ method: 'dhcp' });
  });

  it.each(['192.168.1.5', '192.168.1.5/33', '192.168.1.5/', 'x/24', '192.168.1.5/24;id'])(
    'rejects the malformed CIDR %p',
    (address) => {
      expect(() =>
        validateRequest({ ...VALID_REQUESTS['apply-network'], address }, OPTIONS),
      ).toThrow(PrivilegedValidationError);
    },
  );

  it('rejects more than three DNS servers', () => {
    const dns = ['1.1.1.1', '8.8.8.8', '9.9.9.9', '4.4.4.4'];
    expect(() => validateRequest({ ...VALID_REQUESTS['apply-network'], dns }, OPTIONS)).toThrow(
      /at most 3 addresses/,
    );
  });

  it('rejects a non-array dns field', () => {
    expect(() =>
      validateRequest({ ...VALID_REQUESTS['apply-network'], dns: '1.1.1.1' }, OPTIONS),
    ).toThrow(/must be an array/);
  });

  it('validates every DNS entry, not just the first', () => {
    const dns = ['1.1.1.1', '$(id)'];
    expect(() => validateRequest({ ...VALID_REQUESTS['apply-network'], dns }, OPTIONS)).toThrow(
      PrivilegedValidationError,
    );
  });

  it.each([575, 9001, 1500.5, 'big'])('rejects the MTU %p', (mtu) => {
    expect(() => validateRequest({ ...VALID_REQUESTS['apply-network'], mtu }, OPTIONS)).toThrow(
      /integer between/,
    );
  });

  it.each([-1, 3601, 'soon'])('rejects the revert window %p', (revertAfterSeconds) => {
    expect(() =>
      validateRequest({ ...VALID_REQUESTS['apply-network'], revertAfterSeconds }, OPTIONS),
    ).toThrow(/integer between/);
  });

  it('applies defaults for the optional fields', () => {
    const request = validateRequest(
      {
        verb: 'apply-network',
        interface: 'eth0',
        method: 'dhcp',
        dns: [],
      },
      OPTIONS,
    );
    expect(request).toMatchObject({ mtu: 1500, ipv6Enabled: false, revertAfterSeconds: 60 });
  });
});

describe('install-cert', () => {
  it('rejects a certificate that is not PEM', () => {
    expect(() =>
      validateRequest({ ...VALID_REQUESTS['install-cert'], certPem: 'not a cert' }, OPTIONS),
    ).toThrow(/is not a PEM certificate/);
  });

  it('rejects a key that is not PEM', () => {
    expect(() =>
      validateRequest(
        { ...VALID_REQUESTS['install-cert'], keyPem: '-----BEGIN CERTIFICATE-----' },
        OPTIONS,
      ),
    ).toThrow(/is not a PEM private key/);
  });

  it.each(['-----BEGIN RSA PRIVATE KEY-----\nx\n', '-----BEGIN EC PRIVATE KEY-----\nx\n'])(
    'accepts the legacy key header %p',
    (keyPem) => {
      expect(validateRequest({ ...VALID_REQUESTS['install-cert'], keyPem }, OPTIONS)).toMatchObject(
        {
          verb: 'install-cert',
        },
      );
    },
  );

  it('accepts an optional chain', () => {
    const chainPem = '-----BEGIN CERTIFICATE-----\nchain\n-----END CERTIFICATE-----\n';
    expect(validateRequest({ ...VALID_REQUESTS['install-cert'], chainPem }, OPTIONS)).toMatchObject(
      {
        chainPem,
      },
    );
  });

  it('rejects a chain that is not PEM', () => {
    expect(() =>
      validateRequest({ ...VALID_REQUESTS['install-cert'], chainPem: 'junk' }, OPTIONS),
    ).toThrow(/chainPem: is not a PEM certificate/);
  });
});

describe('service-restart', () => {
  it.each(['restart', 'start', 'stop', 'reload'])('accepts the action %p', (action) => {
    expect(
      validateRequest({ ...VALID_REQUESTS['service-restart'], action }, OPTIONS),
    ).toMatchObject({
      action,
    });
  });

  it.each(['mask', 'enable', 'kill', 'daemon-reload'])('rejects the action %p', (action) => {
    expect(() =>
      validateRequest({ ...VALID_REQUESTS['service-restart'], action }, OPTIONS),
    ).toThrow(/must be one of/);
  });

  it('defaults to restart', () => {
    expect(validateRequest({ verb: 'service-restart', service: 'smbd' }, OPTIONS)).toMatchObject({
      action: 'restart',
    });
  });
});

describe('unmount-share and reload-samba defaults', () => {
  it('defaults force to false', () => {
    expect(
      validateRequest({ verb: 'unmount-share', shareName: 'werkstatt' }, OPTIONS),
    ).toMatchObject({
      force: false,
    });
  });

  it('rejects a non-boolean force flag', () => {
    expect(() =>
      validateRequest({ verb: 'unmount-share', shareName: 'werkstatt', force: 'yes' }, OPTIONS),
    ).toThrow(/must be a boolean/);
  });

  it.each(['reload', 'restart'])('accepts the samba mode %p', (mode) => {
    expect(validateRequest({ verb: 'reload-samba', mode }, OPTIONS)).toMatchObject({ mode });
  });
});

describe('fail2ban-unban', () => {
  it('defaults the jail to tnc-bridge', () => {
    expect(validateRequest({ verb: 'fail2ban-unban', ip: '10.0.0.1' }, OPTIONS)).toMatchObject({
      jail: 'tnc-bridge',
    });
  });

  it.each(['a jail', 'jail;id', 'x'.repeat(65), ''])('rejects the jail %p', (jail) => {
    expect(() =>
      validateRequest({ verb: 'fail2ban-unban', ip: '10.0.0.1', jail }, OPTIONS),
    ).toThrow(/is not a valid jail name/);
  });
});

describe('validatePathWithin', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tnc-path-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts the root itself', () => {
    expect(validatePathWithin('t', 'p', root, root)).toBe(root);
  });

  it('accepts a path inside the root', () => {
    const inside = join(root, 'share', 'file.h');
    expect(validatePathWithin('t', 'p', root, inside)).toBe(inside);
  });

  it('collapses traversal and rejects what escapes', () => {
    expect(() =>
      validatePathWithin('t', 'p', root, join(root, '..', '..', 'etc', 'passwd')),
    ).toThrow(/must be inside/);
  });

  it('rejects an unrelated absolute path', () => {
    expect(() => validatePathWithin('t', 'p', root, '/etc/passwd')).toThrow(/must be inside/);
  });

  it('rejects a relative path', () => {
    expect(() => validatePathWithin('t', 'p', root, 'share/file.h')).toThrow(/absolute path/);
  });

  it('rejects an empty path', () => {
    expect(() => validatePathWithin('t', 'p', root, '')).toThrow(/non-empty path/);
  });

  it('rejects a non-string path', () => {
    expect(() => validatePathWithin('t', 'p', root, 42)).toThrow(/non-empty path/);
  });

  it('rejects a NUL byte', () => {
    expect(() => validatePathWithin('t', 'p', root, `${root}/a\u0000b`)).toThrow(/NUL byte/);
  });

  it('rejects a prefix-collision sibling of the root', () => {
    // `/srv/tnc-evil` starts with `/srv/tnc` as a string but is not inside it.
    expect(() => validatePathWithin('t', 'p', '/srv/tnc', '/srv/tnc-evil/file')).toThrow(
      /must be inside/,
    );
  });

  /**
   * The check a pure string comparison cannot make. An attacker who can write into the
   * cache root plants a symlink to `/etc`; without following it, the helper would
   * canonicalise a path that *looks* jailed and then write outside the jail as root.
   */
  it('rejects a path that reaches outside through a symlink', () => {
    if (process.platform === 'win32') {
      return; // symlink creation needs elevation on Windows; covered on Linux in CI.
    }
    const outside = mkdtempSync(join(tmpdir(), 'tnc-outside-'));
    writeFileSync(join(outside, 'loot'), 'secret');
    symlinkSync(outside, join(root, 'escape'));
    try {
      expect(() => validatePathWithin('t', 'p', root, join(root, 'escape', 'loot'))).toThrow(
        /through a symlink/,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accepts a real directory inside the root', () => {
    mkdirSync(join(root, 'werkstatt'));
    expect(validatePathWithin('t', 'p', root, join(root, 'werkstatt'))).toBe(
      join(root, 'werkstatt'),
    );
  });

  it('accepts a not-yet-existing path inside a root that does not exist either', () => {
    const absent = join(root, 'absent-root');
    expect(validatePathWithin('t', 'p', absent, join(absent, 'child'))).toBe(join(absent, 'child'));
  });
});

describe('assertNoMetacharacters', () => {
  it.each([
    ';',
    '&',
    '|',
    '`',
    '$',
    '(',
    ')',
    '{',
    '}',
    '<',
    '>',
    '\n',
    '\r',
    '!',
    '*',
    '?',
    '[',
    ']',
    '\\',
    "'",
    '"',
  ])('rejects %p', (character) => {
    expect(() => assertNoMetacharacters('t', 'f', `value${character}`)).toThrow(
      /forbidden character/,
    );
  });

  it('accepts an ordinary value', () => {
    expect(() => assertNoMetacharacters('t', 'f', 'werkstatt-01')).not.toThrow();
  });
});

describe('derived paths', () => {
  it('places a mount point under the mount root', () => {
    expect(mountPointFor('werkstatt')).toBe('/mnt/tnc-server/werkstatt');
  });

  it('places a cache path under the cache root', () => {
    expect(cachePathFor('werkstatt')).toBe('/srv/tnc/werkstatt');
  });
});
