import { useState, type FormEvent } from 'react';
import { type Lock } from '../../shared';
import { Badge, type BadgeTone } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Input } from './ui/Input';
import { Table, type Column } from './ui/Table';

export interface LockHistoryTableProps {
  readonly locks: readonly Lock[];
  readonly onSearchChange: (path: string) => void;
  readonly searchPath: string;
}

function getReleaseReason(lock: Lock): string {
  if (lock.releasedAt === null) {
    return 'Still active';
  }
  // Try to infer from note or default to "Released normally"
  if (lock.note?.includes('forced')) {
    return 'Force-released';
  }
  if (lock.expiresAt !== null && lock.releasedAt >= lock.expiresAt) {
    return 'Expired';
  }
  return 'Released normally';
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${String(Math.round(seconds))}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes > 0) {
    return `${String(hours)}h ${String(remainingMinutes)}m`;
  }
  return `${String(hours)}h`;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

/**
 * Display lock history: released locks with duration, timestamp, and release reason.
 * Filterable by path and sortable by newest first.
 */
export function LockHistoryTable({
  locks,
  onSearchChange,
  searchPath,
}: LockHistoryTableProps): JSX.Element {
  const [localPath, setLocalPath] = useState(searchPath);

  const handleFilter = (e: FormEvent): void => {
    e.preventDefault();
    onSearchChange(localPath.trim());
  };

  // Filter locks by path
  const filtered = locks.filter(
    (lock) => localPath.trim().length === 0 || lock.relPath.includes(localPath.trim()),
  );

  const columns: readonly Column<Lock>[] = [
    {
      key: 'path',
      header: 'File Path',
      render: (lock) => <span className="font-mono text-xs">{lock.relPath}</span>,
    },
    {
      key: 'share',
      header: 'Share',
      render: (lock) => <span>{lock.shareId}</span>,
    },
    {
      key: 'owner',
      header: 'Machine',
      render: (lock) => <span>{lock.ownerLabel ?? lock.tncIp ?? '(unknown)'}</span>,
    },
    {
      key: 'duration',
      header: 'Duration',
      render: (lock) => {
        if (lock.releasedAt === null || lock.acquiredAt === null) {
          return <span>—</span>;
        }
        const durationSeconds = lock.releasedAt - lock.acquiredAt;
        return <span>{formatDuration(durationSeconds)}</span>;
      },
    },
    {
      key: 'released',
      header: 'Released At',
      render: (lock) => (lock.releasedAt !== null ? formatDate(lock.releasedAt) : <span>—</span>),
    },
    {
      key: 'reason',
      header: 'Release Reason',
      render: (lock) => {
        const tone: BadgeTone =
          lock.releasedAt !== null && lock.expiresAt !== null && lock.releasedAt >= lock.expiresAt
            ? 'warn'
            : 'idle';
        return <Badge tone={tone}>{getReleaseReason(lock)}</Badge>;
      },
    },
  ];

  return (
    <Card>
      <CardHeader title="Lock History" subtitle={`${String(filtered.length)} released locks`} />
      <CardBody>
        <form onSubmit={handleFilter} className="mb-4 flex flex-wrap items-end gap-3">
          <Input
            id="historyPath"
            label="Filter by path"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder="programs/part1.h"
            className="min-w-[16rem] flex-1"
          />
          <Button type="submit">Search</Button>
        </form>
        <Table columns={columns} rows={filtered} rowKey={(lock) => lock.id} />
      </CardBody>
    </Card>
  );
}
