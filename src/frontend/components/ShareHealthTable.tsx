import { type ShareRuntime } from '../../shared';
import { Badge, type BadgeTone } from './ui/Badge';
import { Card, CardHeader } from './ui/Card';
import { EmptyState } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import { Table, type Column } from './ui/Table';

export interface ShareHealthTableProps {
  readonly shares: ShareRuntime[] | undefined;
  readonly loading?: boolean;
}

function getStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'syncing':
      return 'accent';
    case 'idle':
      return 'ok';
    case 'paused':
      return 'idle';
    case 'error':
      return 'error';
    case 'offline':
      return 'error';
    default:
      return 'idle';
  }
}

const shareColumns: readonly Column<ShareRuntime>[] = [
  {
    key: 'name',
    header: 'Share Name',
    render: (share) => (
      <span className="font-medium text-slate-900 dark:text-slate-100">{share.name}</span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (share) => (
      <Badge tone={getStatusTone(share.status)}>
        {share.status.charAt(0).toUpperCase() + share.status.slice(1)}
      </Badge>
    ),
  },
  {
    key: 'lastScanAt',
    header: 'Last Scan',
    render: (share) =>
      share.lastScanAt !== null ? new Date(share.lastScanAt * 1000).toLocaleString() : '—',
  },
  {
    key: 'filesIndexed',
    header: 'Files Indexed',
    render: (share) => share.filesIndexed,
  },
  {
    key: 'filesPending',
    header: 'Pending',
    render: (share) => (
      <span className={share.filesPending > 0 ? 'font-semibold text-status-warn' : ''}>
        {share.filesPending}
      </span>
    ),
  },
  {
    key: 'filesConflicted',
    header: 'Conflicts',
    render: (share) => (
      <span className={share.filesConflicted > 0 ? 'font-semibold text-status-error' : ''}>
        {share.filesConflicted}
      </span>
    ),
  },
];

export function ShareHealthTable({ shares, loading = false }: ShareHealthTableProps): JSX.Element {
  if (loading) {
    return (
      <Card>
        <CardHeader title="Share Health" subtitle="Status of all shares" />
        <div className="flex h-72 items-center justify-center">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (!shares || shares.length === 0) {
    return (
      <Card>
        <CardHeader title="Share Health" subtitle="Status of all shares" />
        <EmptyState
          title="No shares configured"
          description="Configure shares in the Configuration page."
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Share Health"
        subtitle={`${shares.length} ${shares.length === 1 ? 'share' : 'shares'} configured`}
      />
      <Table columns={shareColumns} rows={shares} rowKey={(s) => s.id} />
    </Card>
  );
}
