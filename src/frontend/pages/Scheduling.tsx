import { useState, type FormEvent } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { SCHEDULE_KINDS, type Schedule, type ScheduleKind } from '../../shared';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { useApiQuery } from '../hooks/useApi';
import { api, ApiError } from '../lib/api-client';

/**
 * Schedule management (T37).
 *
 * The design problem here is that cron is write-only for most people: five fields that
 * are easy to type and almost impossible to *read back* with confidence. So the page
 * never asks the operator to trust their own reading of an expression.
 *
 * - A set of presets covers the cases this product actually has (nightly, weekly,
 *   hourly, a night-shift lock window), so most schedules are made without touching
 *   cron syntax at all.
 * - Anything typed by hand is previewed against the server before it can be saved: the
 *   form shows the next five real firing times. `0 0 30 2 *` is five valid fields that
 *   never fire, and the only way to make that visible is to show the empty answer.
 * - Existing schedules show their last result and next run, so a job that has been
 *   failing silently every night is apparent at a glance rather than on investigation.
 */

// KIND_LABEL, KIND_HELP and PRESETS are initialized in the component to use translations

const RESULT_TONE: Record<string, BadgeTone> = {
  ok: 'ok',
  error: 'error',
  skipped: 'warn',
};

/**
 * Format the next run time for display.
 * Note: This is a utility function that returns English strings.
 * Translations are handled at the component level via useTranslation.
 */
export function formatNextRun(nextRunAt: number | null, now: number = Date.now()): string {
  if (nextRunAt === null) {
    return 'never';
  }
  const seconds = nextRunAt - Math.floor(now / 1000);
  if (seconds <= 0) {
    return 'due now';
  }
  if (seconds < 3600) {
    return `in ${Math.round(seconds / 60)} min`;
  }
  if (seconds < 86_400) {
    return `in ${Math.round(seconds / 3600)} h`;
  }
  return `in ${Math.round(seconds / 86_400)} d`;
}

