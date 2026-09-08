import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type LocalisedMessage,
  type SmbFailureKind,
  type TestSmbResponse,
} from '../../shared/schemas/connectivity';

/**
 * The SMB connectivity tester (T11).
 *
 * This is what stands behind the "Verbindung testen" button, and its entire value is in
 * one distinction: **a wrong password, a wrong share name and a blocked port must be
 * three different answers.** An installer who is told "connection failed" learns nothing
 * and starts guessing; an installer who is told "the account svc-tnc exists but the
 * password was rejected" is finished in a minute. Every failure this module can
 * recognise therefore produces a typed kind, a message in German and English, and a
 * concrete next step.
 *
 * It runs `smbclient` rather than mounting, deliberately. Mounting requires root and
 * changes system state; a diagnostic must be safe to press repeatedly, from the setup
 * wizard, before any share exists.
 *
 * **The password never appears in argv.** `/proc/<pid>/cmdline` is world-readable, so
 * `-U user%password` publishes the AD service account to every local process for the
 * lifetime of the call. Samba's client tools read `$PASSWD`, and `/proc/<pid>/environ`
 * is readable only by the owning user and root. That is not perfect secrecy — it is one
 * category better than the obvious approach, for no cost.
 */

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly timedOut: boolean;
}

export type SmbRunner = (
  argv: readonly string[],
  options: { readonly password?: string; readonly timeoutMs: number },
) => Promise<CommandOutput>;

export const SMBCLIENT_PATH = '/usr/bin/smbclient';

/**
 * Runs `smbclient` with an argv array and no shell.
 *
 * A non-zero exit is a normal outcome here — it is how `smbclient` reports every
 * failure this module exists to classify — so it resolves rather than rejects, and the
 * caller reads `code` alongside the output.
 */
export const defaultRunner: SmbRunner = (argv, options) =>
  new Promise<CommandOutput>((resolve) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      resolve({ stdout: '', stderr: 'no command', code: -1, timedOut: false });
      return;
    }
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          // Forces machine-parseable English regardless of the host locale. Parsing
          // `smbclient` output translated into German would be a delightful bug.
          LC_ALL: 'C',
          ...(options.password === undefined ? {} : { PASSWD: options.password }),
        },
      },
      (error, stdout, stderr) => {
        const errno = error as (Error & { code?: number | string; killed?: boolean }) | null;
        resolve({
          stdout,
          stderr,
          code: typeof errno?.code === 'number' ? errno.code : errno === null ? 0 : -1,
          timedOut: errno?.killed === true,
        });
      },
    );
  });

// ---------------------------------------------------------------------------
// UNC parsing
// ---------------------------------------------------------------------------

export interface ParsedUnc {
  readonly host: string;
  readonly share: string;
  /** Sub-path below the share, `''` when the UNC names the share root. */
  readonly path: string;
}

/** Accepts both `//server/share/sub` and `\\server\share\sub`. */
export function parseUnc(unc: string): ParsedUnc {
  const normalised = unc.replace(/\\/g, '/');
  const match = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(normalised);
  if (match === null) {
    throw new Error(`not a UNC path: ${unc}`);
  }
  const [, host = '', share = '', path = ''] = match;
  return { host, share, path: path.replace(/\/+$/, '') };
}

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

interface FailureRule {
  readonly kind: SmbFailureKind;
  /** Matched against the combined stdout+stderr, upper-cased. */
  readonly patterns: readonly string[];
  readonly message: LocalisedMessage;
  readonly remediation: LocalisedMessage;
}

/**
 * Ordered most-specific first. `NT_STATUS_ACCESS_DENIED` after the account-state codes,
 * because a locked account can report either and the more precise diagnosis is the
 * useful one; `host_unreachable` last, because it is the catch-all for a dead link.
 */
