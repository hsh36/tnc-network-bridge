import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { type FileVersion } from '../../shared';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { useApiQuery } from '../hooks/useApi';
import { api, ApiError } from '../lib/api-client';

/**
 * Version history and restore (T35).
 *
 * Laid out as a timeline rather than a table. A table invites the reader to compare
 * rows field by field; what an operator actually needs to answer here is "which of these
 * is the one I want back?", which is a question about *sequence* — what changed, in what
 * order, and which entry is the file as it stands now. The timeline makes that ordering
 * the primary visual fact.
 *
 * ## Restore is deliberately awkward
 *
 * Restoring overwrites a program on a machine that may be mid-job, so the confirmation
 * names the file and the timestamp and requires a second, explicit click. The one thing
 * that makes it *safe* rather than merely guarded is stated in the dialog: the current
 * content is captured as a new version first, so the restore can itself be undone.
 * Telling the operator that is what turns a scary irreversible-looking button into an
 * accurate mental model.
 */

const PREVIEW_MAX_BYTES = 64 * 1024;

/** Extensions whose content is worth showing inline. NC programs are all plain text. */
const TEXT_EXTENSIONS = new Set([
  'h',
  'i',
  'txt',
  'nc',
  'cnc',
  'tap',
  'iso',
  'ptn',
  'cyc',
  'tab',
  'json',
  'xml',
  'csv',
  'log',
  'ini',
  'cfg',
]);

function isPreviewable(version: FileVersion): boolean {
  const ext = version.relPath.split('.').pop()?.toLowerCase() ?? '';
  return version.size <= PREVIEW_MAX_BYTES && TEXT_EXTENSIONS.has(ext);
}

const ORIGIN_TONE: Record<FileVersion['origin'], BadgeTone> = {
  server: 'accent',
  tnc: 'ok',
  restore: 'warn',
  initial: 'idle',
  conflict_loser: 'error',
};

const ORIGIN_LABEL: Record<FileVersion['origin'], string> = {
  server: 'From server',
  tnc: 'From machine',
  restore: 'Pre-restore image',
  initial: 'Initial import',
  conflict_loser: 'Lost a conflict',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'GB'}`;
}

/** Relative age, which is how an operator actually reasons about "which one do I want". */
export function formatAge(createdAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - createdAt);
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)} h ago`;
  }
  const days = Math.floor(hours / 24);
  return days < 30 ? `${String(days)} d ago` : `${String(Math.floor(days / 30))} mo ago`;
}

interface ConfirmState {
  readonly version: FileVersion;
  readonly targetPath: string;
}

