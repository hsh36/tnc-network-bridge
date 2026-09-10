import { type BridgeEvent } from '../../shared';
import {
  type UpdateHistoryEntry,
  type UpdateStatus,
  type UpdatePhase,
} from '../../shared/schemas/operations';
import { readFileSync, rmSync } from 'node:fs';

import { type Db } from '../config/db';
import { type ConfigManager } from '../config/config-manager';
import { invokePrivileged, type HelperInvoker } from '../privileged/client';

import { fetchLatestRelease, isNewer, normaliseVersion, type ReleaseInfo } from './github-releases';

/**
 * The single owner of "what version are we on, and is there a newer one".
 *
 * One instance per process, held by the composition root and reached through
 * {@link AppContext} — the routes used to answer `/update/status` from a literal, which
 * is why the UI could never show the result of a check it had just run.
 *
 * Applying is asynchronous in the strongest sense: the updater rebuilds the tree and
 * restarts this process, so the object that starts an update is not the object that
 * sees it finish. Progress therefore travels through a file on disk rather than through
 * this instance, and {@link adoptExternalStatus} picks it up on the next startup.
 */

export interface UpdateManagerOptions {
  readonly currentVersion: string;
  readonly publishEvent: (event: BridgeEvent) => void;
  /** Read for `githubRepo` and `channel` at check time, not at construction. */
  readonly config: ConfigManager;
  /** History outlives the process — an update ends in a restart. */
  readonly db?: Db;
  /** Injected by tests; production uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected by tests; production calls the real helper over sudo. */
  readonly invoke?: HelperInvoker;
  /**
   * Where the updater script reports progress.
   *
   * The updater outlives this process — it restarts it — so its progress cannot come
   * back over a pipe. It writes here; this reads it back at startup, which is the only
   * way the outcome of an update survives the restart that update performed.
   */
  readonly statusFile?: string;
}

/** Where `scripts/self-update.sh` writes its progress. Must match the script. */
export const DEFAULT_STATUS_FILE = '/var/lib/tnc-bridge/update-status.json';

/**
 * Releases are tagged `vX.Y.Z`; versions are reported without the `v`.
 *
 * The tag is what git is asked to check out, so the conversion happens here rather
 * than in the helper — the helper's job is to refuse anything that is not a plausible
 * ref, not to know this project's tagging convention.
 */
