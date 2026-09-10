import { mkdir } from 'node:fs/promises';

import { type ShareStatus } from '../../shared';
import { type ConfigManager } from '../config/config-manager';
import { type Db, type DbLogger } from '../config/db';
import { type LockManager } from '../locking/lock-manager';
import { CifsMountManager } from '../smb/cifs-mount';
import { type VersioningEngine } from '../versioning/versioning-engine';

import { FilesystemSyncPorts } from './filesystem-ports';
import { SyncOrchestrator } from './orchestrator';
import { ShareStore } from './share-store';

/**
 * Keeps what is running matched to what is configured.
 *
 * The obvious design — "start syncing when the operator saves a share" — is the one this
 * deliberately is not. Saving is an event, and an event cannot describe a state: after a
 * reboot nothing has been saved, so nothing would sync until someone opened the UI and
 * pressed a button. A crashed share would stay dead for the same reason.
 *
 * So `enabled` on the share row *is* the instruction, and this converges to it. Saving a
 * share, enabling one, disabling one, deleting one and starting the service are all the
 * same operation here: read the desired state, make the running state match. That also
 * means editing a field which changes nothing about whether a share should sync — a
 * bandwidth ceiling, say — does not tear a running sync down and start a fresh scan.
 */

export interface SyncSupervisorOptions {
  readonly db: Db;
  readonly config: ConfigManager;
  readonly locks?: LockManager;
  readonly versioning?: VersioningEngine;
  readonly logger?: DbLogger | undefined;
  /** Overridable so a test does not have to wait a real scan interval. */
  readonly now?: () => number;
}

interface RunningShare {
  readonly shareId: number;
  readonly name: string;
  /** What the share looked like when this was started, to detect a material change. */
  readonly fingerprint: string;
  readonly mount: CifsMountManager;
  readonly orchestrator: SyncOrchestrator;
  timer: NodeJS.Timeout | undefined;
  online: boolean;
  cycling: boolean;
}

export class SyncSupervisor {
  private readonly options: SyncSupervisorOptions;
  private readonly store: ShareStore;
  private readonly running = new Map<number, RunningShare>();
  private stopped = false;

  constructor(options: SyncSupervisorOptions) {
    this.options = options;
    this.store = new ShareStore({ db: options.db, config: options.config });
  }

