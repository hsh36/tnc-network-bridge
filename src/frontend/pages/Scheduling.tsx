import { useState, type FormEvent } from 'react';
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

const KIND_LABEL: Record<ScheduleKind, string> = {
  lock: 'Lock files',
  unlock: 'Unlock files',
  update: 'Check for updates',
  restart: 'Restart service',
  prune: 'Prune old versions',
  scan: 'Rescan share',
  backup: 'Back up database',
};

const KIND_HELP: Record<ScheduleKind, string> = {
  lock: 'Holds a lock over matching paths so the machines cannot change them.',
  unlock: 'Releases locks that a lock window took.',
  update: 'Polls GitHub for a new release on the configured channel.',
  restart: 'Restarts the bridge service. Sync pauses for a few seconds.',
  prune: 'Applies the version retention policy and frees disk.',
  scan: 'Forces a full rescan instead of waiting for the next interval.',
  backup: 'Checkpoints and copies the SQLite database.',
};

/** Presets that cover the schedules this product is actually asked for. */
const PRESETS: readonly { label: string; cron: string }[] = [
  { label: 'Every night at 03:00', cron: '0 3 * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Sundays at 04:00', cron: '0 4 * * 0' },
  { label: 'Weeknights at 22:00', cron: '0 22 * * 1-5' },
  { label: 'First of the month, 02:00', cron: '0 2 1 * *' },
];

const RESULT_TONE: Record<string, BadgeTone> = {
  ok: 'ok',
  error: 'error',
  skipped: 'warn',
};

export function formatNextRun(nextRunAt: number | null, now: number = Date.now()): string {
  if (nextRunAt === null) {
    return 'never';
  }
  const seconds = nextRunAt - Math.floor(now / 1000);
  if (seconds <= 0) {
    return 'due now';
  }
  if (seconds < 3600) {
    return `in ${String(Math.round(seconds / 60))} min`;
  }
  if (seconds < 86_400) {
    return `in ${String(Math.round(seconds / 3600))} h`;
  }
  return `in ${String(Math.round(seconds / 86_400))} d`;
}

export function Scheduling(): JSX.Element {
  const schedules = useApiQuery('schedules.list', { query: { limit: 100 } }, { pollMs: 30_000 });

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
        setPreviewError(err instanceof ApiError ? err.message : 'Could not read that expression'),
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
        setNotice('Schedule created.');
        schedules.refresh();
      })
      .catch((err: unknown) =>
        setFormError(err instanceof ApiError ? err.message : 'Could not create the schedule'),
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
        setFormError(err instanceof ApiError ? err.message : `Could not change "${schedule.name}"`),
      )
      .finally(() => setRunningId(undefined));
  };

  const handleRunNow = (schedule: Schedule): void => {
    setRunningId(schedule.id);
    setNotice(undefined);
    api('schedules.run', { params: { id: schedule.id } })
      .then((result) => {
        setNotice(`"${schedule.name}" ran with result: ${result.result}.`);
        schedules.refresh();
      })
      .catch((err: unknown) =>
        setFormError(err instanceof ApiError ? err.message : 'The run did not start'),
      )
      .finally(() => setRunningId(undefined));
  };

  const handleDelete = (schedule: Schedule): void => {
    setRunningId(schedule.id);
    api('schedules.delete', { params: { id: schedule.id } })
      .then(() => {
        setNotice(`Deleted "${schedule.name}".`);
        schedules.refresh();
      })
      .catch((err: unknown) =>
        setFormError(err instanceof ApiError ? err.message : `Could not delete "${schedule.name}"`),
      )
      .finally(() => setRunningId(undefined));
  };

  const items = schedules.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Scheduling</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Recurring jobs: lock windows, version pruning, rescans, backups and updates.
        </p>
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
        <CardHeader
          title="New schedule"
          subtitle="Pick a preset, or write cron and check it before saving"
        />
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
                label="Which paths"
                value={pathGlob}
                onChange={(e) => setPathGlob(e.target.value)}
                placeholder="**/*.H"
                hint="A lock or unlock window must say which files it applies to."
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
                label="Cron expression"
                value={cron}
                onChange={(e) => {
                  setCron(e.target.value);
                  setNextRuns(undefined);
                }}
                className="min-w-[12rem] font-mono"
                error={formError}
                hint="minute hour day month weekday"
              />
              <Button type="button" variant="secondary" onClick={handlePreview}>
                Check
              </Button>
              <Button
                type="submit"
                loading={busy}
                disabled={name.trim().length === 0 || (needsGlob && pathGlob.trim().length === 0)}
              >
                Create
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
                  This will next run:
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
        <CardHeader title="Schedules" subtitle={`${String(schedules.data?.total ?? 0)} defined`} />
        {items.length === 0 ? (
          <EmptyState
            title="No schedules yet"
            description="Nothing runs automatically until you add a schedule."
          />
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
                    {!schedule.enabled && <Badge tone="idle">Disabled</Badge>}
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
                    Run now
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={runningId === schedule.id}
                    onClick={() => handleToggle(schedule)}
                  >
                    {schedule.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={runningId === schedule.id}
                    onClick={() => handleDelete(schedule)}
                  >
                    Delete
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
