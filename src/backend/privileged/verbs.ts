import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * The privileged verb allowlist and its argument validation (ARCHITECTURE §5.4).
 *
 * This module is the security boundary of the whole product. The web tier runs as an
 * unprivileged user; the only way it reaches root is one binary, invoked through one
 * sudoers rule, accepting exactly eleven verbs. If an attacker achieves RCE in the
 * Node process, what they gain is bounded by what is validated here.
 *
 * Three rules govern everything below:
 *
 *  1. **Allowlist, never denylist.** Every argument is matched against a pattern of
 *     what is permitted. Trying to enumerate dangerous inputs (`;`, `$()`, backticks)
 *     is a losing game — we do it anyway as a second layer, but the primary defence is
 *     that `programs` matches `^[a-zA-Z0-9_-]{1,32}$` and `programs; rm -rf /` does not.
 *  2. **Validation happens inside the helper**, after the privilege boundary. The
 *     client validates too, but that check is a convenience for callers, not a
 *     control — an attacker who controls the client simply skips it.
 *  3. **No shell, ever.** Arguments are passed as an argv array to `execve`. There is
 *     no string for a metacharacter to be interpreted in.
 */

export const PRIVILEGED_VERBS = [
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
] as const;

export type PrivilegedVerb = (typeof PRIVILEGED_VERBS)[number];

const VERB_SET = new Set<string>(PRIVILEGED_VERBS);

export const isPrivilegedVerb = (value: string): value is PrivilegedVerb => VERB_SET.has(value);

// ---------------------------------------------------------------------------
// Filesystem roots the helper is permitted to touch
// ---------------------------------------------------------------------------

export const ROOTS = {
  mount: '/mnt/tnc-server',
  cache: '/srv/tnc',
  sambaConfig: '/etc/samba',
  dnsmasqConfig: '/etc/dnsmasq.d',
  nftConfig: '/etc/nftables.d',
  tls: '/etc/tnc-bridge/tls',
  releases: '/opt/tnc-bridge/releases',
} as const;

/** systemd units the helper may act on. Anything else is refused. */
export const ALLOWED_SERVICES = [
  'tnc-bridge',
  'smbd',
  'nmbd',
  'dnsmasq',
  'fail2ban',
  'nftables',
  'NetworkManager',
] as const;

export type AllowedService = (typeof ALLOWED_SERVICES)[number];

export class PrivilegedValidationError extends Error {
  constructor(
    readonly verb: string,
    readonly field: string,
    message: string,
  ) {
    super(`${verb}: ${field}: ${message}`);
    this.name = 'PrivilegedValidationError';
  }
}

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

const SHARE_NAME = /^[a-zA-Z0-9_-]{1,32}$/;
const INTERFACE_NAME = /^[A-Za-z0-9._-]{1,15}$/;
const SERVICE_NAME = /^[A-Za-z0-9._@-]{1,64}$/;
const VERSION = /^v?\d{1,4}(\.\d{1,4}){0,3}(-[A-Za-z0-9.]{1,32})?$/;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^[0-9a-fA-F:]{2,45}$/;
const UNC = /^\/\/[A-Za-z0-9._-]{1,253}\/[A-Za-z0-9._$ -]{1,255}(\/[A-Za-z0-9._$ -]{1,255})*$/;

/**
 * Characters that have no business in any argument this helper accepts.
 *
 * Redundant with the allowlists above — nothing that passes a pattern could contain
 * these. It stays because a future verb might arrive with a looser pattern, and
 * because a rejection here produces a much clearer audit entry than a silently
 * mismatched regex.
 */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\n\r\0!*?[\]\\'"]/;

export function assertNoMetacharacters(verb: string, field: string, value: string): void {
  if (SHELL_METACHARACTERS.test(value)) {
    throw new PrivilegedValidationError(verb, field, 'contains a forbidden character');
  }
}

export function validateShareName(verb: string, value: unknown): string {
  if (typeof value !== 'string' || !SHARE_NAME.test(value)) {
    throw new PrivilegedValidationError(
      verb,
      'shareName',
      'must be 1-32 characters of A-Z, a-z, 0-9, underscore or hyphen',
    );
  }
  return value;
}