  /**
   * Brings the running set in line with the shares table.
   *
   * Safe to call as often as anything changes; it is a diff, not a restart.
   */
  async reconcile(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const desired = this.store.list(500, 0).items.filter((share) => share.enabled);
    const wanted = new Map(desired.map((share) => [share.id, share]));

    for (const [shareId, active] of [...this.running]) {
      const share = wanted.get(shareId);
      // Gone, disabled, or materially different — in every case the running instance no
      // longer describes what was asked for.
      if (share === undefined || fingerprintOf(share) !== active.fingerprint) {
        await this.stopShare(shareId);
      }
    }

    for (const share of desired) {
      if (!this.running.has(share.id)) {
        await this.startShare(share.id);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const shareId of [...this.running.keys()]) {
      await this.stopShare(shareId);
    }
  }

  /**
   * Runs a cycle now instead of waiting for the interval.
   *
   * Returns whether the share was running at all — an action against a disabled share is
   * a 404-shaped answer, not a silent success.
   */
  runNow(shareId: number): boolean {
    if (!this.running.has(shareId)) {
      return false;
    }
    void this.cycle(shareId);
    return true;
  }

  /** Suspends or resumes transfers without unmounting or forgetting the index. */
  setPaused(shareId: number, paused: boolean): boolean {
    const active = this.running.get(shareId);
    if (active === undefined) {
      return false;
    }
    if (paused) {
      active.orchestrator.pause();
    } else {
      active.orchestrator.resume();
    }
    this.setStatus(shareId, paused ? 'paused' : 'idle');
    return true;
  }

  /** Which shares are syncing right now. Used by `/status` and by tests. */
  activeShareIds(): number[] {
    return [...this.running.keys()];
  }

  private async startShare(shareId: number): Promise<void> {
    const share = this.store.get(shareId);
    const logger = this.options.logger;

    // Both roots must exist before anything mounts or scans: cifs refuses a mount point
    // that is not there, and an absent cache would read as "the server deleted
    // everything" on the very first cycle.
    await mkdir(share.mountPoint, { recursive: true });
    await mkdir(share.cachePath, { recursive: true });

    const smb = this.options.config.get('smb');
    const password =
      this.store.password(shareId) ??
      this.options.config.getSecret('smb.server.credentials.password');

    const mount = new CifsMountManager({
      spec: {
        shareName: share.name,
        serverUnc: share.serverUnc,
        smbVersion: share.smbVersion,
        seal: share.smbSeal,
        domain: share.smbDomain ?? smb.server.credentials.domain,
        username: share.smbUser ?? smb.server.credentials.username,
        password,
        // The cache is served by Samba as the service account, so the mount has to be
        // owned by it or the machines get permission denied on files that synced fine.
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
      },
      ...(logger === undefined ? {} : { logger }),
    });

    const active: RunningShare = {
      shareId,
      name: share.name,
      fingerprint: fingerprintOf(share),
      mount,
      orchestrator: new SyncOrchestrator({
        shareId,
        ports: new FilesystemSyncPorts({
          shareId,
          cachePath: share.cachePath,
          mountPoint: share.mountPoint,
          excludePatterns: share.excludePatterns,
          maxFileSizeMb: share.maxFileSizeMb,
          ...(this.options.locks === undefined ? {} : { locks: this.options.locks }),
          ...(this.options.versioning === undefined ? {} : { versioning: this.options.versioning }),
          logger,
          serverOnline: () => active.online,
        }),
        diffConfig: { conflictMode: share.conflictMode },
      }),
      timer: undefined,
      online: false,
      cycling: false,
    };

    this.running.set(shareId, active);
    this.setStatus(shareId, 'idle');

    mount.on('state', (change: { online?: boolean }) => {
      active.online = change.online === true;
      this.setStatus(shareId, active.online ? 'idle' : 'offline');
    });

    try {
      await mount.mount();
      active.online = true;
    } catch (error) {
      // Not fatal. The mount manager retries on its own backoff, and the cache stays
      // readable by the machines meanwhile — which is the whole point of caching.
      logger?.warn(
        { shareId, share: share.name, error: messageOf(error) },
        'share mounted offline; serving the cache until the server returns',
      );
      this.setStatus(shareId, 'offline');
    }

    active.timer = setInterval(() => {
      void this.cycle(shareId);
    }, share.scanIntervalMs);
    active.timer.unref();

    // One cycle immediately, so saving a share does something visible rather than
    // nothing until the first interval elapses.
    void this.cycle(shareId);

    logger?.info({ shareId, share: share.name }, 'share syncing');
  }

  private async stopShare(shareId: number): Promise<void> {
    const active = this.running.get(shareId);
    if (active === undefined) {
      return;
    }
    this.running.delete(shareId);
    if (active.timer !== undefined) {
      clearInterval(active.timer);
    }
    try {
      await active.mount.unmount();
    } catch (error) {
      this.options.logger?.warn(
        { shareId, error: messageOf(error) },
        'could not unmount cleanly; leaving it to the kernel',
      );
    }
    this.options.logger?.info({ shareId, share: active.name }, 'share stopped');
  }

  /**
   * One reconciliation pass over one share.
   *
   * Guarded against overlap: a scan that takes longer than the interval must not have a
   * second one start on top of it, which on a slow link is the normal case rather than
   * the exception.
   */
  private async cycle(shareId: number): Promise<void> {
    const active = this.running.get(shareId);
    if (active === undefined || active.cycling) {
      return;
    }
    active.cycling = true;
    try {
      const result = await active.orchestrator.runCycle();
      this.recordScan(shareId, result.applied > 0 ? 'syncing' : 'idle');
      if (result.applied > 0) {
        this.options.logger?.info(
          { shareId, scanned: result.scanned, applied: result.applied },
          'sync cycle applied changes',
        );
      }
    } catch (error) {
      this.options.logger?.error(
        { shareId, error: messageOf(error) },
        'sync cycle failed; the next interval will retry',
      );
      this.setStatus(shareId, 'error', messageOf(error));
    } finally {
      active.cycling = false;
    }
  }

  private setStatus(shareId: number, status: ShareStatus, lastError?: string): void {
    this.options.db.run(
      'UPDATE shares SET status = @status, last_error = @lastError, updated_at = @now WHERE id = @id',
      { id: shareId, status, lastError: lastError ?? null, now: this.seconds() },
    );
  }

  private recordScan(shareId: number, status: ShareStatus): void {
    this.options.db.run(
      'UPDATE shares SET status = @status, last_scan_at = @now, last_error = NULL WHERE id = @id',
      { id: shareId, status, now: this.seconds() },
    );
  }

  private seconds(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }
}

/**
 * What must change for a running share to need restarting.
 *
 * Deliberately narrow. Anything the orchestrator reads per cycle — a bandwidth ceiling,
 * a conflict mode — does not belong here: restarting for it would throw away a scan in
 * progress to pick up a value the next cycle would have read anyway.
 */
function fingerprintOf(share: {
  serverUnc: string;
  smbVersion: string;
  smbSeal: boolean;
  smbDomain: string | null;
  smbUser: string | null;
  mountPoint: string;
  cachePath: string;
  scanIntervalMs: number;
}): string {
  return [
    share.serverUnc,
    share.smbVersion,
    String(share.smbSeal),
    share.smbDomain ?? '',
    share.smbUser ?? '',
    share.mountPoint,
    share.cachePath,
    String(share.scanIntervalMs),
  ].join('|');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
