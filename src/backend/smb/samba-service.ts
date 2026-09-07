import { execFile } from 'node:child_process';

import { normaliseKey, parseSmbConf } from './smb-conf';

/**
 * Samba service control and `smbstatus` ingestion (T13).
 *
 * Two jobs, joined by the fact that both are about not disturbing the shop floor.
 *
 * **Reload versus restart.** A reload (`smbcontrol all reload-config`) re-reads
 * `smb.conf` while every open SMB session survives. A restart drops them, and a dropped
 * session on a control that is mid-program is a real interruption to production. Most
 * configuration changes need only a reload; a few genuinely cannot be applied without
 * rebinding a socket. {@link decideApplyStrategy} decides which, by diffing the two
 * configs rather than by guessing — the alternative, restarting whenever anything
 * changes, is how a bridge acquires a reputation for interrupting work.
 *
 * **`smbstatus` parsing.** This is one of the two sources feeding the lock manager: the
 * `full_audit` stream (T14) says what just happened, `smbstatus` says what is true right
 * now. Audit events can be missed — a dropped syslog datagram, a restart of this service
 * — so periodic reconciliation against the authoritative kernel-side view is what keeps
 * the lock table from drifting. JSON output is preferred; a text parser covers Samba
 * builds that predate `--json`, because the Debian version on a given Pi image is not
 * something we control.
 *
 * It also guards R1. Upstream Samba has been deprecating SMB1 for years and it can be
 * compiled out entirely. A build without it would let this service start, accept the
 * config, and then quietly fail every TNC connection. {@link checkNt1Support} looks at
 * the build options so that failure happens loudly at startup instead.
 */

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type ServiceRunner = (
  argv: readonly string[],
  options?: { readonly timeoutMs?: number },
) => Promise<CommandOutput>;

export const SMBSTATUS_PATH = '/usr/bin/smbstatus';
export const SMBD_PATH = '/usr/sbin/smbd';

export const defaultRunner: ServiceRunner = (argv, options = {}) =>
  new Promise<CommandOutput>((resolve) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      resolve({ stdout: '', stderr: 'no command', code: -1 });
      return;
    }
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        const errno = error as (Error & { code?: number | string }) | null;
        resolve({
          stdout,
          stderr,
          code: typeof errno?.code === 'number' ? errno.code : errno === null ? 0 : -1,
        });
      },
    );
  });

// ---------------------------------------------------------------------------
// Reload vs restart
// ---------------------------------------------------------------------------

/**
 * Global parameters that a running `smbd` cannot adopt without being restarted.
 *
 * These are the ones bound at socket-open or daemon-init time. Everything else — every
 * share parameter, `read only`, `veto files`, `hosts allow`, adding or removing a share
 * — is picked up by a reload, which is why the list is short and explicit rather than a
 * heuristic.
 */
export const RESTART_REQUIRED_PARAMS = [
  'interfaces',
  'bindinterfacesonly',
  'netbiosname',
  'workgroup',
  'serverminprotocol',
  'servermaxprotocol',
  'disablenetbios',
  'smbports',
  'vfsobjects',
  'full_audit:facility',
  'full_audit:priority',
  'full_audit:prefix',
  'full_audit:success',
  'full_audit:failure',
  'logfile',
  'security',
  'serverrole',
] as const;

export type ApplyStrategy = 'none' | 'reload' | 'restart';

export interface ApplyDecision {
  readonly strategy: ApplyStrategy;
  /** Normalised parameter names that changed. Empty when nothing did. */
  readonly changed: readonly string[];
  /** The subset that forced a restart, for the log line explaining the interruption. */
  readonly restartTriggers: readonly string[];
}

/**
 * Decides how to apply a new config, by diffing it against the current one.
 *
 * The default is the least disruptive option that actually works. A restart is only
 * chosen when a parameter in {@link RESTART_REQUIRED_PARAMS} changed in the global
 * section — and the decision records *which* one, so the log line explains to an
 * operator why their sessions were dropped.
 */