/**
 * Interface names are checked against the kernel's actual list, not just a pattern.
 *
 * A name that matches `^[a-z0-9]+$` but does not exist would be handed to `nmcli`,
 * which is harmless but useless; more importantly, restricting to real interfaces
 * means a caller cannot invent a name that some future consumer treats as a path.
 */
export function validateInterfaceName(
  verb: string,
  value: unknown,
  listInterfaces: () => string[] = defaultListInterfaces,
): string {
  if (typeof value !== 'string' || !INTERFACE_NAME.test(value)) {
    throw new PrivilegedValidationError(verb, 'interface', 'is not a valid interface name');
  }
  const available = listInterfaces();
  if (!available.includes(value)) {
    throw new PrivilegedValidationError(
      verb,
      'interface',
      `no such network interface (available: ${available.join(', ') || 'none'})`,
    );
  }
  return value;
}

function defaultListInterfaces(): string[] {
  try {
    return readdirSync('/sys/class/net');
  } catch {
    return [];
  }
}

export function validateIpAddress(verb: string, value: unknown, field = 'ip'): string {
  if (typeof value !== 'string' || (!IPV4.test(value) && !IPV6.test(value))) {
    throw new PrivilegedValidationError(verb, field, 'is not a valid IP address');
  }
  return value;
}

export function validateService(verb: string, value: unknown): AllowedService {
  if (typeof value !== 'string' || !SERVICE_NAME.test(value)) {
    throw new PrivilegedValidationError(verb, 'service', 'is not a valid unit name');
  }
  if (!(ALLOWED_SERVICES as readonly string[]).includes(value)) {
    throw new PrivilegedValidationError(
      verb,
      'service',
      `is not an allowed unit (allowed: ${ALLOWED_SERVICES.join(', ')})`,
    );
  }
  return value as AllowedService;
}

export function validateVersion(verb: string, value: unknown): string {
  if (typeof value !== 'string' || !VERSION.test(value)) {
    throw new PrivilegedValidationError(verb, 'version', 'is not a valid version string');
  }
  return value;
}

export function validateServerUnc(verb: string, value: unknown): string {
  if (typeof value !== 'string' || !UNC.test(value)) {
    throw new PrivilegedValidationError(verb, 'serverUnc', 'is not a valid UNC path');
  }
  // `.` is legal inside a share name, so the pattern above cannot by itself distinguish
  // `//server/v1.2` from `//server/../../etc`. Traversal is rejected segment-wise.
  if (value.split('/').includes('..')) {
    throw new PrivilegedValidationError(verb, 'serverUnc', 'must not contain a ".." segment');
  }
  // Deliberately no `assertNoMetacharacters` call here. The UNC pattern is already a
  // strict allowlist — the only character it admits that the metacharacter set forbids
  // is `$`, which is how Windows names hidden shares (`CNC$`) and is meaningless
  // without a shell to expand it. Rejecting it would break real deployments to protect
  // against an interpreter this code never invokes.
  return value;
}

/**
 * Canonicalises a path and proves it stays inside `root`.
 *
 * Two checks, because they catch different things. `resolve()` collapses `..`, which
 * defeats `/mnt/tnc-server/../../etc/shadow`. `realpathSync()` follows symlinks, which
 * defeats a symlink planted inside the root pointing at `/etc` — an attacker who can
 * write into the cache directory can create one, and without this check the helper
 * would happily follow it as root.
 */
export function validatePathWithin(
  verb: string,
  field: string,
  root: string,
  candidate: unknown,
): string {
  if (typeof candidate !== 'string' || candidate === '') {
    throw new PrivilegedValidationError(verb, field, 'must be a non-empty path');
  }
  if (candidate.includes('\0')) {
    throw new PrivilegedValidationError(verb, field, 'must not contain a NUL byte');
  }
  if (!isAbsolute(candidate)) {
    throw new PrivilegedValidationError(verb, field, 'must be an absolute path');
  }

  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new PrivilegedValidationError(verb, field, `must be inside ${resolvedRoot}`);
  }

  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    const realRoot = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new PrivilegedValidationError(
        verb,
        field,
        `resolves through a symlink to ${real}, which is outside ${realRoot}`,
      );
    }
  }

  return resolved;
}

