import { type BridgeEvent } from '../../shared';
import {
  type UpdateHistoryEntry,
  type UpdateStatus,
  type UpdatePhase,
} from '../../shared/schemas/operations';
import { type Db } from '../config/db';
import { type ConfigManager } from '../config/config-manager';
import { fetchLatestRelease, isNewer, type ReleaseInfo } from './github-releases';

/**
 * The single owner of "what version are we on, and is there a newer one".
 *
 * One instance per process, held by the composition root and reached through
 * {@link AppContext} — the routes used to answer `/update/status` from a literal, which
 * is why the UI could never show the result of a check it had just run.
 *
 * Applying an update is still {@link apply}'s placeholder walk through the phases. The
 * real installer is `install.sh`, run over the top of itself, and handing it to a
 * process it is about to replace needs the restart-and-health-gate work that is not
 * done yet. `check` is real, because a wrong answer there is a lie on the screen; a
 * placeholder `apply` is at least visibly a placeholder.
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
  /**
   * Pause between the simulated progress steps of {@link UpdateManager.apply}.
   *
   * Only meaningful while apply is a placeholder — it exists so the tests that assert
   * what apply leaves behind do not each spend five seconds watching a fake progress
   * bar. Delete it along with the simulation.
   */
  readonly stepDelayMs?: number;
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
  private readonly stepDelayMs: number;

  constructor(options: UpdateManagerOptions) {
    this.currentVersion = options.currentVersion;
    this.publishEvent = options.publishEvent;
    this.config = options.config;
    this.db = options.db;
    this.fetchImpl = options.fetchImpl;
    this.stepDelayMs = options.stepDelayMs ?? 100;
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

  async apply(version?: string): Promise<void> {
    if (this.phase !== 'idle' && this.phase !== 'done' && this.phase !== 'failed') {
      throw new Error(`Cannot apply update while ${this.phase}`);
    }

    const target = version ?? this.available?.version;
    if (target === undefined) {
      throw new Error('No update available to apply. Check for updates first.');
    }

    const from = this.currentVersion;
    this.phase = 'downloading';
    this.progressPct = 0;
    this.lastError = null;
    this.publishStatus();

    try {
      const phases: UpdatePhase[] = [
        'downloading',
        'verifying',
        'extracting',
        'installing',
        'migrating',
        'switching',
        'restarting',
        'health_gate',
      ];

      for (const phase of phases) {
        this.phase = phase;
        for (let pct = 0; pct <= 100; pct += 20) {
          this.progressPct = pct;
          this.publishStatus();
          await this.pause();
        }
      }

      this.phase = 'done';
      this.progressPct = 100;
      this.rollbackVersion = from;
      this.currentVersion = target;
      this.available = null;
      this.publishStatus();
      this.record({ fromVersion: from, toVersion: target, result: 'ok', log: null });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.phase = 'failed';
      this.publishStatus();
      this.record({
        fromVersion: from,
        toVersion: target,
        result: 'failed',
        log: this.lastError,
      });
      throw error;
    }
  }

  async rollback(): Promise<void> {
    const target = this.rollbackVersion;
    if (target === null) {
      throw new Error('No previous version available for rollback');
    }

    const from = this.currentVersion;
    this.phase = 'rolling_back';
    this.progressPct = 0;
    this.publishStatus();

    try {
      for (let pct = 0; pct <= 100; pct += 20) {
        this.progressPct = pct;
        this.publishStatus();
        await this.pause();
      }

      this.phase = 'done';
      this.progressPct = 100;
      this.currentVersion = target;
      this.rollbackVersion = from;
      this.publishStatus();
      this.record({ fromVersion: from, toVersion: target, result: 'rolled_back', log: null });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.phase = 'failed';
      this.publishStatus();
      throw error;
    }
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

  private async pause(): Promise<void> {
    if (this.stepDelayMs <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, this.stepDelayMs));
  }

  private publishStatus(): void {
    this.publishEvent({
      ts: Date.now(),
      type: 'update',
      status: this.getStatus(),
    });
  }
}
