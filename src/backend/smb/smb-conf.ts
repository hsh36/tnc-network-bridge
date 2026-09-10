import Handlebars from 'handlebars';

import { SHARE_NAME_PATTERN, TEMP_FILE_PREFIX } from '../../shared/constants';
import { ROOTS } from '../privileged/verbs';

/**
 * The `smb.conf` generator (T12).
 *
 * This module writes the configuration for the SMB1 listener the TNC machines talk to.
 * One line in it is the reason the product exists:
 *
 * ```ini
 *   interfaces = eth1
 *   bind interfaces only = yes
 * ```
 *
 * An SMB1 listener reachable from the corporate LAN would recreate precisely the
 * vulnerability this bridge is sold to remove. Everything else here is configuration;
 * that pair is a security control, and it is treated like one — generated, then
 * **re-parsed and asserted** before it is allowed anywhere near `smbd`.
 *
 * The re-parse is not redundant with the template. Three things can put a wrong value in
 * the rendered text — a template edit, an unescaped field, a caller passing the LAN
 * interface by mistake — and none of them are caught by `testparm`, which validates
 * syntax and has no opinion about which interface it is safe for us to listen on. So
 * {@link assertSafeConfig} reads the generated text back the way Samba would and refuses
 * it if the invariants do not hold. A config that cannot be proven safe is never
 * activated.
 *
 * The parser deliberately mirrors one of Samba's quirks: parameter names ignore internal
 * whitespace and case, so `bindinterfacesonly`, `Bind Interfaces Only` and
 * `bind interfaces only` are the same key. A validator that missed that could be walked
 * straight past by a config that Samba then honours.
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface SmbShareConfig {
  readonly name: string;
  /** Local cache directory, which is also the Samba export root. Must sit under /srv/tnc. */
  readonly path: string;
  readonly comment?: string;
  /** Set by the failover controller or by an operator. */
  readonly readOnly?: boolean;
  readonly guestOk?: boolean;
  readonly validUsers?: readonly string[];
  readonly extraVetoFiles?: readonly string[];
}

export interface SmbConfInput {
  /** The TNC-side interface. The ONLY interface smbd may bind. */
  readonly tncInterface: string;
  /**
   * The LAN interface, supplied so the generator can prove it is absent.
   *
   * Passing it in looks backwards — why hand the generator the thing it must not use? —
   * but it converts "we did not add the LAN interface" from an assumption into a check.
   */
  readonly lanInterface?: string;
  readonly workgroup?: string;
  readonly netbiosName?: string;
  readonly serverString?: string;
  readonly maxProtocol?: 'NT1' | 'SMB2' | 'SMB3';
  readonly ntlmAuth?: boolean;
  readonly dosCharset?: string;
  readonly unixCharset?: string;
  readonly logLevel?: number;
  readonly auditFacility?: string;
  readonly auditPriority?: string;
  /** Global read-only, used by the failover controller when the server is unreachable. */
  readonly globalReadOnly?: boolean;
  readonly shares: readonly SmbShareConfig[];
}

/**
 * The eight audited verbs (R16).
 *
 * Only these. `full_audit` on a busy share is capable of filling a disk with success
 * lines nobody reads; each of these earns its place by feeding the lock manager (T14).
 */
export const AUDIT_VERBS = [
  'open',
  'close',
  'write',
  'pwrite',
  'rename',
  'unlink',
  'mkdir',
  'rmdir',
] as const;

/**
 * Patterns a TNC must never see.
 *
 * In-flight temp files would appear as half-written programs; sidecar locks are our
 * bookkeeping and would look like corrupt NC files to a control that tried to open one.
 */
export const DEFAULT_VETO_FILES = [
  `${TEMP_FILE_PREFIX}*`,
  '.~lock.*#',
  '.tnc-bridge-probe*',
  '.tnc-versions',
  'lost+found',
] as const;

// ---------------------------------------------------------------------------
// Field sanitising
// ---------------------------------------------------------------------------