/** The mount point for a share is derived, never supplied. */
export const mountPointFor = (shareName: string): string => `${ROOTS.mount}/${shareName}`;

/** The cache path for a share is derived, never supplied. */
export const cachePathFor = (shareName: string): string => `${ROOTS.cache}/${shareName}`;

// ---------------------------------------------------------------------------
// Per-verb request shapes
// ---------------------------------------------------------------------------

export interface MountShareRequest {
  readonly verb: 'mount-share';
  readonly shareName: string;
  readonly serverUnc: string;
  readonly mountPoint: string;
  readonly smbVersion: '3.1.1' | '3.0' | '2.1';
  readonly seal: boolean;
  readonly domain: string;
  readonly username: string;
  readonly password: string;
  readonly uid: number;
  readonly gid: number;
}

export interface UnmountShareRequest {
  readonly verb: 'unmount-share';
  readonly shareName: string;
  readonly mountPoint: string;
  readonly force: boolean;
}

export interface ReloadSambaRequest {
  readonly verb: 'reload-samba';
  readonly mode: 'reload' | 'restart';
}

export interface WriteSambaConfigRequest {
  readonly verb: 'write-samba-config';
  readonly content: string;
}

export interface WriteDnsmasqConfigRequest {
  readonly verb: 'write-dnsmasq-config';
  readonly content: string;
  readonly enabled: boolean;
}

export interface ApplyNetworkRequest {
  readonly verb: 'apply-network';
  readonly interface: string;
  readonly method: 'dhcp' | 'static';
  readonly address?: string;
  readonly gateway?: string;
  readonly dns: readonly string[];
  readonly mtu: number;
  readonly ipv6Enabled: boolean;
  /** Reverts unless confirmed within this many seconds. 0 disables the timer. */
  readonly revertAfterSeconds: number;
}

export interface WriteNftRulesetRequest {
  readonly verb: 'write-nft-ruleset';
  readonly content: string;
}

export interface Fail2banUnbanRequest {
  readonly verb: 'fail2ban-unban';
  readonly ip: string;
  readonly jail: string;
}

export interface InstallCertRequest {
  readonly verb: 'install-cert';
  readonly certPem: string;
  readonly keyPem: string;
  readonly chainPem?: string;
}

export interface ServiceRestartRequest {
  readonly verb: 'service-restart';
  readonly service: AllowedService;
  readonly action: 'restart' | 'start' | 'stop' | 'reload';
}

export interface ApplyUpdateRequest {
  readonly verb: 'apply-update';
  readonly version: string;
  readonly releaseDir: string;
  /**
   * Expected SHA256 of the release's `SHA256SUMS` manifest.
   *
   * Optional because the manifest's per-file digests already bind the release contents;
   * supplying this additionally binds the manifest itself to what the GitHub release
   * advertised, so a caller that has been tricked into staging a coherent but wrong
   * release is caught at the privilege boundary rather than after the symlink swap.
   */
  readonly manifestSha256?: string;
}

export type PrivilegedRequest =
  | MountShareRequest
  | UnmountShareRequest
  | ReloadSambaRequest
  | WriteSambaConfigRequest
  | WriteDnsmasqConfigRequest
  | ApplyNetworkRequest
  | WriteNftRulesetRequest
  | Fail2banUnbanRequest
  | InstallCertRequest
  | ServiceRestartRequest
  | ApplyUpdateRequest;

export interface ValidateOptions {
  /** Injected so tests need not depend on the host's real interfaces. */
  readonly listInterfaces?: () => string[];
}

const MAX_CONTENT_BYTES = 1024 * 1024;