export function Versions(): JSX.Element {
  const [shareId, setShareId] = useState('1');
  const [path, setPath] = useState('');
  const [applied, setApplied] = useState<{ share: number; path: string }>({ share: 1, path: '' });

  const versions = useApiQuery(
    'versions.list',
    {
      query: {
        share: applied.share,
        ...(applied.path.length > 0 ? { path: applied.path } : {}),
        limit: 100,
      },
    },
    { deps: [applied.share, applied.path] },
  );

  const retention = useApiQuery('config.get', { params: { section: 'versioning' } }, {});

  const [confirm, setConfirm] = useState<ConfirmState>();
  const [busyId, setBusyId] = useState<number>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{ id: number; text: string } | undefined>();

  const items = versions.data?.items ?? [];

  /**
   * The newest entry for each path is the file as it currently stands.
   *
   * Worth marking, because "restore the one at the top" is almost never what someone
   * means to do — and restoring a file over itself would capture a pointless pre-image.
   * The list arrives newest-first, so the first occurrence of a path is its newest.
   * Only the first page is loaded, so every path shown here has its true newest present.
   */
  const currentIds = useMemo(() => {
    const seen = new Set<string>();
    const ids = new Set<number>();
    for (const item of items) {
      if (!seen.has(item.relPath)) {
        seen.add(item.relPath);
        ids.add(item.id);
      }
    }
    return ids;
  }, [items]);

  useEffect(() => {
    setPreview(undefined);
  }, [applied.share, applied.path]);

  const handleFilter = (e: FormEvent): void => {
    e.preventDefault();
    setApplied({ share: Number(shareId) || 1, path: path.trim() });
  };

  const handleRestore = (): void => {
    if (confirm === undefined) {
      return;
    }
    const { version, targetPath } = confirm;
    setBusyId(version.id);
    setError(undefined);
    api('versions.restore', {
      params: { id: version.id },
      body: targetPath.trim().length > 0 ? { targetPath: targetPath.trim() } : {},
    })
      .then((result) => {
        setNotice(
          `Restored ${result.restoredTo}. The content it replaced was saved as version ${String(
            result.preRestoreVersionId,
          )}, so this can be undone.`,
        );
        setConfirm(undefined);
        versions.refresh();
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'The restore did not complete'),
      )
      .finally(() => setBusyId(undefined));
  };

  const handlePin = (version: FileVersion): void => {
    setBusyId(version.id);
    api('versions.pin', { params: { id: version.id }, body: { pinned: !version.pinned } })
      .then(() => versions.refresh())
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not change the pin'),
      )
      .finally(() => setBusyId(undefined));
  };

  const handleDelete = (version: FileVersion): void => {
    setBusyId(version.id);
    setError(undefined);
    api('versions.delete', { params: { id: version.id } })
      .then(() => {
        setNotice(`Deleted version ${String(version.id)}.`);
        versions.refresh();
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not delete the version'),
      )
      .finally(() => setBusyId(undefined));
  };

  const handlePreview = (version: FileVersion): void => {
    if (preview?.id === version.id) {
      setPreview(undefined);
      return;
    }
    setBusyId(version.id);
    api('versions.download', { params: { id: version.id } })
      .then(async (blob) => {
        const text = await (blob as Blob).text();
        setPreview({ id: version.id, text });
      })
      .catch(() => setError('Could not read that version'))
      .finally(() => setBusyId(undefined));
  };

  const policy = retention.data as
    { keepCount?: number; keepDays?: number; maxStoreGb?: number } | undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Versions</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Every version captured before content was overwritten, and the ability to put any of it
          back.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Find a file"
          subtitle="Leave the path empty to see the whole share's history"
        />
        <CardBody>
          <form onSubmit={handleFilter} className="flex flex-wrap items-end gap-3">
            <Input
              id="versionShare"
              label="Share ID"
              value={shareId}
              onChange={(e) => setShareId(e.target.value)}
              className="w-24"
            />
            <Input
              id="versionPath"
              label="Path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="PGM/PART1.H"
              className="min-w-[16rem] flex-1"
            />
            <Button type="submit" loading={versions.loading}>
              Show history
            </Button>
          </form>
        </CardBody>
      </Card>

      {policy !== undefined && (
        <Card>
          <CardHeader title="Retention policy" />
          <CardBody className="flex flex-wrap gap-6 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Kept per file
              </p>
              <p className="font-medium text-slate-900 dark:text-slate-100">
                {policy.keepCount ?? '—'} versions
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Age limit
              </p>
              <p className="font-medium text-slate-900 dark:text-slate-100">
                {policy.keepDays ?? '—'} days
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Store ceiling
              </p>
              <p className="font-medium text-slate-900 dark:text-slate-100">
                {policy.maxStoreGb ?? '—'} GB
              </p>
            </div>
            <p className="w-full text-xs text-slate-500 dark:text-slate-400">
              Pinned versions and versions referenced by a conflict are never pruned, and the newest
              version of a file is always kept.
            </p>
          </CardBody>
        </Card>
      )}

      {notice !== undefined && (
        <div
          role="status"
          className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200"
        >
          {notice}
        </div>
      )}
      {error !== undefined && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200"
        >
          {error}
        </div>
      )}

      <Card>
        <CardHeader title="History" subtitle={`${String(versions.data?.total ?? 0)} versions`} />
        {items.length === 0 ? (
          <EmptyState
            title="No versions yet"
            description="Versions appear here once the bridge has captured content that was about to be overwritten."
          />
        ) : (
          <ol className="flex flex-col">
            {items.map((version) => {
              const isCurrent = currentIds.has(version.id);
              const busy = busyId === version.id;
              return (
                <li
                  key={version.id}
                  className="border-b border-border px-4 py-3 last:border-b-0 dark:border-border-dark"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-slate-900 dark:text-slate-100">
                          {version.relPath}
                        </span>
                        <Badge tone={ORIGIN_TONE[version.origin]}>
                          {ORIGIN_LABEL[version.origin]}
                        </Badge>
                        {version.pinned && <Badge tone="warn">Pinned</Badge>}
                        {isCurrent && <Badge tone="idle">Current</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {formatAge(version.createdAt)} ·{' '}
                        {new Date(version.createdAt * 1000).toLocaleString()} ·{' '}
                        {formatBytes(version.size)} ·{' '}
                        <span className="font-mono">{version.hash.slice(0, 12)}</span>
                      </p>
                      {version.reason !== null && (
                        <p className="mt-1 text-xs italic text-slate-500 dark:text-slate-400">
                          {version.reason}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-2">
                      {isPreviewable(version) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy}
                          onClick={() => handlePreview(version)}
                        >
                          {preview?.id === version.id ? 'Hide' : 'Preview'}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy}
                        onClick={() => handlePin(version)}
                      >
                        {version.pinned ? 'Unpin' : 'Pin'}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={isCurrent}
                        title={isCurrent ? 'This is the file as it stands now' : undefined}
                        onClick={() => setConfirm({ version, targetPath: '' })}
                      >
                        Restore
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={busy}
                        disabled={version.pinned}
                        title={version.pinned ? 'Unpin before deleting' : undefined}
                        onClick={() => handleDelete(version)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  {preview?.id === version.id && (
                    <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-slate-50 p-3 font-mono text-xs text-slate-800 dark:bg-slate-900 dark:text-slate-200">
                      {preview.text}
                    </pre>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      {confirm !== undefined && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <Card className="w-full max-w-lg">
            <CardHeader title={<span id="restore-title">Restore this version?</span>} />
            <CardBody className="flex flex-col gap-4 text-sm">
              <p className="text-slate-700 dark:text-slate-200">
                This writes the content of{' '}
                <span className="font-mono">{confirm.version.relPath}</span> as it was on{' '}
                <strong>{new Date(confirm.version.createdAt * 1000).toLocaleString()}</strong> back
                into the share.
              </p>
              <p className="rounded-md bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                The file&apos;s current content is saved as a new version first, so this restore can
                itself be undone. If the file is open on a machine, the restore waits for the lock
                to clear.
              </p>
              <Input
                id="restoreTarget"
                label="Restore to a different path (optional)"
                value={confirm.targetPath}
                onChange={(e) => setConfirm({ ...confirm, targetPath: e.target.value })}
                placeholder={confirm.version.relPath}
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirm(undefined)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={busyId === confirm.version.id}
                  onClick={handleRestore}
                >
                  Restore
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
