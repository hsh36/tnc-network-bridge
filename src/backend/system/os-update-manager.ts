import { readFileSync, rmSync } from 'node:fs';

import { type OsUpdateStatus } from '../../shared';
import { type ConfigManager } from '../config/config-manager';
import { invokePrivileged, type HelperInvoker } from '../privileged/client';

/**
 * Raspberry Pi OS package updates.
 *
 * A sibling of {@link UpdateManager}, not a part of it. The two fail in unrelated ways
 * and an operator needs to know which one broke: a bridge that will not start after its
 * own update is a different problem from a Pi that will not boot after a kernel
 * upgrade. They also want different cadences, which is why each has its own schedule.
 *
 * As with the self-updater, the work runs in a transient systemd unit and reports
 * through a status file. Here that matters most in the reboot case — the one where
 * nothing in memory survives to say what happened.
 */

/** Where `scripts/os-update.sh` writes. Must match the script. */
export const DEFAULT_OS_STATUS_FILE = '/var/lib/tnc-bridge/os-update-status.json';

const OS_UPDATE_PHASES = new Set<string>([
  'idle',
  'refreshing',
  'upgrading',
  'cleaning',
  'rebooting',
  'done',
  'failed',
]);

export interface OsUpdateManagerOptions {
  readonly config: ConfigManager;
  /** Injected by tests; production calls the real helper over sudo. */
  readonly invoke?: HelperInvoker;
  readonly statusFile?: string;
}

export class OsUpdateManager {
  private phase: OsUpdateStatus['phase'] = 'idle';
  private progressPct: number | null = null;
  private lastRunAt: number | null = null;
  private lastResult: 'ok' | 'failed' | null = null;
  private detail: string | null = null;
  private rebootPending = false;

  private readonly config: ConfigManager;
  private readonly invoke: HelperInvoker;
  private readonly statusFile: string;

  constructor(options: OsUpdateManagerOptions) {
    this.config = options.config;
    this.invoke = options.invoke ?? invokePrivileged;
    this.statusFile = options.statusFile ?? DEFAULT_OS_STATUS_FILE;
  }

  /**
   * The current state, refreshed from the updater's status file every time.
   *
   * Read on each call rather than cached: the writer is a script this process does not
   * supervise, so there is no event to invalidate a cache on, and the file is small.
   */
  getStatus(): OsUpdateStatus {
    this.refresh();
    return {
      phase: this.phase,
      progressPct: this.progressPct,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      detail: this.detail,
      rebootPending: this.rebootPending,
    };
  }

  /** True while an apt run is in flight. */
  isRunning(): boolean {
    this.refresh();
    return this.phase !== 'idle' && this.phase !== 'done' && this.phase !== 'failed';
  }

  /**
   * Start an update.
   *
   * `reboot` defaults to the configured `autoReboot`, so a scheduled run and a manual
   * one behave the same unless the operator says otherwise. Either way the script only
   * reboots if an upgraded package actually asked for one.
   */
  run(options: { reboot?: boolean } = {}): void {
    if (this.isRunning()) {
      throw new Error(`A system update is already running (${this.phase})`);
    }

    const reboot = options.reboot ?? this.config.get('osUpdates').autoReboot;
    // Cleared first: leaving the last run's terminal status in place would make the
    // new run look finished the moment it started, until the script's first write.
    this.clearStatusFile();
    this.phase = 'refreshing';
    this.progressPct = 0;
    this.detail = null;

    this.invoke({ verb: 'os-update', reboot });
  }

  private refresh(): void {
    const external = this.readStatusFile();
    if (external === null) {
      return;
    }

    this.phase = external.phase;
    this.progressPct = external.progressPct;
    this.detail = external.detail ?? null;

    if (external.phase === 'done' || external.phase === 'failed') {
      this.lastRunAt = external.ts;
      this.lastResult = external.phase === 'done' ? 'ok' : 'failed';
      // The script says so explicitly when the upgrade left a reboot outstanding.
      this.rebootPending = (external.detail ?? '').includes('reboot is required');
    }
  }

  private readStatusFile(): {
    phase: OsUpdateStatus['phase'];
    progressPct: number | null;
    ts: number;
    detail?: string;
  } | null {
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
      if (typeof phase !== 'string' || !OS_UPDATE_PHASES.has(phase)) {
        return null;
      }
      return {
        phase: phase as OsUpdateStatus['phase'],
        progressPct: typeof record.progressPct === 'number' ? record.progressPct : null,
        ts: typeof record.ts === 'number' ? record.ts : Math.floor(Date.now() / 1000),
        ...(typeof record.detail === 'string' && record.detail !== ''
          ? { detail: record.detail }
          : {}),
      };
    } catch {
      // Truncated mid-write, or written by a version that reports differently. Either
      // way, no status is a better answer than a thrown error on a status poll.
      return null;
    }
  }

  private clearStatusFile(): void {
    try {
      rmSync(this.statusFile, { force: true });
    } catch {
      // Owned by root in production. Not worth refusing to start an update over.
    }
  }
}