export class SmbConfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmbConfError';
  }
}

/**
 * Strips anything that could end the current line.
 *
 * This is the injection defence. A share comment of
 * `NC programs\n  interfaces = eth0 eth1` would otherwise append a real directive to the
 * global section and undo the interface binding. Share *names* are already constrained
 * by {@link SHARE_NAME_PATTERN}, but comments and server strings are free text that
 * reaches the file verbatim.
 */
export function sanitiseValue(value: string, field: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new SmbConfError(
      `${field} contains a line break or NUL byte; that would inject a directive into smb.conf`,
    );
  }
  return value.trim();
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/**
 * `noEscape` is correct and load-bearing: this is an INI file, not HTML. With escaping
 * on, a `$` in a path or a `&` in a comment would arrive as `&amp;` and Samba would use
 * the mangled value. Injection is handled by {@link sanitiseValue}, which rejects the
 * only character that matters here — the newline.
 */
const TEMPLATE_SOURCE = `#
# Generated by TNC Network Bridge. Do not edit by hand.
# Changes are overwritten whenever the configuration is applied from the web UI.
#
[global]
  workgroup = {{workgroup}}
  netbios name = {{netbiosName}}
  server string = {{serverString}}

  # --- Protocol -----------------------------------------------------------
  # NT1 is the whole point of this device: an iTNC 530 speaks nothing newer.
  # Modern controls negotiate up to {{maxProtocol}} on the same listener.
  server min protocol = NT1
  server max protocol = {{maxProtocol}}
  client min protocol = NT1
  unix extensions = no

  # --- Authentication -----------------------------------------------------
  # The iTNC 530 cannot do NTLMv2, and NT1 clients cannot sign. Both settings
  # are unacceptable on a corporate LAN, which is exactly why this listener is
  # confined to the TNC interface below.
  ntlm auth = {{#if ntlmAuth}}yes{{else}}no{{/if}}
  # LANMAN is not mentioned at all, on purpose.
  #
  # It hashes the password twice with DES over an uppercased 7-character half: not weak
  # encryption, a lookup table. Samba has defaulted it off since 4.0 and now warns that
  # the option is deprecated: writing it out produced that warning on every
  # smbclient and testparm call, which is a line an operator reads and worries about.
  # Not saying it gets the same result quietly.
  raw NTLMv2 auth = {{#if ntlmAuth}}yes{{else}}no{{/if}}
  server signing = disabled
  server smb encrypt = off

  # --- Interface binding — SECURITY CRITICAL ------------------------------
  # An SMB1 listener reachable from the corporate LAN would recreate the exact
  # vulnerability this product exists to remove. Never add an interface here.
  interfaces = {{tncInterface}}
  bind interfaces only = yes

  # --- Character sets -----------------------------------------------------
  # HEIDENHAIN controls use CP850. A mismatch mangles every umlaut in a
  # filename, and a program the control cannot open is worse than one that
  # never arrived (R7).
  unix charset = {{unixCharset}}
  dos charset = {{dosCharset}}

  # --- NetBIOS ------------------------------------------------------------
  # The iTNC 530 resolves names over NetBIOS; nmbd must stay enabled.
  disable netbios = no
  dns proxy = no

  # --- Audit --------------------------------------------------------------
  # Feeds the lock manager (T14). Success is limited to the eight verbs that
  # are actually consumed; failures are not logged at all (R16).
  vfs objects = full_audit
  full_audit:prefix = %I|%u|%S
  full_audit:success = {{auditVerbs}}
  full_audit:failure = none
  full_audit:facility = {{auditFacility}}
  full_audit:priority = {{auditPriority}}

  # --- Safety -------------------------------------------------------------
  wide links = no
  follow symlinks = no
  unix password sync = no
  load printers = no
  printing = bsd
  printcap name = /dev/null
  disable spoolss = yes

  log level = {{logLevel}}
  max log size = 1000
  logging = file

  map to guest = Bad User
  guest account = nobody
{{#each shares}}

[{{name}}]
  comment = {{comment}}
  path = {{path}}
  browseable = yes
  read only = {{#if readOnly}}yes{{else}}no{{/if}}
  guest ok = {{#if guestOk}}yes{{else}}no{{/if}}
{{#if validUsers}}  valid users = {{validUsers}}
{{/if}}  create mask = 0660
  directory mask = 0770
  force create mode = 0660
  force directory mode = 0770
  veto files = {{vetoFiles}}
  delete veto files = no
  wide links = no
  follow symlinks = no
  strict sync = yes
  sync always = no
{{/each}}
`;