export const FAILURE_RULES: readonly FailureRule[] = [
  {
    kind: 'account_locked',
    patterns: ['NT_STATUS_ACCOUNT_LOCKED_OUT'],
    message: {
      de: 'Das Dienstkonto ist gesperrt.',
      en: 'The service account is locked out.',
    },
    remediation: {
      de: 'Konto in Active Directory entsperren. Wiederholte Fehlanmeldungen der Bridge mit falschem Passwort sind die häufigste Ursache.',
      en: 'Unlock the account in Active Directory. Repeated failed logons from the bridge with a stale password are the usual cause.',
    },
  },
  {
    kind: 'account_expired',
    patterns: [
      'NT_STATUS_ACCOUNT_EXPIRED',
      'NT_STATUS_PASSWORD_EXPIRED',
      'NT_STATUS_PASSWORD_MUST_CHANGE',
      'NT_STATUS_ACCOUNT_DISABLED',
    ],
    message: {
      de: 'Das Passwort oder das Konto des Dienstkontos ist abgelaufen bzw. deaktiviert.',
      en: 'The service account password has expired, or the account is disabled.',
    },
    remediation: {
      de: 'Für das Dienstkonto "Passwort läuft nie ab" setzen und das Konto aktivieren, sonst bricht die Synchronisation beim nächsten Ablauf erneut ab.',
      en: 'Set "password never expires" on the service account and enable it, otherwise sync breaks again at the next expiry.',
    },
  },
  {
    kind: 'auth_failed',
    patterns: ['NT_STATUS_LOGON_FAILURE', 'NT_STATUS_WRONG_PASSWORD'],
    message: {
      de: 'Anmeldung fehlgeschlagen: Benutzername, Domäne oder Passwort ist falsch.',
      en: 'Logon failed: the username, domain or password is wrong.',
    },
    remediation: {
      de: 'Benutzername im Format DOMAENE\\benutzer oder benutzer@domaene.local prüfen und das Passwort neu eingeben. Der Server ist erreichbar — nur die Zugangsdaten werden abgelehnt.',
      en: 'Check the username (DOMAIN\\user or user@domain.local) and re-enter the password. The server is reachable — only the credentials are being rejected.',
    },
  },
  {
    kind: 'share_not_found',
    patterns: [
      'NT_STATUS_BAD_NETWORK_NAME',
      'NT_STATUS_OBJECT_PATH_NOT_FOUND',
      'NT_STATUS_OBJECT_NAME_NOT_FOUND',
    ],
    message: {
      de: 'Die Freigabe existiert auf diesem Server nicht.',
      en: 'The share does not exist on this server.',
    },
    remediation: {
      de: 'Freigabenamen prüfen (Groß-/Kleinschreibung ist unerheblich, versteckte Freigaben enden auf $). Die Anmeldung war erfolgreich — nur der Freigabename stimmt nicht.',
      en: 'Check the share name (case does not matter; hidden shares end in $). Authentication succeeded — only the share name is wrong.',
    },
  },
  {
    kind: 'access_denied',
    patterns: ['NT_STATUS_ACCESS_DENIED', 'NT_STATUS_NETWORK_ACCESS_DENIED'],
    message: {
      de: 'Zugriff verweigert: Die Anmeldung war erfolgreich, das Konto darf die Freigabe aber nicht nutzen.',
      en: 'Access denied: authentication succeeded, but the account may not use this share.',
    },
    remediation: {
      de: 'Freigabe- und NTFS-Berechtigungen für das Dienstkonto prüfen. Beide müssen Lesen und Schreiben erlauben — die restriktivere gewinnt.',
      en: 'Check both the share permissions and the NTFS ACL for the service account. Both must allow read and write — the more restrictive one wins.',
    },
  },
  {
    kind: 'clock_skew',
    patterns: ['NT_STATUS_TIME_DIFFERENCE_AT_DC', 'KRB5KRB_AP_ERR_SKEW', 'CLOCK SKEW TOO GREAT'],
    message: {
      de: 'Die Uhrzeit der Bridge weicht zu stark vom Domänencontroller ab.',
      en: "The bridge's clock differs too much from the domain controller.",
    },
    remediation: {
      de: 'Zeitsynchronisation prüfen (chrony). Kerberos toleriert maximal 5 Minuten Abweichung. Dies verfälscht außerdem die Konflikterkennung nach Zeitstempel (R8).',
      en: 'Check time synchronisation (chrony). Kerberos tolerates at most 5 minutes of drift. Skew also corrupts last-write-wins conflict resolution (R8).',
    },
  },
  {
    kind: 'name_resolution_failed',
    patterns: [
      'FAILED TO RESOLVE',
      'UNABLE TO RESOLVE',
      'NAME_RESOLUTION',
      'COULD NOT RESOLVE',
      'NT_STATUS_RESOURCE_NAME_NOT_FOUND',
    ],
    message: {
      de: 'Der Servername konnte nicht aufgelöst werden.',
      en: 'The server name could not be resolved.',
    },
    remediation: {
      de: 'DNS-Server der LAN-Schnittstelle prüfen oder den Server direkt über seine IP-Adresse eintragen.',
      en: 'Check the DNS servers on the LAN interface, or address the server by IP instead.',
    },
  },
  {
    kind: 'signing_required',
    patterns: ['NT_STATUS_INVALID_PARAMETER_MIX', 'SIGNING REQUIRED', 'SERVER REQUIRES SIGNING'],
    message: {
      de: 'Der Server verlangt SMB-Signierung, die ausgehandelte Verbindung erfüllt das nicht.',
      en: 'The server requires SMB signing and the negotiated connection does not provide it.',
    },
    remediation: {
      de: 'SMB-Version 3.1.1 mit aktivierter Verschlüsselung verwenden. Diese Einstellung betrifft nur die LAN-Seite — die TNC-Seite bleibt bei NT1 ohne Signierung.',
      en: 'Use SMB 3.1.1 with encryption enabled. This affects the LAN side only — the TNC side stays on NT1 without signing.',
    },
  },
  {
    kind: 'protocol_negotiation_failed',
    patterns: [
      'PROTOCOL NEGOTIATION FAILED',
      'NT_STATUS_INVALID_NETWORK_RESPONSE',
      'NT_STATUS_NOT_SUPPORTED',
      'NO PROTOCOL SUPPORTED',
    ],
    message: {
      de: 'Es konnte kein gemeinsames SMB-Protokoll ausgehandelt werden.',
      en: 'No common SMB protocol could be negotiated.',
    },
    remediation: {
      de: 'Der Server unterstützt die geforderte SMB-Version möglicherweise nicht. SMB 3.0 statt 3.1.1 versuchen. SMB1 ist auf der Server-Seite bewusst nicht erlaubt.',
      en: 'The server may not support the requested dialect. Try SMB 3.0 instead of 3.1.1. SMB1 is deliberately not offered on the server side.',
    },
  },
  {
    kind: 'port_blocked',
    patterns: ['NT_STATUS_CONNECTION_REFUSED', 'CONNECTION REFUSED', 'NT_STATUS_PORT_UNREACHABLE'],
    message: {
      de: 'Der Server hat die Verbindung auf Port 445 aktiv abgelehnt.',
      en: 'The server actively refused the connection on port 445.',
    },
    remediation: {
      de: 'Firewall zwischen Bridge und Server sowie den Dienst "Server" (LanmanServer) auf dem Zielsystem prüfen. Aktive Ablehnung heißt: der Host lebt, der Port ist zu.',
      en: 'Check the firewall between bridge and server, and that the "Server" (LanmanServer) service is running. An active refusal means the host is alive but the port is closed.',
    },
  },
  {
    kind: 'host_unreachable',
    patterns: [
      'NT_STATUS_HOST_UNREACHABLE',
      'NT_STATUS_NETWORK_UNREACHABLE',
      'NT_STATUS_IO_TIMEOUT',
      'NT_STATUS_CONNECTION_DISCONNECTED',
      'NT_STATUS_UNSUCCESSFUL',
      'CONNECTION TO ',
    ],
    message: {
      de: 'Der Server ist nicht erreichbar.',
      en: 'The server is unreachable.',
    },
    remediation: {
      de: 'Netzwerkverbindung der LAN-Schnittstelle, Routing und Erreichbarkeit von Port 445 prüfen. Häufigste Ursache: die Bridge hängt am falschen Netzwerkport.',
      en: 'Check the LAN interface link, routing, and reachability of port 445. The most common cause is the bridge being plugged into the wrong port.',
    },
  },
];

