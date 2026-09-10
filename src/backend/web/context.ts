import { type ConfigManager } from '../config/config-manager';
import { type Db, type DbLogger } from '../config/db';
import { type ConflictResolver } from '../locking/conflict-resolver';
import { type LockManager } from '../locking/lock-manager';
import { type BridgeMetrics } from '../monitoring/registry';
import { type Scheduler } from '../scheduling/scheduler';
import { type AuditLog } from '../security/audit-log';
import { type SambaConfigManager } from '../smb/samba-config-manager';
import { type SyncSupervisor } from '../sync/supervisor';
import { type OsUpdateManager } from '../system/os-update-manager';
import { type UpdateManager } from '../system/update-manager';
import { type VersionStore } from '../versioning/version-store';
import { type AuthManager } from './auth';
import { type EventBus } from './event-bus';
import { type HttpsServerManager } from './https-setup';

/**
 * Everything a route handler needs, gathered in one place (T26).
 *
 * Assembled once by the composition root (`index.ts`, T8's lifecycle) and threaded
 * through {@link createApp} — nothing in `routes/api.ts` reaches for a singleton or a
 * module-level `db`, which is what keeps every handler testable against an in-memory
 * database and a fresh set of managers instead of the real process's state.
 */
export interface AppContext {
  readonly db: Db;
  readonly config: ConfigManager;
  readonly auth: AuthManager;
  readonly locks: LockManager;
  readonly conflicts: ConflictResolver;
  readonly events: EventBus;
  readonly logger?: DbLogger;
  /** Version history and its content-addressed blob store (T34). */
  readonly versions: VersionStore;
  /** Cron engine backing `/schedules` (T36). */
  readonly schedules: Scheduler;
  /** Counters and gauges behind `/metrics` in all three shapes (T41). */
  readonly metrics: BridgeMetrics;
  /**
   * Append-only record of administrative actions (T43).
   *
   * Optional so a test can stand up a context without one, but the composition root
   * always provides it — an unaudited production instance is not a supported state.
   */
  readonly audit?: AuditLog;
  /**
   * Absolute local cache directory for a share.
   *
   * A function rather than a map because a share can be created or deleted while the
   * process runs, and a snapshot taken at startup would go stale. Throws for an unknown
   * share, which is what keeps a restore from ever writing outside a real share root.
   */
  readonly shareCacheRoot: (shareId: number) => string;
  /** Directory holding `cert.pem`/`key.pem`/`chain.pem` — see `https-setup.ts`. */
  readonly certDir: string;
  /** Present once the HTTPS server has started; lets certificate changes hot-reload. */
  httpsManager?: HttpsServerManager;
  /**
   * Present in the running service; absent in tests that only exercise routes. A route
   * asks it to reconcile after changing a share — never to "start" one, because what
   * starts a share is the share being enabled.
   */
  readonly sync?: SyncSupervisor;
  /**
   * Owner of `smb.conf`. A route asks it to reconcile after changing a share, the same
   * way it asks the sync supervisor to — a share that exists but is not exported is a
   * share no machine can reach.
   */
  readonly samba?: SambaConfigManager;
  /**
   * Owner of the update state the `/update/*` routes report (T43/T44).
   *
   * Optional for the same reason as {@link sync}: a route test can do without one. When
   * absent the routes answer with a version and an idle phase, which is true of a
   * process that has no updater rather than a fiction about one that does.
   */
  readonly updates?: UpdateManager;
  /** Raspberry Pi OS package updates, on their own schedule (T43). */
  readonly osUpdates?: OsUpdateManager;
  readonly version: string;
  readonly startedAt: number;
  readonly now: () => number;
}