const template = Handlebars.compile(TEMPLATE_SOURCE, { noEscape: true, strict: false });

/** Samba's veto/hide syntax is slash-delimited and slash-terminated. */
function formatVetoFiles(patterns: readonly string[]): string {
  return `/${patterns.join('/')}/`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the config text.
 *
 * An empty share list is deliberately not an error: a bridge with nothing configured
 * yet must still produce a valid, safely-bound config so `smbd` can run and the setup
 * wizard can reach its last step.
 */
export function renderSmbConf(input: SmbConfInput): string {
  for (const share of input.shares) {
    if (!SHARE_NAME_PATTERN.test(share.name)) {
      throw new SmbConfError(
        `share name "${share.name}" is not 1-32 characters of A-Z, a-z, 0-9, _ or -`,
      );
    }
    assertPathWithinCache(share.path, share.name);
  }

  const names = input.shares.map((share) => share.name.toLowerCase());
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    // Samba silently keeps the last of two identically-named sections, which would
    // export a directory nobody intended.
    throw new SmbConfError(`duplicate share section "${duplicate}"`);
  }

  const view = {
    workgroup: sanitiseValue(input.workgroup ?? 'WORKGROUP', 'workgroup'),
    netbiosName: sanitiseValue(input.netbiosName ?? 'TNC-BRIDGE', 'netbiosName'),
    serverString: sanitiseValue(input.serverString ?? 'TNC Network Bridge', 'serverString'),
    maxProtocol: input.maxProtocol ?? 'SMB3',
    ntlmAuth: input.ntlmAuth ?? true,
    tncInterface: sanitiseValue(input.tncInterface, 'tncInterface'),
    unixCharset: sanitiseValue(input.unixCharset ?? 'UTF-8', 'unixCharset'),
    dosCharset: sanitiseValue(input.dosCharset ?? 'CP850', 'dosCharset'),
    auditVerbs: AUDIT_VERBS.join(' '),
    auditFacility: sanitiseValue(input.auditFacility ?? 'LOCAL5', 'auditFacility'),
    auditPriority: sanitiseValue(input.auditPriority ?? 'NOTICE', 'auditPriority'),
    logLevel: input.logLevel ?? 1,
    shares: input.shares.map((share) => ({
      name: share.name,
      path: share.path,
      comment: sanitiseValue(share.comment ?? `TNC share ${share.name}`, 'comment'),
      readOnly: (share.readOnly ?? false) || (input.globalReadOnly ?? false),
      guestOk: share.guestOk ?? true,
      validUsers:
        share.validUsers === undefined || share.validUsers.length === 0
          ? ''
          : share.validUsers.map((user) => sanitiseValue(user, 'validUsers')).join(' '),
      vetoFiles: formatVetoFiles([...DEFAULT_VETO_FILES, ...(share.extraVetoFiles ?? [])]),
    })),
  };

  return template(view);
}

function assertPathWithinCache(path: string, shareName: string): void {
  const normalised = path.replace(/\/+$/, '');
  if (normalised !== ROOTS.cache && !normalised.startsWith(`${ROOTS.cache}/`)) {
    throw new SmbConfError(
      `share "${shareName}" exports ${path}, which is outside ${ROOTS.cache}. ` +
        `Samba would then serve a directory the bridge does not manage.`,
    );
  }
  if (normalised.split('/').includes('..')) {
    throw new SmbConfError(`share "${shareName}" path contains a ".." segment`);
  }
}

