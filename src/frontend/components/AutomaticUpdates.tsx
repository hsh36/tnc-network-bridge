import { useCallback, useEffect, useState } from 'react';

import { type OsUpdateStatus, type UpdatesConfig, type OsUpdatesConfig } from '../../shared';
import { useTranslation } from '../hooks/useTranslation';
import { ApiError, api } from '../lib/api-client';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Checkbox, Input } from './ui/Input';
import { Spinner } from './ui/Spinner';

/**
 * The two automatic-update schedules, each writing to its own config section.
 *
 * Replaces a card whose editor called `onSave` and then did nothing — the operator
 * configured a schedule, the dialog closed, and nothing was stored anywhere. The cron
 * expressions here are the ones the scheduler actually fires on: saving reconciles the
 * matching row in the schedules table, which is why the Schedules page refuses to edit
 * those rows.
 *
 * OS updates are a separate section and a separate schedule rather than a checkbox on
 * this one, because they want a different cadence: the appliance can update in the
 * evening, the operating system should wait for a weekend when a reboot costs nothing.
 */
export function AutomaticUpdates(): JSX.Element {
  const t = useTranslation('updates');

  const [bridge, setBridge] = useState<UpdatesConfig>();
  const [os, setOs] = useState<OsUpdatesConfig>();
  const [osStatus, setOsStatus] = useState<OsUpdateStatus>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'bridge' | 'os'>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<'bridge' | 'os'>();

  const refresh = useCallback(async () => {
    try {
      const [updates, osUpdates, status] = await Promise.all([
        api('config.get', { params: { section: 'updates' } }),
        api('config.get', { params: { section: 'osUpdates' } }),
        api('osUpdate.status', {}),
      ]);
      setBridge(updates as unknown as UpdatesConfig);
      setOs(osUpdates as unknown as OsUpdatesConfig);
      setOsStatus(status);
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('load_failed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // An apt run takes minutes and reports through a file, so the only way to follow it
  // is to ask. Polling stops as soon as it is not running: a screen nobody is watching
  // an update on should not be asking every three seconds forever.
  useEffect(() => {
    const active =
      osStatus !== undefined &&
      osStatus.phase !== 'idle' &&
      osStatus.phase !== 'done' &&
      osStatus.phase !== 'failed';
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => {
      api('osUpdate.status', {})
        .then(setOsStatus)
        .catch(() => {
          // A restart during an update makes this fail for a few seconds. Nothing to
          // report: the next tick picks the status back up.
        });
    }, 3000);
    return () => clearInterval(timer);
  }, [osStatus]);

  const save = (which: 'bridge' | 'os'): void => {
    const section = which === 'bridge' ? 'updates' : 'osUpdates';
    const body = which === 'bridge' ? bridge : os;
    if (body === undefined) {
      return;
    }
    setSaving(which);
    setError(undefined);
    setSaved(undefined);
    api('config.update', { params: { section }, body })
      .then(() => {
        setSaved(which);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : t('save_failed'));
      })
      .finally(() => setSaving(undefined));
  };

  const runNow = (): void => {
    setRunning(true);
    setError(undefined);
    api('osUpdate.run', { body: {} })
      .then(() => api('osUpdate.status', {}))
      .then(setOsStatus)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : t('os_run_failed'));
      })
      .finally(() => setRunning(false));
  };

  if (loading) {
    return (
      <Card>
        <CardHeader title={t('automatic_updates')} />
        <CardBody>
          <div className="flex items-center gap-2">
            <Spinner />
            <span className="text-sm text-slate-500">{t('loading')}</span>
          </div>
        </CardBody>
      </Card>
    );
  }

  const osBusy =
    osStatus !== undefined &&
    osStatus.phase !== 'idle' &&
    osStatus.phase !== 'done' &&
    osStatus.phase !== 'failed';

  return (
    <>
      <Card>
        <CardHeader title={t('automatic_updates')} />
        <CardBody>
          <div className="flex flex-col gap-4">
            {bridge && (
              <>
                <Checkbox
                  id="updatesEnabled"
                  label={t('auto_update_enabled')}
                  checked={bridge.enabled}
                  onChange={(e) => setBridge({ ...bridge, enabled: e.target.checked })}
                />
                <Input
                  id="updatesCron"
                  label={t('schedule_cron')}
                  hint={t('schedule_cron_hint')}
                  value={bridge.scheduleCron}
                  onChange={(e) => setBridge({ ...bridge, scheduleCron: e.target.value })}
                />
                <Input
                  id="updatesRepo"
                  label={t('github_repo')}
                  value={bridge.githubRepo}
                  onChange={(e) => setBridge({ ...bridge, githubRepo: e.target.value })}
                />
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    className="w-fit"
                    loading={saving === 'bridge'}
                    onClick={() => save('bridge')}
                  >
                    {t('save_button')}
                  </Button>
                  {saved === 'bridge' && <Badge tone="ok">{t('saved')}</Badge>}
                </div>
              </>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('schedule_note')}</p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('os_updates_title')} />
        <CardBody>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-slate-600 dark:text-slate-400">{t('os_updates_body')}</p>

            {osStatus && (osBusy || osStatus.lastRunAt !== null) && (
              <div className="rounded-md border border-border px-4 py-3 dark:border-border-dark">
                <div className="flex items-center gap-2">
                  {osBusy && <Spinner />}
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t(`os_phase_${osStatus.phase}`)}
                  </span>
                  {osStatus.rebootPending && <Badge tone="warn">{t('reboot_pending')}</Badge>}
                </div>
                {osStatus.detail && (
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    {osStatus.detail}
                  </p>
                )}
                {osStatus.lastRunAt !== null && !osBusy && (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t('os_last_run', {
                      date: new Date(osStatus.lastRunAt * 1000).toLocaleString(),
                    })}
                  </p>
                )}
              </div>
            )}

            {os && (
              <>
                <Checkbox
                  id="osUpdatesEnabled"
                  label={t('os_auto_enabled')}
                  checked={os.enabled}
                  onChange={(e) => setOs({ ...os, enabled: e.target.checked })}
                />
                <Input
                  id="osUpdatesCron"
                  label={t('schedule_cron')}
                  hint={t('schedule_cron_hint')}
                  value={os.scheduleCron}
                  onChange={(e) => setOs({ ...os, scheduleCron: e.target.value })}
                />
                <div className="flex flex-col gap-1">
                  <Checkbox
                    id="osAutoReboot"
                    label={t('os_auto_reboot')}
                    checked={os.autoReboot}
                    onChange={(e) => setOs({ ...os, autoReboot: e.target.checked })}
                  />
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('os_auto_reboot_hint')}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    className="w-fit"
                    loading={saving === 'os'}
                    onClick={() => save('os')}
                  >
                    {t('save_button')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-fit"
                    loading={running}
                    disabled={osBusy}
                    onClick={runNow}
                  >
                    {t('os_run_now')}
                  </Button>
                  {saved === 'os' && <Badge tone="ok">{t('saved')}</Badge>}
                </div>
              </>
            )}
          </div>
        </CardBody>
      </Card>

      {error && (
        <div className="rounded-md bg-red-50 p-3 dark:bg-red-950">
          <p className="text-sm text-red-700 dark:text-red-200">{error}</p>
        </div>
      )}
    </>
  );
}