export function decideApplyStrategy(currentConf: string, nextConf: string): ApplyDecision {
  if (currentConf.trim() === nextConf.trim()) {
    return { strategy: 'none', changed: [], restartTriggers: [] };
  }

  const current = parseSmbConf(currentConf);
  const next = parseSmbConf(nextConf);
  const changed = new Set<string>();

  const sectionNames = new Set([...current.sections.keys(), ...next.sections.keys()]);
  for (const section of sectionNames) {
    const before = current.sections.get(section) ?? new Map<string, string>();
    const after = next.sections.get(section) ?? new Map<string, string>();
    const keys = new Set([...before.keys(), ...after.keys()]);
    for (const key of keys) {
      if (before.get(key) !== after.get(key)) {
        changed.add(section === 'global' ? key : `${section}/${key}`);
      }
    }
  }

  const restartSet = new Set<string>(RESTART_REQUIRED_PARAMS.map(normaliseKey));
  const restartTriggers = [...changed].filter((key) => restartSet.has(key));

  if (changed.size === 0) {
    // The files differ only in comments or whitespace. Nothing to apply.
    return { strategy: 'none', changed: [], restartTriggers: [] };
  }

  return {
    strategy: restartTriggers.length > 0 ? 'restart' : 'reload',
    changed: [...changed].sort(),
    restartTriggers: restartTriggers.sort(),
  };
}

// ---------------------------------------------------------------------------
// NT1 support (R1)
// ---------------------------------------------------------------------------

export type Nt1Support = 'supported' | 'unsupported' | 'unknown';

export interface Nt1Result {
  readonly support: Nt1Support;
  readonly detail: string;
}

/**
 * Reads `smbd -b` build options to decide whether this Samba can still speak SMB1.
 *
 * The result is deliberately tri-state. Samba has spelled this flag differently across
 * versions, and claiming certainty from a string match that happens to miss would either
 * refuse to start on a perfectly good build or — far worse — report support that is not
 * there. `unknown` is an honest answer, and the caller escalates it to a warning rather
 * than a fatal error.
 */
export function checkNt1Support(buildOutput: string): Nt1Result {
  const text = buildOutput.toUpperCase();

  if (/WITHOUT[_-]SMB1[_-]SERVER/.test(text) || text.includes('SMB1 SUPPORT DISABLED')) {
    return {
      support: 'unsupported',
      detail: 'the installed smbd was built without SMB1 server support',
    };
  }
  if (text.includes('WITH_SMB1_SERVER')) {
    return { support: 'supported', detail: 'smbd reports WITH_SMB1_SERVER' };
  }
  if (text.includes('WITH_SMB1')) {
    return { support: 'supported', detail: 'smbd reports SMB1 build support' };
  }
  // Older builds predate the flag entirely and always carried SMB1.
  if (/SAMBA VERSION 4\.(?:[0-9]|10)\./.test(text)) {
    return { support: 'supported', detail: 'Samba build predates the SMB1 compile-time toggle' };
  }
  return {
    support: 'unknown',
    detail: 'could not determine SMB1 support from the smbd build options',
  };
}

export class SambaUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SambaUnsupportedError';
  }
}

// ---------------------------------------------------------------------------
// smbstatus model
// ---------------------------------------------------------------------------

export interface SmbSession {
  readonly sessionId: string;
  readonly pid: number | null;
  readonly username: string | null;
  readonly group: string | null;
  /** The TNC's IP, which is how a lock is attributed to a machine. */
  readonly remoteMachine: string | null;
  readonly dialect: string | null;
  readonly encryption: string | null;
  readonly signing: string | null;
}

export interface SmbTcon {
  readonly service: string;
  readonly pid: number | null;
  readonly machine: string | null;
}

