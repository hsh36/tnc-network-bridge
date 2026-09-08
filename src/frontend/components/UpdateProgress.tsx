import { type UpdateStatus } from '../../shared';
import { Badge } from './ui/Badge';
import { Spinner } from './ui/Spinner';

interface UpdateProgressProps {
  readonly status: UpdateStatus;
}

const PHASE_LABELS: Record<UpdateStatus['phase'], string> = {
  idle: 'Idle',
  checking: 'Checking for updates',
  downloading: 'Downloading',
  verifying: 'Verifying',
  extracting: 'Extracting',
  installing: 'Installing',
  migrating: 'Migrating database',
  switching: 'Switching version',
  restarting: 'Restarting service',
  health_gate: 'Health check',
  rolling_back: 'Rolling back',
  done: 'Complete',
  failed: 'Failed',
};

const PHASE_COLORS: Record<UpdateStatus['phase'], string> = {
  idle: 'text-slate-500',
  checking: 'text-blue-600',
  downloading: 'text-blue-600',
  verifying: 'text-blue-600',
  extracting: 'text-blue-600',
  installing: 'text-blue-600',
  migrating: 'text-blue-600',
  switching: 'text-blue-600',
  restarting: 'text-purple-600',
  health_gate: 'text-purple-600',
  rolling_back: 'text-orange-600',
  done: 'text-green-600',
  failed: 'text-red-600',
};

export function UpdateProgress({ status }: UpdateProgressProps): JSX.Element {
  const isActive = status.phase !== 'idle' && status.phase !== 'done' && status.phase !== 'failed';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {isActive && <Spinner />}
        <div className={`text-sm font-medium ${PHASE_COLORS[status.phase]}`}>
          {PHASE_LABELS[status.phase]}
        </div>
        {status.phase === 'done' && <Badge tone="ok">Success</Badge>}
        {status.phase === 'failed' && <Badge tone="error">Failed</Badge>}
      </div>

      {status.progressPct !== null && (
        <div className="w-full">
          <div className="mb-2 flex justify-between text-xs text-slate-500">
            <span>Progress</span>
            <span>{status.progressPct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              className="h-full bg-gradient-to-r from-blue-600 to-blue-500 transition-all duration-300"
              style={{ width: `${status.progressPct}%` }}
              role="progressbar"
              aria-valuenow={status.progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
        </div>
      )}

      {status.lastError && (
        <div className="rounded-md bg-red-50 p-3 dark:bg-red-950">
          <p className="text-sm text-red-700 dark:text-red-200">{status.lastError}</p>
        </div>
      )}
    </div>
  );
}
