import { type ConfigManager } from '../config/config-manager';
import { type JobHandler, type JobOutcome, type JobRegistry } from '../scheduling/jobs';

import { type OsUpdateManager } from './os-update-manager';
import { type UpdateManager } from './update-manager';

/**
 * What the `update` and `os-update` schedules actually do.
 *
 * Neither kind had a handler, so the scheduler recorded every firing as `skipped` and
 * an operator watching the schedule history saw a job that never ran — the same
 * declared-but-unimplemented pattern as the routes that answered from literals.
 *
 * Here rather than inline in the composition root because these make decisions —
 * whether a release is worth installing, whether a run is already in flight — and a
 * decision belongs somewhere it can be tested without standing up a server.
 */

export interface UpdateJobsOptions {
  readonly updates: UpdateManager;
  readonly osUpdates: OsUpdateManager;
  readonly config: ConfigManager;
}

/**
 * Check, and install only if the operator asked for that.
 *
 * `enabled` governs installing, not checking. An operator who turns automatic updates
 * off still wants to be told one exists — that is what the badge on the Updates page is
 * for — and a schedule that stopped checking would leave them with no way to find out
 * short of pressing the button themselves.
 */
export function checkAndMaybeApply(options: UpdateJobsOptions): JobHandler {
  return async (): Promise<JobOutcome> => {
    const status = await options.updates.check();

    if (status.available === null) {
      // Skipped rather than ok: "no update available" and "installed one" are different
      // outcomes, and an operator reading the history should not have to open both to
      // tell them apart.
      return { skipped: true, detail: `no update available for ${status.currentVersion}` };
    }

    if (!options.config.get('updates').enabled) {
      return {
        detail: `found ${status.available.version}, not installing (automatic updates are off)`,
      };
    }

    await options.updates.apply(status.available.version);
    // Not "installed": apply hands the work to a unit that outlives this process, and
    // claiming success here would be claiming an outcome nothing has observed yet.
    return { detail: `installing ${status.available.version}` };
  };
}

/** Start an apt run, unless one is already going. */
export function runOsUpdate(options: UpdateJobsOptions): JobHandler {
  return (): JobOutcome => {
    if (options.osUpdates.isRunning()) {
      // A schedule that fires while the previous run is still going is a real
      // possibility on a Pi, where an apt run can take longer than the gap between two
      // firings of an hourly schedule someone set by mistake.
      return { skipped: true, detail: 'a system update is already running' };
    }

    options.osUpdates.run();
    return { detail: 'system update started' };
  };
}

/** Registers both, so the composition root names them once. */
export function registerUpdateJobs(jobs: JobRegistry, options: UpdateJobsOptions): void {
  jobs.register('update', checkAndMaybeApply(options));
  jobs.register('os-update', runOsUpdate(options));
}