export interface SmbOpenFile {
  readonly pid: number | null;
  readonly uid: number | null;
  readonly denyMode: string | null;
  readonly access: string | null;
  readonly rw: string | null;
  readonly oplock: string | null;
  /** Export root of the share, e.g. `/srv/tnc/programs`. */
  readonly sharePath: string | null;
  /** Path relative to `sharePath`, or the raw name when the share path is unknown. */
  readonly filename: string;
  readonly openedAt: string | null;
}

export interface SmbStatus {
  readonly version: string | null;
  readonly sessions: readonly SmbSession[];
  readonly tcons: readonly SmbTcon[];
  readonly openFiles: readonly SmbOpenFile[];
  /** Which parser produced this, so a support ticket can say. */
  readonly source: 'json' | 'text';
}

const EMPTY_STATUS: SmbStatus = {
  version: null,
  sessions: [],
  tcons: [],
  openFiles: [],
  source: 'json',
};

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `smbstatus --json`.
 *
 * Samba's JSON keys have moved between releases (`open_files` versus `open-files`,
 * `remote_machine` versus `machine`, sessions keyed by id versus arrayed), so every
 * lookup accepts the spellings seen in the wild and every field degrades to `null`
 * rather than throwing. A parse that loses one optional attribute is recoverable; one
 * that throws takes the lock reconciler down with it.
 */
export function parseSmbStatusJson(raw: string): SmbStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('smbstatus did not return valid JSON');
  }
  const root = asRecord(parsed);

  const sessionsRaw = root.sessions;
  const sessionEntries = Array.isArray(sessionsRaw)
    ? sessionsRaw
    : Object.values(asRecord(sessionsRaw));

  const sessions: SmbSession[] = sessionEntries.map((entry) => {
    const session = asRecord(entry);
    const serverId = asRecord(session.server_id);
    return {
      sessionId: toStringOrNull(session.session_id) ?? '',
      pid: toNumber(serverId.pid) ?? toNumber(session.pid),
      username: toStringOrNull(session.username),
      group: toStringOrNull(session.groupname) ?? toStringOrNull(session.group),
      remoteMachine:
        toStringOrNull(session.remote_machine) ?? toStringOrNull(session.machine),
      dialect:
        toStringOrNull(session.session_dialect) ??
        toStringOrNull(session.dialect) ??
        toStringOrNull(session.protocol_version),
      encryption: toStringOrNull(asRecord(session.encryption).degree),
      signing: toStringOrNull(asRecord(session.signing).degree),
    };
  });

  const tconsRaw = root.tcons;
  const tconEntries = Array.isArray(tconsRaw) ? tconsRaw : Object.values(asRecord(tconsRaw));
  const tcons: SmbTcon[] = tconEntries.map((entry) => {
    const tcon = asRecord(entry);
    return {
      service: toStringOrNull(tcon.service) ?? '',
      pid: toNumber(asRecord(tcon.server_id).pid) ?? toNumber(tcon.pid),
      machine: toStringOrNull(tcon.machine),
    };
  });

  const openFilesRaw = asRecord(root.open_files ?? root['open-files']);
  const openFiles: SmbOpenFile[] = [];

  for (const [key, value] of Object.entries(openFilesRaw)) {
    const file = asRecord(value);
    const sharePath = toStringOrNull(file.service_path);
    const filename = toStringOrNull(file.filename) ?? key;

    // Newer Samba nests one entry per open handle. A file opened twice is two locks,
    // which matters: the second opener is what R15 calls write contention.
    const opens = asRecord(file.opens);
    const openEntries = Object.values(opens);

    if (openEntries.length === 0) {
      openFiles.push({
        pid: null,
        uid: null,
        denyMode: null,
        access: null,
        rw: null,
        oplock: null,
        sharePath,
        filename,
        openedAt: null,
      });
      continue;
    }

    for (const openEntry of openEntries) {
      const open = asRecord(openEntry);
      openFiles.push({
        pid: toNumber(asRecord(open.server_id).pid),
        uid: toNumber(open.uid),
        denyMode: toStringOrNull(asRecord(open.sharemode).text),
        access: toStringOrNull(asRecord(open.access_mask).text),
        rw: toStringOrNull(asRecord(open.access_mask).text),
        oplock: toStringOrNull(asRecord(open.oplock).text),
        sharePath,
        filename,
        openedAt: toStringOrNull(open.opened_at) ?? toStringOrNull(open.time),
      });
    }
  }

  return {
    version: toStringOrNull(root.version),
    sessions,
    tcons,
    openFiles,
    source: 'json',
  };
}