const UNKNOWN_FAILURE: Omit<FailureRule, 'patterns'> = {
  kind: 'unknown',
  message: {
    de: 'Die Verbindung ist aus einem nicht erkannten Grund fehlgeschlagen.',
    en: 'The connection failed for an unrecognised reason.',
  },
  remediation: {
    de: 'Rohausgabe im Log prüfen (Quelle "smb"). Bitte diese Ausgabe einem Fehlerbericht beilegen.',
    en: 'Check the raw output in the log (source "smb"). Please attach it to a bug report.',
  },
};

export interface ClassifiedFailure {
  readonly kind: SmbFailureKind;
  readonly message: LocalisedMessage;
  readonly remediation: LocalisedMessage;
}

/** Maps raw `smbclient` output to a typed failure with actionable advice. */
export function classifyFailure(output: string): ClassifiedFailure {
  const haystack = output.toUpperCase();
  for (const rule of FAILURE_RULES) {
    if (rule.patterns.some((pattern) => haystack.includes(pattern))) {
      return { kind: rule.kind, message: rule.message, remediation: rule.remediation };
    }
  }
  return UNKNOWN_FAILURE;
}

/** A timeout has no NT_STATUS to match on, so it is classified separately. */
export const TIMEOUT_FAILURE: ClassifiedFailure = {
  kind: 'host_unreachable',
  message: {
    de: 'Zeitüberschreitung: Der Server hat nicht geantwortet.',
    en: 'Timed out: the server did not answer.',
  },
  remediation: {
    de: 'Der Host verwirft Pakete stumm — typisch für eine Firewall mit DROP-Regel oder ein falsches VLAN. Ein abgelehnter Port würde sofort antworten.',
    en: 'The host is dropping packets silently — typical of a firewall DROP rule or the wrong VLAN. A closed port would answer immediately.',
  },
};

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Share names from the `smbclient -L` listing.
 *
 * The table is fixed-column, terminated by a blank line, and administrative shares are
 * dropped — offering `IPC$` or `ADMIN$` as a sync target in the UI would be noise at
 * best.
 */
