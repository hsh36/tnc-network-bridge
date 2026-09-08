import { useState } from 'react';
import { type ShareRuntime } from '../../shared';
import { Badge, type BadgeTone } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardBody, CardHeader } from './ui/Card';
import { EmptyState } from './ui/EmptyState';
import { FullPageSpinner } from './ui/Spinner';
import { Table, type Column } from './ui/Table';
import { useApiQuery } from '../hooks/useApi';
import { ShareEdit } from './ShareEdit';

function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'syncing':
      return 'accent';
    case 'idle':
      return 'ok';
    case 'paused':
      return 'warn';
    case 'error':
      return 'error';
    case 'offline':
      return 'idle';
    default:
      return 'default';
  }
}

export function SharesSection(): JSX.Element {
  const shares = useApiQuery('shares.list', {}, { pollMs: 15_000 });
  const [editingId, setEditingId] = useState<number>();

  if (shares.loading && shares.data === undefined) {
    return <FullPageSpinner />;
  }

  const handleCreateClick = (): void => {
    // Will implement create share dialog
  };

  const shareColumns: readonly Column<ShareRuntime>[] = [
    {
      key: 'name',
      header: 'Share Name',
      render: (s) => <span className="font-medium">{s.name}</span>,
    },
    {
      key: 'path',
      header: 'Server Path',
      render: (s) => <span className="font-mono text-xs text-slate-500">{s.serverUnc}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (s) => <Badge tone={statusTone(s.status)}>{s.status}</Badge>,
    },
    {
      key: 'files',
      header: 'Files',
      render: (s) => (
        <span className="text-xs text-slate-600 dark:text-slate-400">
          {s.filesIndexed} indexed, {s.filesPending} pending
        </span>
      ),
    },
    {
      key: 'throughput',
      header: 'Throughput',
      render: (s) => {
        const mbIn = (s.bytesInPerSec / 1024 / 1024).toFixed(1);
        const mbOut = (s.bytesOutPerSec / 1024 / 1024).toFixed(1);
        return (
          <span className="text-xs text-slate-600 dark:text-slate-400">
            ↓ {mbIn} MB/s ↑ {mbOut} MB/s
          </span>
        );
      },
    },
    {
      key: 'readOnly',
      header: 'Mode',
      render: (s) => (
        <Badge tone={s.effectiveReadOnly ? 'warn' : 'ok'}>
          {s.effectiveReadOnly ? 'Read-only' : 'RW'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (s) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setEditingId(s.id)}
        >
          Settings
        </Button>
      ),
    },
  ];

  const data = shares.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Shares
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Manage synchronized shares and per-share settings.
          </p>
        </div>
        <Button size="sm" onClick={handleCreateClick}>
          + New Share
        </Button>
      </div>

      <Card>
        <CardHeader
          title="Active shares"
          subtitle={`${data?.total ?? 0} share${data?.total === 1 ? '' : 's'}`}
        />
        {data?.items.length === 0 ? (
          <EmptyState
            title="No shares configured"
            description="Create your first share to begin synchronizing files."
          />
        ) : (
          <Table columns={shareColumns} rows={data?.items ?? []} rowKey={(s) => s.id} />
        )}
      </Card>

      {editingId !== undefined && (
        <ShareEdit
          shareId={editingId}
          onClose={() => setEditingId(undefined)}
          onRefresh={() => shares.refresh()}
        />
      )}
    </div>
  );
}
