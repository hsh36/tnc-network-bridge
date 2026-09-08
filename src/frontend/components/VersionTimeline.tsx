import { useMemo, useState } from 'react';
import { type FileIndexEntry, type FileVersion } from '../../shared';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Badge, type BadgeTone } from './ui/Badge';
import { Button } from './ui/Button';
import { useApiQuery } from '../hooks/useApi';
import { Spinner } from './ui/Spinner';
import { EmptyState } from './ui/EmptyState';
import { api, ApiError } from '../lib/api-client';

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
  restore: 'Restored version',
  initial: 'Initial import',
  conflict_loser: 'Conflict loser',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatAge(createdAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} d ago` : `${Math.floor(days / 30)} mo ago`;
}

export function VersionTimeline({ file }: { readonly file: FileIndexEntry }): JSX.Element {
  const [restoreId, setRestoreId] = useState<number>();
  const [pinnedId, setPinnedId] = useState<number>();
  const [busyId, setBusyId] = useState<number>();
  const [error, setError] = useState<string>();

  const versions = useApiQuery(
    'versions.list',
    {
      query: {
        share: file.shareId,
        path: file.relPath,
        limit: 50,
        offset: 0,
      },
    },
    { deps: [file.shareId, file.relPath] },
  );

  const versionItems = useMemo(() => versions.data?.items ?? [], [versions.data]);

  const handleRestore = (version: FileVersion): void => {
    if (restoreId) return;

    const confirmed = window.confirm(
      `Restore ${file.relPath} to version from ${new Date(version.createdAt * 1000).toLocaleString()}?\n\nThe current content will be saved as a new version first.`,
    );

    if (!confirmed) return;

    setBusyId(version.id);
    setError(undefined);

    api('versions.restore', {
      params: { id: version.id },
      body: {},
    })
      .then(() => {
        setRestoreId(version.id);
        versions.refresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Restore failed');
      })
      .finally(() => setBusyId(undefined));
  };

  const handlePin = (version: FileVersion): void => {
    setBusyId(version.id);
    api('versions.pin', {
      params: { id: version.id },
      body: { pinned: !version.pinned },
    })
      .then(() => {
        setPinnedId(version.id);
        versions.refresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Could not change pin status');
      })
      .finally(() => setBusyId(undefined));
  };

  return (
    <Card>
      <CardHeader title="Version History" />
      <CardBody className="p-0">
        {versions.loading && !versionItems.length ? (
          <div className="flex items-center justify-center p-8">
            <Spinner />
          </div>
        ) : versionItems.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No versions" description="This file has no version history yet" />
          </div>
        ) : (
          <div className="space-y-0 divide-y divide-border dark:divide-border-dark">
            {error && (
              <div className="bg-status-error/5 p-3 text-xs text-status-error">{error}</div>
            )}

            {versionItems.map((version) => (
              <div
                key={version.id}
                className="flex gap-3 border-l-4 border-accent/30 p-3 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={ORIGIN_TONE[version.origin]}>{ORIGIN_LABEL[version.origin]}</Badge>
                    {version.pinned && <Badge tone="warn">📌 Pinned</Badge>}
                  </div>

                  <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                    {formatAge(version.createdAt)} • {formatBytes(version.size)}
                  </p>

                  <p className="mt-1 font-mono text-xs text-slate-500 dark:text-slate-500">
                    {version.hash.slice(0, 12)}
                  </p>
                </div>

                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handlePin(version)}
                    disabled={busyId === version.id}
                  >
                    {version.pinned ? '📌' : '📍'}
                  </Button>

                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleRestore(version)}
                    disabled={busyId === version.id || restoreId === version.id}
                  >
                    Restore
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