function requireString(verb: string, field: string, value: unknown, maxBytes: number): string {
  if (typeof value !== 'string') {
    throw new PrivilegedValidationError(verb, field, 'must be a string');
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new PrivilegedValidationError(verb, field, `exceeds ${maxBytes} bytes`);
  }
  if (value.includes('\0')) {
    throw new PrivilegedValidationError(verb, field, 'must not contain a NUL byte');
  }
  return value;
}

function requireBoolean(verb: string, field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new PrivilegedValidationError(verb, field, 'must be a boolean');
  }
  return value;
}

function requireEnum<T extends string>(
  verb: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new PrivilegedValidationError(verb, field, `must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function requireInteger(
  verb: string,
  field: string,
  value: unknown,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new PrivilegedValidationError(verb, field, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

const PEM_CERT_HEADER = '-----BEGIN CERTIFICATE-----';
const PEM_KEY = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/;

/**
 * Validates a raw request into a typed one, or throws.
 *
 * This runs inside the helper, after the privilege boundary. Everything the helper
 * subsequently does is derived from the value this returns — never from the raw input.
 */
export function validateRequest(raw: unknown, options: ValidateOptions = {}): PrivilegedRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PrivilegedValidationError('<none>', 'request', 'must be a JSON object');
  }
  const input = raw as Record<string, unknown>;
  const verbValue = input.verb;

  if (typeof verbValue !== 'string' || !isPrivilegedVerb(verbValue)) {
    throw new PrivilegedValidationError(
      // Never stringify the raw value: it may be an object, and `[object Object]` in an
      // audit entry hides what was actually sent.
      typeof verbValue === 'string' ? verbValue : `<${typeof verbValue}>`,
      'verb',
      `is not one of the ${PRIVILEGED_VERBS.length} permitted verbs`,
    );
  }
  const verb: PrivilegedVerb = verbValue;

  switch (verb) {
    case 'mount-share': {
      const shareName = validateShareName(verb, input.shareName);
      return {
        verb,
        shareName,
        serverUnc: validateServerUnc(verb, input.serverUnc),
        // Derived from the share name and then re-checked, so a caller cannot point
        // the mount anywhere of its choosing.
        mountPoint: validatePathWithin(verb, 'mountPoint', ROOTS.mount, mountPointFor(shareName)),
        smbVersion: requireEnum(verb, 'smbVersion', input.smbVersion, ['3.1.1', '3.0', '2.1']),
        seal: requireBoolean(verb, 'seal', input.seal),
        domain: requireCredentialField(verb, 'domain', input.domain),
        username: requireCredentialField(verb, 'username', input.username),
        password: requireString(verb, 'password', input.password, 1024),
        uid: requireInteger(verb, 'uid', input.uid, 0, 65_535),
        gid: requireInteger(verb, 'gid', input.gid, 0, 65_535),
      };
    }

    case 'unmount-share': {
      const shareName = validateShareName(verb, input.shareName);
      return {
        verb,
        shareName,
        mountPoint: validatePathWithin(verb, 'mountPoint', ROOTS.mount, mountPointFor(shareName)),
        force: requireBoolean(verb, 'force', input.force ?? false),
      };
    }

    case 'reload-samba':
      return { verb, mode: requireEnum(verb, 'mode', input.mode, ['reload', 'restart']) };

    case 'write-samba-config':
      return {
        verb,
        content: requireString(verb, 'content', input.content, MAX_CONTENT_BYTES),
      };

    case 'write-dnsmasq-config':
      return {
        verb,
        content: requireString(verb, 'content', input.content, MAX_CONTENT_BYTES),
        enabled: requireBoolean(verb, 'enabled', input.enabled),
      };

    case 'apply-network': {
      const method = requireEnum(verb, 'method', input.method, ['dhcp', 'static']);
      const dnsRaw = input.dns ?? [];
      if (!Array.isArray(dnsRaw) || dnsRaw.length > 3) {
        throw new PrivilegedValidationError(verb, 'dns', 'must be an array of at most 3 addresses');
      }
      const request: ApplyNetworkRequest = {
        verb,
        interface: validateInterfaceName(verb, input.interface, options.listInterfaces),
        method,
        dns: dnsRaw.map((entry) => validateIpAddress(verb, entry, 'dns')),
        mtu: requireInteger(verb, 'mtu', input.mtu ?? 1500, 576, 9000),
        ipv6Enabled: requireBoolean(verb, 'ipv6Enabled', input.ipv6Enabled ?? false),
        revertAfterSeconds: requireInteger(
          verb,
          'revertAfterSeconds',
          input.revertAfterSeconds ?? 60,
          0,
          3600,
        ),
        ...(input.address === undefined
          ? {}
          : { address: validateCidr(verb, 'address', input.address) }),
        ...(input.gateway === undefined
          ? {}
          : { gateway: validateIpAddress(verb, input.gateway, 'gateway') }),
      };
      if (method === 'static' && request.address === undefined) {
        throw new PrivilegedValidationError(verb, 'address', 'is required for a static method');
      }
      return request;
    }

    case 'write-nft-ruleset':
      return {
        verb,
        content: requireString(verb, 'content', input.content, MAX_CONTENT_BYTES),
      };

    case 'fail2ban-unban':
      return {
        verb,
        ip: validateIpAddress(verb, input.ip),
        jail: validateJail(verb, input.jail ?? 'tnc-bridge'),
      };

    case 'install-cert': {
      const certPem = requireString(verb, 'certPem', input.certPem, MAX_CONTENT_BYTES);
      const keyPem = requireString(verb, 'keyPem', input.keyPem, MAX_CONTENT_BYTES);
      if (!certPem.includes(PEM_CERT_HEADER)) {
        throw new PrivilegedValidationError(verb, 'certPem', 'is not a PEM certificate');
      }
      if (!PEM_KEY.test(keyPem)) {
        throw new PrivilegedValidationError(verb, 'keyPem', 'is not a PEM private key');
      }
      const chain =
        input.chainPem === undefined
          ? undefined
          : requireString(verb, 'chainPem', input.chainPem, MAX_CONTENT_BYTES);
      if (chain !== undefined && !chain.includes(PEM_CERT_HEADER)) {
        throw new PrivilegedValidationError(verb, 'chainPem', 'is not a PEM certificate');
      }
      return { verb, certPem, keyPem, ...(chain === undefined ? {} : { chainPem: chain }) };
    }

    case 'service-restart':
      return {
        verb,
        service: validateService(verb, input.service),
        action: requireEnum(verb, 'action', input.action ?? 'restart', [
          'restart',
          'start',
          'stop',
          'reload',
        ]),
      };

    case 'apply-update': {
      const version = validateVersion(verb, input.version);
      return {
        verb,
        version,
        releaseDir: validatePathWithin(
          verb,
          'releaseDir',
          ROOTS.releases,
          `${ROOTS.releases}/${version}`,
        ),
        ...(input.manifestSha256 === undefined
          ? {}
          : { manifestSha256: validateSha256(verb, 'manifestSha256', input.manifestSha256) }),
      };
    }
  }
}

/** Domain and username reach `mount.cifs` in a credentials file, so they are bounded. */
function requireCredentialField(verb: string, field: string, value: unknown): string {
  const text = requireString(verb, field, value ?? '', 255);
  if (!/^[A-Za-z0-9._@ -]*$/.test(text)) {
    throw new PrivilegedValidationError(verb, field, 'contains an unsupported character');
  }
  return text;
}

function validateCidr(verb: string, field: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new PrivilegedValidationError(verb, field, 'must be a string');
  }
  const [address = '', prefix = ''] = value.split('/');
  if (!IPV4.test(address) || !/^(?:3[0-2]|[12]?\d)$/.test(prefix)) {
    throw new PrivilegedValidationError(verb, field, 'must be an IPv4 address with a prefix length');
  }
  return value;
}

function validateSha256(verb: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new PrivilegedValidationError(verb, field, 'must be a 64-character hex SHA256 digest');
  }
  return value.toLowerCase();
}

function validateJail(verb: string, value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new PrivilegedValidationError(verb, 'jail', 'is not a valid jail name');
  }
  return value;
}