/**
 * Fallback parser for `smbstatus` plain text.
 *
 * Column-position parsing would be brittle across versions, so this splits on runs of
 * whitespace and reads positionally within each of the three blocks. It exists for
 * Samba builds without `--json`, which is not a hypothetical on older Pi images.
 */
export function parseSmbStatusText(raw: string): SmbStatus {
  const lines = raw.split('\n');
  const sessions: SmbSession[] = [];
  const tcons: SmbTcon[] = [];
  const openFiles: SmbOpenFile[] = [];

  let block: 'none' | 'sessions' | 'tcons' | 'files' = 'none';
  let version: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    const versionMatch = /^Samba version (.+)$/.exec(trimmed);
    if (versionMatch !== null) {
      version = versionMatch[1] ?? null;
      continue;
    }
    if (/^PID\s+Username\s+Group/.test(trimmed)) {
      block = 'sessions';
      continue;
    }
    if (/^Service\s+pid\s+Machine/.test(trimmed)) {
      block = 'tcons';
      continue;
    }
    if (trimmed.startsWith("Locked files:")) {
      block = 'files';
      continue;
    }
    if (/^Pid\s+User\(ID\)\s+DenyMode/.test(trimmed)) {
      continue;
    }
    if (trimmed === '' || /^-+$/.test(trimmed)) {
      continue;
    }
    if (trimmed.startsWith('No locked files')) {
      block = 'none';
      continue;
    }

    const fields = trimmed.split(/\s+/);

    if (block === 'sessions') {
      const [pid, username, group, machine, dialect, encryption, signing] = fields;
      sessions.push({
        sessionId: pid ?? '',
        pid: toNumber(pid),
        username: username ?? null,
        group: group ?? null,
        remoteMachine: machine ?? null,
        dialect: dialect ?? null,
        encryption: encryption ?? null,
        signing: signing ?? null,
      });
      continue;
    }

    if (block === 'tcons') {
      const [service, pid, machine] = fields;
      tcons.push({ service: service ?? '', pid: toNumber(pid), machine: machine ?? null });
      continue;
    }

    if (block === 'files') {
      const [pid, uid, denyMode, access, rw, oplock, sharePath, name] = fields;
      if (name === undefined) {
        continue;
      }
      openFiles.push({
        pid: toNumber(pid),
        uid: toNumber(uid),
        denyMode: denyMode ?? null,
        access: access ?? null,
        rw: rw ?? null,
        oplock: oplock ?? null,
        sharePath: sharePath ?? null,
        filename: name,
        openedAt: null,
      });
    }
  }

  return { version, sessions, tcons, openFiles, source: 'text' };
}

/**
 * Resolves an open file to a share-relative path.
 *
 * `smbstatus` reports the share's export root and a name that may itself contain
 * directories. The lock table is keyed on the relative path, so this is what joins the
 * two views together.
 */
