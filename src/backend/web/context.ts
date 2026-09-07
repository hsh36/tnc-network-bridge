import { type ConfigManager } from '../config/config-manager';
import { type Db, type DbLogger } from '../config/db';
import { type ConflictResolver } from '../locking/conflict-resolver';
import { type LockManager } from '../locking/lock-manager';
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
  /** Directory holding `cert.pem`/`key.pem`/`chain.pem` — see `https-setup.ts`. */
  readonly certDir: string;
  /** Present once the HTTPS server has started; lets certificate changes hot-reload. */
  httpsManager?: HttpsServerManager;
  readonly version: string;
  readonly startedAt: number;
  readonly now: () => number;
}
