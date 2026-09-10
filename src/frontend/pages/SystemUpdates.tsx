import { useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
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
  const t = useTranslation('updates');
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
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('subtitle')}</p>
      </div>

      {/* Current version */}
      <Card>
        <CardHeader title={t('current_version_title')} />
        <CardBody>
          {loading && !status ? (
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="text-sm text-slate-500">{t('loading')}</span>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
                  {status?.currentVersion ?? '—'}
                </span>
                {status?.rollbackVersion && (
                  <Badge tone="warn">
                    {t('rollback_available', { version: status.rollbackVersion })}
                  </Badge>
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
                  {t('rollback_button')}
                </Button>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Available version */}
      {status?.available && (
        <Card>
          <CardHeader title={t('available_update')} />
          <CardBody>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="text-lg font-medium text-slate-900 dark:text-slate-100">
                  {t('version_label', { version: status.available.version })}
                </span>
                <Badge tone="accent">{t('available_badge')}</Badge>
              </div>

              {status.available.notes && (
                <div className="rounded-md bg-slate-50 p-4 dark:bg-slate-800">
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {t('release_notes')}
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
                  {t('apply_update')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={checking}
                  onClick={() => void check()}
                  disabled={isUpdating || applying || rolling}
                >
                  {t('check_again')}
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

      {/* Update progress — only while one is actually running. A permanent progress
          card showing "idle" is noise on a screen an operator visits to find out
          whether anything is happening. */}
      {isUpdating && status && (
        <Card>
          <CardHeader title={t('update_progress')} />
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
          <CardHeader title={t('check_for_updates_title')} />
          <CardBody>
            <div className="flex flex-col gap-4">
              {/*
                A finished check that found nothing has to say so. Showing only the
                timestamp left the operator unable to tell "you are current" from "the
                check silently did nothing" — the two look identical when the only thing
                that changes on screen is a date. `lastCheckAt` gates it: before the
                first check there is no basis for the claim.
              */}
              {status?.lastCheckAt && !status.available && !status.lastError ? (
                <div className="rounded-md border border-status-ok/40 bg-status-ok/5 px-4 py-3">
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('up_to_date_title')}
                  </p>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    {t('up_to_date_body', {
                      version: status.currentVersion,
                      date: new Date(status.lastCheckAt * 1000).toLocaleString(),
                    })}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {status?.lastCheckAt
                    ? t('last_checked', {
                        date: new Date(status.lastCheckAt * 1000).toLocaleString(),
                      })
                    : t('no_checks_yet')}
                </p>
              )}
              <Button
                size="sm"
                loading={checking}
                onClick={() => void check()}
                disabled={isUpdating || applying || rolling}
              >
                {t('check_updates_button')}
              </Button>
              {/*
                A check that reached GitHub and was refused answers 200 with the reason
                on the status — it is a result, not a server fault. `checkError` only
                covers the request itself failing, so both have to be rendered or a
                failed check reads as "up to date".
              */}
              {(checkError ?? status?.lastError) && (
                <div className="rounded-md bg-red-50 p-3 dark:bg-red-950">
                  <p className="text-sm font-medium text-red-700 dark:text-red-200">
                    {t('check_failed_title')}
                  </p>
                  <p className="mt-1 text-sm text-red-700 dark:text-red-200">
                    {checkError ?? status?.lastError}
                  </p>
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Update schedule */}
      <Card>
        <CardHeader title={t('automatic_updates')} />
        <CardBody>
          <div className="flex flex-col gap-4">
            {!showScheduleEditor ? (
              <Button size="sm" variant="secondary" onClick={() => setShowScheduleEditor(true)}>
                {t('configure_schedule')}
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
                  {t('cancel_button')}
                </Button>
              </>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('schedule_note')}</p>
          </div>
        </CardBody>
      </Card>

      {/* Update history */}
      <Card>
        <CardHeader title={t('update_history')} />
        <CardBody>
          <UpdateHistory entries={history} />
        </CardBody>
      </Card>
    </div>
  );
}
