import { type ScheduleKind } from '../../shared';
import { type ConfigManager } from '../config/config-manager';
import { type DbLogger } from '../config/db';
import { type Scheduler } from '../scheduling/scheduler';

/**
 * Keeps the two update schedules in the schedules table in step with the config.
 *
 * The Updates page and the Schedules page were describing the same thing twice and
 * agreeing by accident. `updates.scheduleCron` lived in the config section while the
 * schedules table was where the cron engine actually looked, and nothing connected
 * them: the schedule editor on the Updates page wrote nowhere at all, and a row created
 * by hand on the Schedules page ran on a cadence the Updates page never showed.
 *
 * The fix is one owner, not a merge. The config section owns *when*; this projects it
 * onto a row so the cron engine has something to fire and the operator can see the next
 * run alongside every other scheduled job. The rows are marked as managed, and the
 * schedules API refuses to edit them — an operator who changes one there would be
 * changing a value that the next reconcile overwrites, which is worse than being told
 * where the setting lives.
 */

/** Row names are the identity: stable, and never shown untranslated to an operator. */
export const MANAGED_SCHEDULE_NAMES: Readonly<Record<'update' | 'osUpdate', string>> = {
  update: 'Automatic bridge updates',
  osUpdate: 'Automatic system updates',
};

/** True for a schedule row this class owns. */
export function isManagedSchedule(name: string): boolean {
  return Object.values(MANAGED_SCHEDULE_NAMES).includes(name);
}

export interface ManagedSchedulesOptions {
  readonly config: ConfigManager;
  readonly scheduler: Scheduler;
  readonly logger?: DbLogger;
}

export class ManagedSchedules {
  private readonly config: ConfigManager;
  private readonly scheduler: Scheduler;
  private readonly logger: DbLogger | undefined;

  constructor(options: ManagedSchedulesOptions) {
    this.config = options.config;
    this.scheduler = options.scheduler;
    this.logger = options.logger;

    // Reconcile on every change to either section, not only at startup. Saving a new
    // cadence has to take effect now; telling an operator to restart the appliance for
    // a schedule change is the kind of thing that makes them stop using the schedule.
    this.config.onSectionChange('updates', () => {
      this.reconcile();
    });
    this.config.onSectionChange('osUpdates', () => {
      this.reconcile();
    });
  }

  /**
   * Make the schedules table match the config.
   *
   * Idempotent, and safe to call at any time. Never throws: a schedule that could not
   * be written is worth a log line, not a refused startup — the appliance's job is
   * bridging files, and it should keep doing that with a stale cron entry.
   */
  reconcile(): void {
    const updates = this.config.get('updates');
    const osUpdates = this.config.get('osUpdates');

    this.ensure('update', MANAGED_SCHEDULE_NAMES.update, updates.scheduleCron, updates.enabled);
    this.ensure(
      'os-update',
      MANAGED_SCHEDULE_NAMES.osUpdate,
      osUpdates.scheduleCron,
      osUpdates.enabled,
    );
  }

  private ensure(kind: ScheduleKind, name: string, cron: string, enabled: boolean): void {
    try {
      const existing = this.scheduler
        .list({ kind, limit: 100 })
        .items.find((schedule) => schedule.name === name);

      if (existing === undefined) {
        this.scheduler.create({ name, kind, cron, target: null, enabled }, 'system');
        return;
      }

      // Only write when something actually differs. An unconditional update would
      // rewrite `next_run_at` on every config save and every restart, which would make
      // a daily job drift later each time the operator touched an unrelated setting.
      if (existing.cron === cron && existing.enabled === enabled) {
        return;
      }
      this.scheduler.update(existing.id, { cron, enabled }, 'system');
    } catch (error) {
      this.logger?.warn(
        { kind, name, error: error instanceof Error ? error.message : String(error) },
        'could not reconcile a managed schedule',
      );
    }
  }
}