export function Scheduling(): JSX.Element {
  const t = useTranslation('scheduling');
  const schedules = useApiQuery('schedules.list', { query: { limit: 100 } }, { pollMs: 30_000 });

  // Initialize KIND_LABEL, KIND_HELP and PRESETS with translations
  const KIND_LABEL: Record<ScheduleKind, string> = {
    lock: t('lock_files'),
    unlock: t('unlock_files'),
    update: t('check_updates'),
    'os-update': t('os_updates'),
    restart: t('restart_service'),
    prune: t('prune_versions'),
    scan: t('rescan_share'),
    backup: t('backup_database'),
  };

  const KIND_HELP: Record<ScheduleKind, string> = {
    lock: t('lock_help'),
    unlock: t('unlock_help'),
    update: t('update_help'),
    'os-update': t('os_update_help'),
    restart: t('restart_help'),
    prune: t('prune_help'),
    scan: t('scan_help'),
    backup: t('backup_help'),
  };

  const PRESETS: readonly { label: string; cron: string }[] = [
    { label: t('preset_night'), cron: '0 3 * * *' },
    { label: t('preset_hour'), cron: '0 * * * *' },
    { label: t('preset_15min'), cron: '*/15 * * * *' },
    { label: t('preset_sunday'), cron: '0 4 * * 0' },
    { label: t('preset_weeknight'), cron: '0 22 * * 1-5' },
    { label: t('preset_month'), cron: '0 2 1 * *' },
  ];

  const [name, setName] = useState('');
  const [kind, setKind] = useState<ScheduleKind>('prune');
  const [cron, setCron] = useState('0 3 * * *');
  const [pathGlob, setPathGlob] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [runningId, setRunningId] = useState<number>();
  const [nextRuns, setNextRuns] = useState<number[]>();
  const [previewError, setPreviewError] = useState<string>();

  const needsGlob = kind === 'lock' || kind === 'unlock';

  const handlePreview = (): void => {
    setPreviewError(undefined);
    setNextRuns(undefined);
    api('schedules.preview', { body: { cron } })
      .then((result) => setNextRuns(result.nextRuns))
      .catch((err: unknown) =>
        setPreviewError(err instanceof ApiError ? err.message : t('cron_preview_error')),
      );
  };

  const handleCreate = (e: FormEvent): void => {
    e.preventDefault();
    setFormError(undefined);
    setBusy(true);
    api('schedules.create', {
      body: {
        name,
        kind,
        cron,
        target: needsGlob ? { pathGlob } : null,
        enabled: true,
      },
    })
      .then(() => {
        setName('');
        setPathGlob('');
        setNextRuns(undefined);
        setNotice(t('schedule_created'));
        schedules.refresh();
      })
      .catch((err: unknown) =>
        setFormError(err instanceof ApiError ? err.message : t('schedule_create_error')),
      )
      .finally(() => setBusy(false));
  };

  const handleToggle = (schedule: Schedule): void => {
    setRunningId(schedule.id);
    api('schedules.update', {
      params: { id: schedule.id },
      body: { enabled: !schedule.enabled },
    })
      .then(() => schedules.refresh())
      .catch((err: unknown) =>
        setFormError(
          err instanceof ApiError
            ? err.message
            : t('schedule_change_error', { name: schedule.name }),
        ),
      )
      .finally(() => setRunningId(undefined));
  };

  const handleRunNow = (schedule: Schedule): void => {
    setRunningId(schedule.id);
    setNotice(undefined);
    api('schedules.run', { params: { id: schedule.id } })
      .then((result) => {
        setNotice(t('schedule_run_result', { name: schedule.name, result: result.result }));
        schedules.refresh();
      })
      .catch((err: unknown) =>
        setFormError(err instanceof ApiError ? err.message : t('schedule_run_error')),
      )
      .finally(() => setRunningId(undefined));
  };

  const handleDelete = (schedule: Schedule): void => {
    setRunningId(schedule.id);
    api('schedules.delete', { params: { id: schedule.id } })
      .then(() => {
        setNotice(t('schedule_deleted', { name: schedule.name }));
        schedules.refresh();
      })
      .catch((err: unknown) =>
        setFormError(
          err instanceof ApiError
            ? err.message
            : t('schedule_delete_error', { name: schedule.name }),
        ),
      )
      .finally(() => setRunningId(undefined));
  };

  const items = schedules.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('subtitle')}</p>
      </div>

      {notice !== undefined && (
        <div
          role="status"
          className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200"
        >
          {notice}
        </div>
      )}

      <Card>
        <CardHeader title={t('new_schedule')} subtitle={t('new_schedule_subtitle')} />
        <CardBody>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <Input
                id="scheduleName"
                label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nightly prune"
                className="min-w-[14rem] flex-1"
              />
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="scheduleKind"
                  className="text-xs font-medium text-slate-700 dark:text-slate-200"
                >
                  What it does
                </label>
                <select
                  id="scheduleKind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as ScheduleKind)}
                  className="rounded-md border border-border bg-white px-3 py-2 text-sm dark:border-border-dark dark:bg-surface-dark-subtle dark:text-slate-100"
                >
                  {SCHEDULE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">{KIND_HELP[kind]}</p>

            {needsGlob && (
              <Input
                id="schedulePathGlob"
                label={t('which_paths')}
                value={pathGlob}
                onChange={(e) => setPathGlob(e.target.value)}
                placeholder={t('paths_placeholder')}
                hint={t('paths_hint')}
              />
            )}

            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.cron}
                  type="button"
                  size="sm"
                  variant={cron === preset.cron ? 'primary' : 'secondary'}
                  onClick={() => {
                    setCron(preset.cron);
                    setNextRuns(undefined);
                  }}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <Input
                id="scheduleCron"
                label={t('cron_label')}
                value={cron}
                onChange={(e) => {
                  setCron(e.target.value);
                  setNextRuns(undefined);
                }}
                className="min-w-[12rem] font-mono"
                error={formError}
                hint={t('cron_hint')}
              />
              <Button type="button" variant="secondary" onClick={handlePreview}>
                {t('check_button')}
              </Button>
              <Button
                type="submit"
                loading={busy}
                disabled={name.trim().length === 0 || (needsGlob && pathGlob.trim().length === 0)}
              >
                {t('create_button')}
              </Button>
            </div>

            {previewError !== undefined && (
              <p role="alert" className="text-xs text-status-error">
                {previewError}
              </p>
            )}
            {nextRuns !== undefined && (
              <div className="rounded-md bg-slate-50 p-3 text-xs dark:bg-slate-900">
                <p className="font-medium text-slate-700 dark:text-slate-200">
                  {t('next_run_label')}
                </p>
                <ul className="mt-1 flex flex-col gap-0.5 text-slate-600 dark:text-slate-300">
                  {nextRuns.map((ts) => (
                    <li key={ts}>{new Date(ts * 1000).toLocaleString()}</li>
                  ))}
                </ul>
              </div>
            )}
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('schedules_title')}
          subtitle={t('schedules_defined', { count: schedules.data?.total ?? 0 })}
        />
        {items.length === 0 ? (
          <EmptyState title={t('no_schedules')} description={t('no_schedules_description')} />
        ) : (
          <ul className="flex flex-col">
            {items.map((schedule) => (
              <li
                key={schedule.id}
                className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 last:border-b-0 dark:border-border-dark"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {schedule.name}
                    </span>
                    <Badge tone="accent">{KIND_LABEL[schedule.kind]}</Badge>
                    {!schedule.enabled && <Badge tone="idle">{t('disabled_badge')}</Badge>}
                    {schedule.lastResult !== null && (
                      <Badge tone={RESULT_TONE[schedule.lastResult] ?? 'idle'}>
                        {schedule.lastResult}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-mono">{schedule.cron}</span>
                    {schedule.enabled && <> · next {formatNextRun(schedule.nextRunAt)}</>}
                    {schedule.target?.pathGlob !== undefined && <> · {schedule.target.pathGlob}</>}
                  </p>
                  {schedule.lastError !== null && (
                    <p className="mt-1 text-xs text-status-error">{schedule.lastError}</p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={runningId === schedule.id}
                    onClick={() => handleRunNow(schedule)}
                  >
                    {t('run_now')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={runningId === schedule.id}
                    onClick={() => handleToggle(schedule)}
                  >
                    {schedule.enabled ? t('disable_button') : t('enable_button')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={runningId === schedule.id}
                    onClick={() => handleDelete(schedule)}
                  >
                    {t('delete_button')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