function tagFor(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

const UPDATE_PHASES = new Set<string>([
  'idle',
  'checking',
  'downloading',
  'verifying',
  'extracting',
  'installing',
  'migrating',
  'switching',
  'restarting',
  'health_gate',
  'rolling_back',
  'done',
  'failed',
]);

/** The shape `self-update.sh` writes. Everything is re-validated on the way in. */
interface ExternalStatus {
  readonly phase: UpdatePhase;
  readonly progressPct: number | null;
  readonly target: string;
  readonly previous: string;
  readonly error?: string;
}

interface HistoryRow {
  id: number;
  ts: number;
  from_version: string | null;
  to_version: string | null;
  channel: string | null;
  result: string;
  log: string | null;
}

export class UpdateManager {
  private currentVersion: string;
  private phase: UpdatePhase = 'idle';
  private progressPct: number | null = null;
  private available: ReleaseInfo | null = null;
  private lastCheckAt: number | null = null;
  private lastError: string | null = null;
  private rollbackVersion: string | null = null;
  private readonly publishEvent: (event: BridgeEvent) => void;
  private readonly config: ConfigManager;
  private readonly db: Db | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly invoke: HelperInvoker;
  private readonly statusFile: string;

  constructor(options: UpdateManagerOptions) {
    this.currentVersion = options.currentVersion;
    this.publishEvent = options.publishEvent;
    this.config = options.config;
    this.db = options.db;
    this.fetchImpl = options.fetchImpl;
    this.invoke = options.invoke ?? invokePrivileged;
    this.statusFile = options.statusFile ?? DEFAULT_STATUS_FILE;
  }

  getStatus(): UpdateStatus {
    return {
      currentVersion: this.currentVersion,
      available: this.available,
      phase: this.phase,
      progressPct: this.progressPct,
      lastCheckAt: this.lastCheckAt,
      lastError: this.lastError,
      rollbackVersion: this.rollbackVersion,
    };
  }

  /**
   * Asks GitHub for the newest release on the configured channel.
   *
   * Always records `lastCheckAt`, including when the check fails. The timestamp answers
   * "when did we last look", and the operator reads it next to `lastError`; suppressing
   * it on failure would leave the screen claiming no check had ever run.
   */
  async check(): Promise<UpdateStatus> {
    if (this.phase !== 'idle' && this.phase !== 'done' && this.phase !== 'failed') {
      throw new Error(`Cannot check for updates while ${this.phase}`);
    }

    const updates = this.config.get('updates');
    this.phase = 'checking';
    this.lastError = null;
    this.publishStatus();

    try {
      const release = await fetchLatestRelease({
        repo: updates.githubRepo,
        channel: updates.channel,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });

      // A release that is not newer is not "available" — offering the running version
      // as an update is the bug that makes an operator install it and see nothing
      // change.
      this.available =
        release !== null && isNewer(release.version, this.currentVersion) ? release : null;
      this.lastCheckAt = Math.floor(Date.now() / 1000);
      this.phase = 'idle';
      this.publishStatus();
      return this.getStatus();
    } catch (error) {
      this.lastCheckAt = Math.floor(Date.now() / 1000);
      this.lastError = error instanceof Error ? error.message : String(error);
      this.available = null;
      this.phase = 'idle';
      this.publishStatus();
      throw error;
    }
  }

  /**
   * Hand the update to the privileged helper and return.
   *
   * Not awaited to completion, because there is no completion to await here: the
   * updater rebuilds the tree and restarts this very process, so the promise would be
   * cut off partway through by definition. What the operator sees afterwards comes
   * from {@link readStatusFile} — written by the updater, read back by whichever
   * process is running at the time, including the one that replaces this one.
   */
  apply(version?: string): Promise<void> {
    // Rejections, not throws. Both guards are reachable from a route that attaches a
    // `.catch`, and a synchronous throw from a function typed `Promise<void>` skips it.
    if (this.phase !== 'idle' && this.phase !== 'done' && this.phase !== 'failed') {
      return Promise.reject(new Error(`Cannot apply update while ${this.phase}`));
    }

    const target = version ?? this.available?.version;
    if (target === undefined) {
      return Promise.reject(new Error('No update available to apply. Check for updates first.'));
    }

    this.phase = 'downloading';
    this.progressPct = 0;
    this.lastError = null;
    this.publishStatus();

    try {
      this.invoke({
        verb: 'self-update',
        targetRef: tagFor(target),
        // Arms the rollback; it does not name its destination. The updater resolves
        // that from the commit actually checked out, because deriving it from the
        // running version assumes the checkout is exactly the matching tag — false on
        // every install-from-main, where rolling back to the tag would undo everything
        // merged since it. See scripts/self-update.sh.
        previousRef: tagFor(this.currentVersion),
        healthTimeoutSeconds: this.config.get('updates').healthTimeoutS,
      });
      return Promise.resolve();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.phase = 'failed';
      this.publishStatus();
      this.record({
        fromVersion: this.currentVersion,
        toVersion: target,
        result: 'failed',
        log: this.lastError,
      });
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Go back to the release this one replaced.
   *
   * The same mechanism as {@link apply} with the refs swapped — there is no separate
   * "undo" path, because a rollback is just an update to an older tag, and a second
   * code path is a second thing that can be wrong when it is needed most.
   */
  rollback(): Promise<void> {
    const target = this.rollbackVersion;
    if (target === null) {
      return Promise.reject(new Error('No previous version available for rollback'));
    }

    this.phase = 'rolling_back';
    this.progressPct = 0;
    this.lastError = null;
    this.publishStatus();

    try {
      this.invoke({
        verb: 'self-update',
        targetRef: tagFor(target),
        // No further fallback: going back from the version we are rolling back to would
        // be going forward again, into the release that just failed.
        previousRef: '',
        healthTimeoutSeconds: this.config.get('updates').healthTimeoutS,
      });
      return Promise.resolve();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.phase = 'failed';
      this.publishStatus();
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Adopt whatever the updater last wrote, if it concerns an update we do not know about.
   *
   * Called once at startup. After a successful update this process *is* the new
   * release, so a `done` record simply confirms what the version already says; after a
   * failed one, this is the only place the reason survives — the process that asked for
   * the update was replaced before it could record anything.
   */
  adoptExternalStatus(): void {
    const external = this.readStatusFile();
    if (external === null) {
      return;
    }

    if (external.error !== undefined && external.error !== '') {
      this.lastError = external.error;
    }

    if (external.phase === 'done' || external.phase === 'failed') {
      this.phase = external.phase;
      this.progressPct = external.phase === 'done' ? 100 : null;
      if (external.previous !== '' && external.phase === 'done') {
        this.rollbackVersion = normaliseVersion(external.previous);
      }
      this.record({
        fromVersion: external.previous === '' ? null : normaliseVersion(external.previous),
        toVersion: normaliseVersion(external.target),
        result: external.phase === 'done' ? 'ok' : 'failed',
        log: external.error ?? null,
      });
      // Consumed: leaving it would re-record the same attempt on every restart.
      this.clearStatusFile();
      return;
    }

    // Still running — the service was restarted by the updater and the updater is now
    // waiting on the health gate that this very startup is about to satisfy.
    this.phase = external.phase;
    this.progressPct = external.progressPct;
  }

  /** Newest first, so page one is the attempt the operator just made. */
  getHistory(limit = 50, offset = 0): { items: UpdateHistoryEntry[]; total: number } {
    if (this.db === undefined) {
      return { items: [], total: 0 };
    }
    const rows = this.db.all<HistoryRow>(
      'SELECT id, ts, from_version, to_version, channel, result, log FROM update_history ' +
        'ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?',
      [limit, offset],
    );
    const total =
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM update_history')?.n ?? rows.length;

    return {
      items: rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        fromVersion: row.from_version,
        toVersion: row.to_version,
        channel: row.channel === 'stable' || row.channel === 'beta' ? row.channel : null,
        result:
          row.result === 'ok' || row.result === 'failed' || row.result === 'rolled_back'
            ? row.result
            : 'failed',
        log: row.log,
      })),
      total,
    };
  }

  private record(entry: {
    fromVersion: string | null;
    toVersion: string | null;
    result: 'ok' | 'failed' | 'rolled_back';
    log: string | null;
  }): void {
    if (this.db === undefined) {
      return;
    }
    // A failure to write the audit trail must not turn a successful update into a
    // failed one; the operator can see the outcome on screen either way.
    try {
      this.db.run(
        'INSERT INTO update_history (ts, from_version, to_version, channel, result, log) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        [
          Math.floor(Date.now() / 1000),
          entry.fromVersion,
          entry.toVersion,
          this.config.get('updates').channel,
          entry.result,
          entry.log,
        ],
      );
    } catch {
      // Intentionally swallowed — see above.
    }
  }

  /**
   * The updater's status file, or null when there is nothing usable there.
   *
   * Every failure mode — absent, unreadable, truncated mid-write, holding a phase this
   * build does not know — collapses to null. The file is written by a script this
   * process cannot supervise, and an update that reports nothing is a far better
   * outcome than a status page that throws.
   */
  private readStatusFile(): ExternalStatus | null {
    let raw: string;
    try {
      raw = readFileSync(this.statusFile, 'utf8');
    } catch {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      const phase = record.phase;
      if (typeof phase !== 'string' || !UPDATE_PHASES.has(phase)) {
        return null;
      }
      return {
        phase: phase as UpdatePhase,
        progressPct: typeof record.progressPct === 'number' ? record.progressPct : null,
        target: typeof record.target === 'string' ? record.target : '',
        previous: typeof record.previous === 'string' ? record.previous : '',
        ...(typeof record.error === 'string' ? { error: record.error } : {}),
      };
    } catch {
      return null;
    }
  }

  private clearStatusFile(): void {
    try {
      rmSync(this.statusFile, { force: true });
    } catch {
      // The service account may not own it. Not worth failing a startup over: the
      // worst case is a duplicate history row after a reinstall.
    }
  }

  private publishStatus(): void {
    this.publishEvent({
      ts: Date.now(),
      type: 'update',
      status: this.getStatus(),
    });
  }
}