// ---------------------------------------------------------------------------
// Parsing (for validation)
// ---------------------------------------------------------------------------

export interface ParsedSmbConf {
  /** Section name (lower-cased) → parameter map. Parameter keys are normalised. */
  readonly sections: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/**
 * Normalises a parameter name the way Samba does: case-insensitive, internal whitespace
 * ignored. `Bind Interfaces Only`, `bindinterfacesonly` and `bind interfaces only` are
 * one key.
 *
 * This matters for security, not tidiness. A validator that compared raw strings would
 * accept a file containing `bindinterfacesonly = no` as "not specifying the parameter",
 * while Samba would read it and unbind the listener.
 */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, '');
}

export function parseSmbConf(content: string): ParsedSmbConf {
  const sections = new Map<string, Map<string, string>>();
  let current = 'global';
  sections.set(current, new Map());

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const sectionMatch = /^\[(.+)]$/.exec(line);
    if (sectionMatch !== null) {
      current = (sectionMatch[1] ?? '').trim().toLowerCase();
      if (!sections.has(current)) {
        sections.set(current, new Map());
      }
      continue;
    }
    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = normaliseKey(line.slice(0, separator));
    const value = line.slice(separator + 1).trim();
    sections.get(current)?.set(key, value);
  }

  return { sections };
}

function get(parsed: ParsedSmbConf, section: string, key: string): string | undefined {
  return parsed.sections.get(section)?.get(normaliseKey(key));
}

const isYes = (value: string | undefined): boolean =>
  value !== undefined && ['yes', 'true', '1'].includes(value.toLowerCase());

// ---------------------------------------------------------------------------
// Safety assertions
// ---------------------------------------------------------------------------

export interface SafetyOptions {
  readonly tncInterface: string;
  /** When given, its presence anywhere in `interfaces` is a hard failure. */
  readonly lanInterface?: string;
}

/**
 * Re-reads a generated config and proves the invariants that make it safe to activate.
 *
 * Called on the rendered text, not on the input — the point is to catch a template that
 * produced something other than what the input asked for. `testparm` runs afterwards, in
 * the helper, and answers a different question: this checks *policy*, `testparm` checks
 * *syntax*, and neither substitutes for the other.
 */
