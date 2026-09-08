import { type DbLogger } from '../config/db';
import { type AuditLog } from '../security/audit-log';

/**
 * Automatic failover to read-only (T44).
 *
 * The bridge sits between machines that must keep working and a server that might not
 * be there. When the server goes away, the wrong behaviour is to keep accepting writes
 * on the TNC side and queue them indefinitely: the operator believes their program is
 * saved, and it exists only on a Pi's SD card. Dropping the TNC share to read-only makes
 * the failure *visible at the machine* — the save fails, the operator knows, and nothing
 * is silently lost.
 *
 * ## Why the triggers are asymmetric
 *
 * Entering read-only is deliberately slow and leaving it is deliberately slower.
 *
 * A five-minute grace before failing over means an ordinary switch reboot, a DHCP
 * renewal or a brief AD hiccup never disturbs a running job. But recovering immediately
 * on the first successful probe would produce flapping: a server that is up for ten
 * seconds every minute would toggle the share's read-only flag repeatedly, and every
 * toggle is an `smbd` reload. So recovery requires the link to be *consistently* healthy
 * for a stabilisation period, and the hysteresis is what makes the state stable rather
 * than merely correct on average.
 *
 * ## The three triggers
 *
 * - **Server unreachable** past the grace period.
 * - **Cache nearly full.** Past 95 % there is not enough room to complete a transfer, and
 *   a partially written file is worse than a refused write.
 * - **A critical error in the sync loop.** If the engine cannot reason about state, it
 *   must not act on it.
 *
 * Each is latched independently, so recovering from one does not clear the others — a
 * disk that emptied while the server was still down must not bring writes back.
 */

export const FAILOVER_REASONS = [
  'server_unreachable',
  'disk_full',
  'sync_error',
  'manual',
] as const;
export type FailoverReason = (typeof FAILOVER_REASONS)[number];

export type FailoverState = 'healthy' | 'degraded' | 'read_only';

export interface FailoverOptions {
  /** Seconds the server may be unreachable before failing over. */
  readonly serverGraceS?: number;
  /** Cache usage percentage at which writes stop. */
  readonly diskFullPct?: number;
  /** Seconds the link must stay healthy before writes resume. */
  readonly recoveryStabilityS?: number;
  readonly logger?: DbLogger;
  readonly audit?: AuditLog;
  readonly now?: () => number;
  /** Called whenever the effective read-only state changes. */
  readonly onChange?: (state: FailoverState, reasons: readonly FailoverReason[]) => void;
}

export interface HealthInput {
  readonly serverReachable: boolean;
  readonly diskUsedPct: number;
  readonly syncHealthy: boolean;
}

export interface FailoverStatus {
  readonly state: FailoverState;
  readonly readOnly: boolean;
  readonly reasons: readonly FailoverReason[];
  /** When the server was first seen unreachable, or null. */
  readonly serverDownSince: number | null;
  /** When the link became healthy again, for the stabilisation countdown. */
  readonly healthySince: number | null;
  readonly since: number;
}

const DEFAULTS = {
  serverGraceS: 300,
  diskFullPct: 95,
  recoveryStabilityS: 60,
} as const;

export class FailoverController {
  private readonly serverGraceS: number;
  private readonly diskFullPct: number;
  private readonly recoveryStabilityS: number;
  private readonly logger: DbLogger | undefined;
  private readonly audit: AuditLog | undefined;
  private readonly now: () => number;
  private readonly onChange: FailoverOptions['onChange'];

  private reasons = new Set<FailoverReason>();
  private serverDownSince: number | null = null;
  private healthySince: number | null = null;
  private changedAt: number;
  private manualHold = false;

  constructor(options: FailoverOptions = {}) {
    this.serverGraceS = options.serverGraceS ?? DEFAULTS.serverGraceS;
    this.diskFullPct = options.diskFullPct ?? DEFAULTS.diskFullPct;
    this.recoveryStabilityS = options.recoveryStabilityS ?? DEFAULTS.recoveryStabilityS;
    this.logger = options.logger;
    this.audit = options.audit;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.onChange = options.onChange;
    this.changedAt = this.now();
  }

