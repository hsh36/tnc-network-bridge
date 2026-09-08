import { useState } from 'react';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { UpdateProgress } from '../components/UpdateProgress';
import { UpdateHistory } from '../components/UpdateHistory';
import { ScheduleEditor } from '../components/ScheduleEditor';
import { useUpdateStatus } from '../hooks/useUpdateStatus';

/**
 * System Updates (T44).
 *
 * Displays current/available version, changelog, update progress with live SSE
 * updates, rollback capability, update history, and schedule editor for automatic
 * updates. Progress is designed to survive service restarts via SSE reconnect.
 */
export function SystemUpdates(): JSX.Element {
  const {
    status,
    history,
    loading,
    checking,
    checkError,
    check,
    apply,
    applyError,
    applying,
    rollback,
    rollbackError,
    rolling,
  } = useUpdateStatus();

  const [showScheduleEditor, setShowScheduleEditor] = useState(false);

  const isUpdating =
    status?.phase !== 'idle' && status?.phase !== 'done' && status?.phase !== 'failed'
      ? true
      : false;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">System Updates</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Check for updates, review changelogs, and manage automatic update scheduling.
        </p>
      </div>

      {/* Current version */}
      <Card>
        <CardHeader title="Current Version" />
        <CardBody>
          {loading && !status ? (
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="text-sm text-slate-500">Loading...</span>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                  {status?.currentVersion ?? '—'}
                </span>
                {status?.rollbackVersion && (
                  <Badge tone="warn">Rollback available ({status.rollbackVersion})</Badge>
                )}
              </div>
              {status?.rollbackVersion && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={rolling}
                  onClick={() => void rollback()}
                  disabled={isUpdating || applying || checking}
                >
                  Rollback
                </Button>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Available version */}
      {status?.available && (
        <Card>
          <CardHeader title="Available Update" />
          <CardBody>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="text-lg font-medium text-slate-900 dark:text-slate-100">
                  Version {status.available.version}
                </span>
                <Badge tone="accent">Available</Badge>
              </div>

              {status.available.notes && (
                <div className="rounded-md bg-slate-50 p-4 dark:bg-slate-800">
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Release Notes
                  </p>
                  <div className="mt-2 text-sm text-slate-600 dark:text-slate-400">
                    <pre className="whitespace-pre-wrap font-sans">{status.available.notes}</pre>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  size="sm"
                  loading={applying}
                  onClick={() => void apply(status.available!.version)}
                  disabled={isUpdating || checking || rolling}
                >
                  Apply Update
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={checking}
                  onClick={() => void check()}
                  disabled={isUpdating || applying || rolling}
                >
                  Check Again
                </Button>
              </div>

              {applyError && (
                <div className="rounded-md bg-red-50 p-3 dark:bg-red-950">
                  <p className="text-sm text-red-700 dark:text-red-200">{applyError}</p>
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Update progress */}
      {status && (
        <Card>
          <CardHeader title="Update Progress" />
          <CardBody>
            <UpdateProgress status={status} />
            {rollbackError && (
              <div className="mt-4 rounded-md bg-red-50 p-3 dark:bg-red-950">
                <p className="text-sm text-red-700 dark:text-red-200">{rollbackError}</p>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Check for updates */}
      {!status?.available && (
        <Card>
          <CardHeader title="Check for Updates" />
          <CardBody>
            <div className="flex flex-col gap-4">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {status?.lastCheckAt
                  ? `Last checked: ${new Date(status.lastCheckAt * 1000).toLocaleString()}`
                  : 'No checks performed yet'}
              </p>
              <Button
                size="sm"
                loading={checking}
                onClick={() => void check()}
                disabled={isUpdating || applying || rolling}
              >
                Check for Updates
              </Button>
              {checkError && (
                <div className="rounded-md bg-red-50 p-3 dark:bg-red-950">
                  <p className="text-sm text-red-700 dark:text-red-200">{checkError}</p>
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Update schedule */}
      <Card>
        <CardHeader title="Automatic Updates" />
        <CardBody>
          <div className="flex flex-col gap-4">
            {!showScheduleEditor ? (
              <Button size="sm" variant="secondary" onClick={() => setShowScheduleEditor(true)}>
                Configure Schedule
              </Button>
            ) : (
              <>
                <ScheduleEditor
                  onSave={(_cron) => {
                    // TODO: Save schedule via API
                    setShowScheduleEditor(false);
                  }}
                />
                <Button size="sm" variant="ghost" onClick={() => setShowScheduleEditor(false)}>
                  Cancel
                </Button>
              </>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Automatic updates can be scheduled to run at a specific time each week.
            </p>
          </div>
        </CardBody>
      </Card>

      {/* Update history */}
      <Card>
        <CardHeader title="Update History" />
        <CardBody>
          <UpdateHistory entries={history} />
        </CardBody>
      </Card>
    </div>
  );
}