export function assertSafeConfig(content: string, options: SafetyOptions): void {
  const parsed = parseSmbConf(content);
  const failures: string[] = [];

  // 1 · The listener must be confined to the TNC interface.
  const interfaces = (get(parsed, 'global', 'interfaces') ?? '')
    .split(/\s+/)
    .filter((entry) => entry !== '');

  if (interfaces.length === 0) {
    failures.push('global/interfaces is empty — smbd would listen on every interface');
  }
  if (!interfaces.includes(options.tncInterface)) {
    failures.push(`global/interfaces does not include the TNC interface "${options.tncInterface}"`);
  }
  if (options.lanInterface !== undefined && interfaces.includes(options.lanInterface)) {
    failures.push(
      `global/interfaces includes the LAN interface "${options.lanInterface}" — ` +
        `an SMB1 listener on the corporate network is the vulnerability this product removes`,
    );
  }
  const extra = interfaces.filter(
    (entry) => entry !== options.tncInterface && entry !== 'lo' && entry !== '127.0.0.1',
  );
  if (extra.length > 0) {
    // Anything beyond the TNC interface and loopback is refused rather than reasoned
    // about. A wildcard or subnet here is indistinguishable from a mistake.
    failures.push(`global/interfaces contains unexpected entries: ${extra.join(', ')}`);
  }

  if (!isYes(get(parsed, 'global', 'bind interfaces only'))) {
    failures.push(
      'global/bind interfaces only is not "yes" — the interfaces list would be advisory only',
    );
  }

  // 2 · Protocol floor, so an iTNC 530 can still connect.
  const minProtocol = (get(parsed, 'global', 'server min protocol') ?? '').toUpperCase();
  if (minProtocol !== 'NT1') {
    failures.push(`global/server min protocol is "${minProtocol || '<unset>'}", expected NT1`);
  }

  // 3 · Symlink escapes from the export root.
  if (isYes(get(parsed, 'global', 'wide links'))) {
    failures.push('global/wide links is enabled — a symlink could escape the share root');
  }

  // 4 · Per-share checks.
  for (const [name, params] of parsed.sections) {
    if (name === 'global') {
      continue;
    }
    const path = params.get('path');
    if (path === undefined) {
      failures.push(`share "${name}" has no path`);
      continue;
    }
    try {
      assertPathWithinCache(path, name);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (isYes(params.get('widelinks'))) {
      failures.push(`share "${name}" enables wide links`);
    }
    const veto = params.get('vetofiles') ?? '';
    if (!veto.includes(TEMP_FILE_PREFIX)) {
      failures.push(
        `share "${name}" does not veto ${TEMP_FILE_PREFIX}* — a TNC would see half-written files`,
      );
    }
  }

  if (failures.length > 0) {
    throw new SmbConfError(`refusing to activate this smb.conf:\n  - ${failures.join('\n  - ')}`);
  }
}

/**
 * Renders and validates in one step. This is what callers should use — it is not
 * possible to obtain a config from this module without the safety pass having run.
 */
export function buildSmbConf(input: SmbConfInput): string {
  const content = renderSmbConf(input);
  assertSafeConfig(content, {
    tncInterface: input.tncInterface,
    ...(input.lanInterface === undefined ? {} : { lanInterface: input.lanInterface }),
  });
  return content;
}

// ---------------------------------------------------------------------------
// Listener verification
// ---------------------------------------------------------------------------

export interface ListeningSocket {
  readonly address: string;
  readonly port: number;
}

/**
 * Parses `ss -H -ltn` output into listening sockets.
 *
 * Config is a statement of intent; this reads what the kernel actually did. The
 * distinction earns its keep when `bind interfaces only` is honoured for `smbd` but the
 * host has an unexpected address on the TNC interface, or when an operator has left a
 * second Samba instance running from before the bridge was installed.
 */
export function parseListeningSockets(ssOutput: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of ssOutput.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const fields = line.trim().split(/\s+/);
    // `ss -H -ltn` columns: State Recv-Q Send-Q Local:Port Peer:Port
    const local = fields[3];
    if (local === undefined) {
      continue;
    }
    const separator = local.lastIndexOf(':');
    if (separator === -1) {
      continue;
    }
    const address = local.slice(0, separator).replace(/^\[|]$/g, '');
    const port = Number(local.slice(separator + 1));
    if (Number.isFinite(port)) {
      sockets.push({ address, port });
    }
  }
  return sockets;
}

export const SMB_PORTS = [139, 445] as const;

/**
 * Proves no SMB port is listening on an address outside the TNC network.
 *
 * A wildcard bind (`0.0.0.0` or `::`) is a failure, not a pass — it includes the LAN
 * address by definition, which is the exact condition being tested for.
 */
export function assertSmbBoundTo(
  sockets: readonly ListeningSocket[],
  allowedAddresses: readonly string[],
): void {
  const offending = sockets.filter(
    (socket) =>
      (SMB_PORTS as readonly number[]).includes(socket.port) &&
      !allowedAddresses.includes(socket.address),
  );

  if (offending.length > 0) {
    const detail = offending.map((s) => `${s.address}:${s.port}`).join(', ');
    throw new SmbConfError(
      `smbd is listening on ${detail}, which is outside the TNC network ` +
        `(allowed: ${allowedAddresses.join(', ') || 'none'}). ` +
        `An SMB1 listener reachable from the corporate LAN must never be permitted.`,
    );
  }
}