  /**
   * Feeds one health observation and returns the resulting state.
   *
   * Pure with respect to its inputs plus the controller's own history — no probing
   * happens here. The caller owns *when* to observe; this owns what the observations
   * mean.
   */
  observe(input: HealthInput): FailoverStatus {
    const now = this.now();
    const before = this.snapshotReasons();

    // --- Server reachability, with its grace period -------------------------
    if (input.serverReachable) {
      if (this.serverDownSince !== null) {
        this.logger?.info({ downForS: now - this.serverDownSince }, 'server link restored');
      }
      this.serverDownSince = null;
      if (this.healthySince === null) {
        this.healthySince = now;
      }
      // Only clear once the link has been *consistently* healthy, or a flapping server
      // toggles the share's read-only flag — and every toggle is an smbd reload.
      if (now - this.healthySince >= this.recoveryStabilityS) {
        this.reasons.delete('server_unreachable');
      }
    } else {
      this.healthySince = null;
      this.serverDownSince ??= now;
      if (now - this.serverDownSince >= this.serverGraceS) {
        this.reasons.add('server_unreachable');
      }
    }

    // --- Disk ---------------------------------------------------------------
    if (input.diskUsedPct >= this.diskFullPct) {
      this.reasons.add('disk_full');
    } else if (input.diskUsedPct < this.diskFullPct - 5) {
      // Five points of hysteresis: clearing at exactly the threshold would let a cache
      // hovering on the line toggle on every sample.
      this.reasons.delete('disk_full');
    }

    // --- Sync engine --------------------------------------------------------
    if (input.syncHealthy) {
      this.reasons.delete('sync_error');
    } else {
      this.reasons.add('sync_error');
    }

    if (this.manualHold) {
      this.reasons.add('manual');
    } else {
      this.reasons.delete('manual');
    }

    return this.finish(before, now);
  }

  /** Forces read-only regardless of health. Cleared by {@link resume}. */
  hold(actor = 'admin'): FailoverStatus {
    const before = this.snapshotReasons();
    this.manualHold = true;
    this.reasons.add('manual');
    this.audit?.record({ actor, action: 'failover.hold', detail: 'forced read-only' });
    return this.finish(before, this.now());
  }

  /**
   * Clears a manual hold.
   *
   * Does not clear the automatic reasons: an operator saying "resume" while the server
   * is still unreachable is asking for something that would lose their colleagues' work,
   * so the hold lifts and the automatic state continues to apply.
   */
  resume(actor = 'admin'): FailoverStatus {
    const before = this.snapshotReasons();
    this.manualHold = false;
    this.reasons.delete('manual');
    this.audit?.record({ actor, action: 'failover.resume' });
    return this.finish(before, this.now());
  }

  /**
   * Clears every latched reason and starts fresh.
   *
   * The "recovery mode" trigger: used after an operator has fixed the underlying problem
   * and wants the bridge to re-evaluate from a clean slate rather than wait out the
   * stabilisation window.
   */
  reset(actor = 'admin'): FailoverStatus {
    const before = this.snapshotReasons();
    this.reasons.clear();
    this.manualHold = false;
    this.serverDownSince = null;
    this.healthySince = this.now();
    this.audit?.record({ actor, action: 'failover.reset', detail: 'recovery mode' });
    return this.finish(before, this.now());
  }

  get status(): FailoverStatus {
    return this.build(this.now());
  }

  get isReadOnly(): boolean {
    return this.reasons.size > 0;
  }

  private snapshotReasons(): string {
    return [...this.reasons].sort().join(',');
  }

  private finish(before: string, now: number): FailoverStatus {
    const after = this.snapshotReasons();
    if (before !== after) {
      this.changedAt = now;
      const status = this.build(now);
      this.logger?.warn({ state: status.state, reasons: status.reasons }, 'failover state changed');
      this.audit?.record({
        actor: 'system',
        action: 'failover.state',
        detail: `${status.state}${status.reasons.length > 0 ? `: ${status.reasons.join(', ')}` : ''}`,
      });
      this.onChange?.(status.state, status.reasons);
      return status;
    }
    return this.build(now);
  }

  private build(now: number): FailoverStatus {
    const reasons = [...this.reasons].sort();
    // `degraded` means "a problem is being tolerated inside its grace period" — the
    // server is down but writes still work. Surfacing it separately is what lets the
    // dashboard warn before anything actually breaks.
    const state: FailoverState =
      reasons.length > 0 ? 'read_only' : this.serverDownSince !== null ? 'degraded' : 'healthy';

    return {
      state,
      readOnly: reasons.length > 0,
      reasons,
      serverDownSince: this.serverDownSince,
      healthySince: this.healthySince,
      since: this.changedAt,
    };
  }
}