export function parseShares(output: string): string[] {
  const shares: string[] = [];
  const lines = output.split('\n');
  let inTable = false;

  for (const line of lines) {
    if (/^\s*Sharename\s+Type\s+Comment/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) {
      continue;
    }
    if (/^\s*-+\s+-+/.test(line)) {
      continue;
    }
    if (line.trim() === '') {
      break;
    }
    const match = /^\s+(\S+)\s+(Disk|IPC|Printer|Device)\s*/.exec(line);
    const name = match?.[1];
    if (name !== undefined && !name.endsWith('$')) {
      shares.push(name);
    }
  }
  return shares;
}

/**
 * The negotiated dialect, from whichever form the installed Samba version prints.
 *
 * Samba has changed this wording more than once across releases, so several spellings
 * are accepted and `null` is a legitimate result — the dialect is diagnostic colour, not
 * something a decision depends on.
 */
export function parseDialect(output: string): string | null {
  const patterns = [
    /negotiated dialect\[(\w+)\]/i,
    /Selected protocol \[?(SMB[\w.]*)\]?/i,
    /dialect\s*=\s*(SMB[\w.]*)/i,
    /protocol negotiated:\s*(\S+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    const dialect = match?.[1];
    if (dialect !== undefined) {
      return dialect.toUpperCase().replace('SMB3_11', 'SMB3.1.1');
    }
  }
  return null;
}

/** GENSEC mechanism, when the debug output names one. */
export function parseAuthMethod(output: string): string | null {
  const lower = output.toLowerCase();
  if (lower.includes('krb5') || lower.includes('kerberos')) {
    return 'Kerberos';
  }
  if (lower.includes('ntlmssp')) {
    return 'NTLMSSP';
  }
  if (/anonymous|guest/i.test(output)) {
    return 'Anonymous';
  }
  return null;
}

/** `smbclient -c du` ends with a block summary; converts it to free bytes. */
export function parseFreeBytes(output: string): number | null {
  const match = /(\d+)\s+blocks of size\s+(\d+)\.\s*(\d+)\s+blocks available/i.exec(output);
  if (match === null) {
    return null;
  }
  const blockSize = Number(match[2]);
  const available = Number(match[3]);
  if (!Number.isFinite(blockSize) || !Number.isFinite(available)) {
    return null;
  }
  return blockSize * available;
}

/** Encryption is only ever reported positively; absence means "not stated", not "off". */
export function parseEncryption(output: string): boolean | null {
  if (/encryption:\s*(on|enabled)/i.test(output) || /smb encryption is enabled/i.test(output)) {
    return true;
  }
  if (/encryption:\s*(off|disabled)/i.test(output)) {
    return false;
  }
  return null;
}

export function parseSigning(output: string): boolean | null {
  if (/signing:\s*(on|enabled|required)/i.test(output) || /server signing required/i.test(output)) {
    return true;
  }
  if (/signing:\s*(off|disabled)/i.test(output)) {
    return false;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The test itself
// ---------------------------------------------------------------------------

export interface SmbTestRequest {
  readonly unc: string;
  readonly domain?: string;
  readonly username?: string;
  readonly password?: string;
  readonly smbVersion?: '3.1.1' | '3.0' | '2.1';
  readonly seal?: boolean;
  /** Skips the write/read/delete probe; the listing alone is non-mutating. */
  readonly probeWrite?: boolean;
}

export interface SmbTesterDeps {
  readonly run?: SmbRunner;
  readonly smbclientPath?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly tmpDir?: string;
  readonly randomToken?: () => string;
  readonly fs?: {
    writeFile(path: string, data: string): Promise<void>;
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    rm(path: string, options: { force: true }): Promise<void>;
  };
}

/** `smbclient`'s spelling of the dialects the mount manager offers. */
const DIALECT_ARG: Record<'3.1.1' | '3.0' | '2.1', string> = {
  '3.1.1': 'SMB3_11',
  '3.0': 'SMB3_00',
  '2.1': 'SMB2_10',
};

function credentialArgs(request: SmbTestRequest): string[] {
  if (request.username === undefined || request.username === '') {
    return ['-N'];
  }
  const user =
    request.domain === undefined || request.domain === ''
      ? request.username
      : `${request.domain}\\${request.username}`;
  // Username only — the password travels in $PASSWD, never in argv.
  return ['-U', user];
}

/**
 * Runs the full probe and returns the structured result the UI renders.
 *
 * Three phases, each of which can end the test early with a specific diagnosis:
 *
 *  1. **List** (`smbclient -L`) — proves the host is reachable, the credentials are
 *     accepted, and reports what shares exist. Most failures land here, which is why it
 *     runs first: it is also the only phase that is guaranteed non-mutating.
 *  2. **Connect** — opens the named share and reads free space. Separating this from the
 *     listing is what makes "wrong password" and "wrong share name" distinguishable.
 *  3. **Write probe** — put, read back, compare, delete. A share that lists and connects
 *     but silently refuses writes is a read-only ACL, and finding that out at
 *     installation time is much better than during the first push.
 */
export async function testSmbConnection(
  request: SmbTestRequest,
  deps: SmbTesterDeps = {},
): Promise<TestSmbResponse> {
  const run = deps.run ?? defaultRunner;
  const smbclient = deps.smbclientPath ?? SMBCLIENT_PATH;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const now = deps.now ?? Date.now;
  const started = now();

  const finish = (partial: Omit<TestSmbResponse, 'durationMs'>): TestSmbResponse => ({
    ...partial,
    durationMs: Math.max(0, now() - started),
  });

  let target: ParsedUnc;
  try {
    target = parseUnc(request.unc);
  } catch {
    return finish({
      success: false,
      dialect: null,
      authMethod: null,
      signing: null,
      encryption: null,
      shares: [],
      freeBytes: null,
      writable: null,
      failure: 'unknown',
      message: {
        de: `"${request.unc}" ist kein gültiger UNC-Pfad.`,
        en: `"${request.unc}" is not a valid UNC path.`,
      },
      remediation: {
        de: 'Format: //server/freigabe oder //server/freigabe/unterordner',
        en: 'Format: //server/share or //server/share/subfolder',
      },
    });
  }

  const dialect = DIALECT_ARG[request.smbVersion ?? '3.1.1'];
  const commonArgs = [
    ...credentialArgs(request),
    '--option=client min protocol=SMB2',
    `--option=client max protocol=${dialect}`,
    ...(request.seal === false ? [] : ['--option=client smb encrypt=desired']),
  ];
  const runOptions = {
    timeoutMs,
    ...(request.password === undefined ? {} : { password: request.password }),
  };

  // -- Phase 1: list ---------------------------------------------------------
  const listing = await run(
    [smbclient, '-L', `//${target.host}`, ...commonArgs, '-d', '1'],
    runOptions,
  );
  const listingText = `${listing.stdout}\n${listing.stderr}`;

  if (listing.timedOut) {
    return finish({
      success: false,
      dialect: null,
      authMethod: null,
      signing: null,
      encryption: null,
      shares: [],
      freeBytes: null,
      writable: null,
      failure: TIMEOUT_FAILURE.kind,
      message: TIMEOUT_FAILURE.message,
      remediation: TIMEOUT_FAILURE.remediation,
    });
  }

  const shares = parseShares(listingText);

  if (listing.code !== 0) {
    const failure = classifyFailure(listingText);
    return finish({
      success: false,
      dialect: parseDialect(listingText),
      authMethod: parseAuthMethod(listingText),
      signing: parseSigning(listingText),
      encryption: parseEncryption(listingText),
      shares,
      freeBytes: null,
      writable: null,
      failure: failure.kind,
      message: failure.message,
      remediation: failure.remediation,
    });
  }

  // -- Phase 2: connect to the named share -----------------------------------
  const shareUnc = `//${target.host}/${target.share}`;
  const connect = await run([smbclient, shareUnc, ...commonArgs, '-c', 'du'], runOptions);
  const connectText = `${connect.stdout}\n${connect.stderr}`;

  if (connect.code !== 0 || connect.timedOut) {
    const failure = connect.timedOut ? TIMEOUT_FAILURE : classifyFailure(connectText);
    return finish({
      success: false,
      dialect: parseDialect(`${listingText}\n${connectText}`),
      authMethod: parseAuthMethod(listingText),
      signing: parseSigning(connectText),
      encryption: parseEncryption(connectText),
      shares,
      freeBytes: null,
      writable: null,
      failure: failure.kind,
      message: failure.message,
      remediation: failure.remediation,
    });
  }

  const combined = `${listingText}\n${connectText}`;
  const base: Omit<TestSmbResponse, 'durationMs' | 'writable'> = {
    success: true,
    dialect: parseDialect(combined),
    authMethod: parseAuthMethod(combined),
    signing: parseSigning(combined),
    encryption: parseEncryption(combined),
    shares,
    freeBytes: parseFreeBytes(connectText),
    failure: null,
    message: {
      de: `Verbindung erfolgreich. Freigabe "${target.share}" auf ${target.host} ist erreichbar.`,
      en: `Connection succeeded. Share "${target.share}" on ${target.host} is reachable.`,
    },
    remediation: null,
  };

  if (request.probeWrite === false) {
    return finish({ ...base, writable: null });
  }

  // -- Phase 3: write / read back / delete -----------------------------------
  const probe = await probeWritable(target, { ...deps, run }, smbclient, commonArgs, {
    timeoutMs,
    ...(request.password === undefined ? {} : { password: request.password }),
  });

  if (!probe.ok) {
    return finish({
      ...base,
      success: false,
      writable: false,
      failure: probe.failure.kind,
      message: probe.failure.message,
      remediation: probe.failure.remediation,
    });
  }

  return finish({ ...base, writable: true });
}

interface ProbeOutcome {
  readonly ok: boolean;
  readonly failure: ClassifiedFailure;
}

const WRITE_DENIED: ClassifiedFailure = {
  kind: 'access_denied',
  message: {
    de: 'Die Freigabe ist erreichbar, aber das Dienstkonto darf nicht schreiben.',
    en: 'The share is reachable, but the service account cannot write to it.',
  },
  remediation: {
    de: 'Schreibrechte für das Dienstkonto erteilen. Ohne sie kann die Bridge Änderungen von der Maschine nicht zurückschreiben und läuft dauerhaft im Nur-Lesen-Modus.',
    en: 'Grant write permission to the service account. Without it the bridge cannot push machine-side edits back and stays permanently read-only.',
  },
};

const ROUNDTRIP_MISMATCH: ClassifiedFailure = {
  kind: 'unknown',
  message: {
    de: 'Die zurückgelesene Testdatei stimmt nicht mit der geschriebenen überein.',
    en: 'The test file read back does not match what was written.',
  },
  remediation: {
    de: 'Datenkorruption auf dem Übertragungsweg. Netzwerkhardware und serverseitige Virenscanner prüfen, die Dateien im Zugriff verändern.',
    en: 'Data is being corrupted in transit. Check network hardware and any server-side virus scanner that rewrites files on access.',
  },
};

/**
 * Writes a small file, reads it back, compares it, and deletes it.
 *
 * The read-back comparison is not ceremony. A share can accept a write and store
 * something else — an antivirus product that quarantines and stubs the file is the
 * usual culprit — and a bridge that only checked the exit code would then sync
 * corrupted NC programs to the shop floor.
 */
async function probeWritable(
  target: ParsedUnc,
  deps: SmbTesterDeps & { run: SmbRunner },
  smbclient: string,
  commonArgs: readonly string[],
  runOptions: { readonly password?: string; readonly timeoutMs: number },
): Promise<ProbeOutcome> {
  const fs = deps.fs ?? {
    writeFile: (path: string, data: string) => fsPromises.writeFile(path, data, 'utf8'),
    readFile: (path: string, encoding: 'utf8') => fsPromises.readFile(path, encoding),
    rm: (path: string, options: { force: true }) => fsPromises.rm(path, options),
  };
  const token = (deps.randomToken ?? (() => randomBytes(8).toString('hex')))();
  const dir = deps.tmpDir ?? tmpdir();
  const localSource = join(dir, `tnc-probe-${token}.tmp`);
  const localReadback = join(dir, `tnc-probe-${token}.back`);
  const remoteName = `.tnc-bridge-probe-${token}`;
  const payload = `tnc-network-bridge connectivity probe ${token}\n`;
  // The sub-path from the UNC, if any, so the probe tests the directory that will
  // actually be synced rather than the share root — permissions frequently differ.
  const remotePath = target.path === '' ? remoteName : `${target.path}/${remoteName}`;

  try {
    await fs.writeFile(localSource, payload);

    const put = await deps.run(
      [
        smbclient,
        `//${target.host}/${target.share}`,
        ...commonArgs,
        '-c',
        `put "${localSource}" "${remotePath}"`,
      ],
      runOptions,
    );
    const putText = `${put.stdout}\n${put.stderr}`;
    if (put.code !== 0 || put.timedOut || putText.includes('NT_STATUS_')) {
      const classified = classifyFailure(putText);
      return {
        ok: false,
        failure: classified.kind === 'unknown' ? WRITE_DENIED : classified,
      };
    }

    const get = await deps.run(
      [
        smbclient,
        `//${target.host}/${target.share}`,
        ...commonArgs,
        '-c',
        `get "${remotePath}" "${localReadback}"`,
      ],
      runOptions,
    );
    const getText = `${get.stdout}\n${get.stderr}`;
    if (get.code !== 0 || getText.includes('NT_STATUS_')) {
      return { ok: false, failure: classifyFailure(getText) };
    }

    const readBack = await fs.readFile(localReadback, 'utf8');
    if (readBack !== payload) {
      return { ok: false, failure: ROUNDTRIP_MISMATCH };
    }

    return { ok: true, failure: UNKNOWN_FAILURE };
  } finally {
    // Always remove the remote probe file, even when an earlier step threw. Leaving
    // `.tnc-bridge-probe-*` litter on a customer's share after a failed test is the kind
    // of detail that erodes trust in everything else the product does.
    await deps
      .run(
        [smbclient, `//${target.host}/${target.share}`, ...commonArgs, '-c', `del "${remotePath}"`],
        runOptions,
      )
      .catch(() => undefined);
    await fs.rm(localSource, { force: true }).catch(() => undefined);
    await fs.rm(localReadback, { force: true }).catch(() => undefined);
  }
}