export function toRelativePath(file: SmbOpenFile, cachePath: string): string | null {
  const name = file.filename.replace(/^\.\//, '');
  if (name === '' || name === '.') {
    return null;
  }
  if (file.sharePath !== null) {
    const root = file.sharePath.replace(/\/+$/, '');
    if (root !== cachePath.replace(/\/+$/, '')) {
      return null;
    }
  }
  if (name.startsWith('/')) {
    const root = cachePath.replace(/\/+$/, '');
    return name.startsWith(`${root}/`) ? name.slice(root.length + 1) : null;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

export type PrivilegedReload = (mode: 'reload' | 'restart') => void | Promise<void>;

export interface SambaServiceOptions {
  readonly run?: ServiceRunner;
  readonly reload?: PrivilegedReload;
  readonly smbstatusPath?: string;
  readonly smbdPath?: string;
  readonly logger?: {
    info(object: Record<string, unknown>, message: string): void;
    warn(object: Record<string, unknown>, message: string): void;
    error(object: Record<string, unknown>, message: string): void;
  };
}

export class SambaService {
  private readonly run: ServiceRunner;
  private readonly reloadFn: PrivilegedReload | undefined;
  private readonly smbstatusPath: string;
  private readonly smbdPath: string;
  private readonly log: SambaServiceOptions['logger'];

  constructor(options: SambaServiceOptions = {}) {
    this.run = options.run ?? defaultRunner;
    this.reloadFn = options.reload;
    this.smbstatusPath = options.smbstatusPath ?? SMBSTATUS_PATH;
    this.smbdPath = options.smbdPath ?? SMBD_PATH;
    this.log = options.logger;
  }

  /**
   * Reads live status, preferring JSON and falling back to text.
   *
   * A failure here returns empty rather than throwing. `smbstatus` is a reconciliation
   * input, and a bridge that stops syncing because it could not enumerate sessions has
   * confused a diagnostic for a dependency.
   */
  async status(): Promise<SmbStatus> {
    const json = await this.run([this.smbstatusPath, '--json']);
    if (json.code === 0 && json.stdout.trim().startsWith('{')) {
      try {
        return parseSmbStatusJson(json.stdout);
      } catch {
        this.log?.warn({}, 'smbstatus --json was unparseable; falling back to the text parser');
      }
    }

    const text = await this.run([this.smbstatusPath]);
    if (text.code !== 0) {
      this.log?.warn(
        { code: text.code, stderr: text.stderr.trim() },
        'smbstatus failed; treating as no active sessions',
      );
      return EMPTY_STATUS;
    }
    return parseSmbStatusText(text.stdout);
  }

  /**
   * Verifies the installed `smbd` can still speak SMB1 (R1).
   *
   * Throws on a positively-unsupported build, because starting anyway would produce a
   * bridge that looks healthy and fails every TNC connection. An indeterminate answer is
   * logged loudly and allowed through — refusing to start on a string match we are not
   * sure about would be its own outage.
   */
  async assertNt1Supported(): Promise<Nt1Result> {
    const build = await this.run([this.smbdPath, '-b']);
    const result = checkNt1Support(`${build.stdout}\n${build.stderr}`);

    if (result.support === 'unsupported') {
      throw new SambaUnsupportedError(
        `${result.detail}. HEIDENHAIN controls such as the iTNC 530 speak nothing newer ` +
          `than SMB1, so this bridge cannot function. Pin and hold the samba package, ` +
          `or build Samba with SMB1 server support (R1).`,
      );
    }
    if (result.support === 'unknown') {
      this.log?.warn({ detail: result.detail }, 'could not confirm SMB1 support in smbd');
    } else {
      this.log?.info({ detail: result.detail }, 'smbd SMB1 support confirmed');
    }
    return result;
  }

  /** Applies a new config with the least disruptive method that works. */
  async apply(currentConf: string, nextConf: string): Promise<ApplyDecision> {
    const decision = decideApplyStrategy(currentConf, nextConf);

    if (decision.strategy === 'none') {
      return decision;
    }
    if (decision.strategy === 'restart') {
      this.log?.warn(
        { triggers: decision.restartTriggers },
        'restarting smbd — these parameters cannot be applied to a running daemon, ' +
          'so open TNC sessions will be dropped',
      );
    } else {
      this.log?.info({ changed: decision.changed }, 'reloading smbd; sessions are preserved');
    }

    await this.reloadFn?.(decision.strategy);
    return decision;
  }
}
