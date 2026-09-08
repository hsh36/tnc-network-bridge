import { useEffect, useMemo, useState } from 'react';
import { type Lock } from '../../shared';
import { Badge, type BadgeTone } from './ui/Badge';
import { Button } from './ui/Button';
import { Table, type Column } from './ui/Table';

export interface ActiveLocksTableProps {
  readonly locks: readonly Lock[];
  readonly onRelease: (id: number) => void;
  readonly onShowDetails: (lock: Lock) => void;
  readonly releasingId: number | undefined;
  readonly nowMs: number | undefined;
}

const ORIGIN_TONE: Record<Lock['origin'], BadgeTone> = {
  tnc: 'ok',
  manual: 'accent',
  schedule: 'warn',
  sync: 'idle',
};

const ORIGIN_LABEL: Record<Lock['origin'], string> = {
  tnc: 'Machine',
  manual: 'Manual',
  schedule: 'Schedule',
  sync: 'Sync',
};

/**
 * Format duration as a human-readable string (e.g., "2h 15m", "45s").
 */
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

/**
 * Calculate TTL color based on remaining time.
 */
function getTTLTone(expiresInSeconds: number | null): BadgeTone {
  if (expiresInSeconds === null) {
    return 'idle'; // No expiration
  }
  if (expiresInSeconds < 5 * 60) {
    return 'error'; // Red: less than 5 minutes
  }
  if (expiresInSeconds < 30 * 60) {
    return 'warn'; // Amber: less than 30 minutes
  }
  return 'ok'; // Green: plenty of time
}

/**
 * Display active locks in a table with origin color coding, age tracking, and TTL countdown.
 * Age and TTL are updated every 10 seconds.
 */
export function ActiveLocksTable({
  locks,
  onRelease,
  onShowDetails,
  releasingId,
  nowMs = Date.now(),
}: ActiveLocksTableProps): JSX.Element {
  const [tick, setTick] = useState(0);

  // Update every 10 seconds to keep age and TTL fresh
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  // Recalculate computed values on each tick
  const enrichedLocks = useMemo(
    () =>
      locks.map((lock) => {
        const acquiredMs = lock.acquiredAt * 1000;
        const heldSeconds = Math.max(0, (nowMs - acquiredMs) / 1000);

        let expiresInSeconds: number | null = null;
        if (lock.expiresAt !== null) {
          expiresInSeconds = Math.max(0, lock.expiresAt - Math.floor(nowMs / 1000));
        }

        return {
          lock,
          heldSeconds,
          expiresInSeconds,
        };
      }),
    [locks, tick, nowMs], // tick triggers recalculation even with same locks
  );

  const columns: readonly Column<(typeof enrichedLocks)[0]>[] = [
    {
      key: 'path',
      header: 'File Path',
      render: ({ lock }) => <span className="font-mono text-xs">{lock.relPath}</span>,
    },
    {
      key: 'share',
      header: 'Share',
      render: ({ lock }) => <span>{lock.shareId}</span>,
    },
    {
      key: 'owner',
      header: 'Locked By',
      render: ({ lock }) => <span>{lock.ownerLabel ?? lock.tncIp ?? '(unknown)'}</span>,
    },
    {
      key: 'origin',
      header: 'Origin',
      render: ({ lock }) => (
        <Badge tone={ORIGIN_TONE[lock.origin]}>{ORIGIN_LABEL[lock.origin]}</Badge>
      ),
    },
    {
      key: 'age',
      header: 'Age',
      render: ({ heldSeconds }) => <span>{formatDuration(heldSeconds)}</span>,
    },
    {
      key: 'ttl',
      header: 'TTL',
      render: ({ expiresInSeconds }) =>
        expiresInSeconds !== null ? (
          <Badge tone={getTTLTone(expiresInSeconds)}>
            {expiresInSeconds > 0 ? formatDuration(expiresInSeconds) : 'Expired'}
          </Badge>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">Never</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: ({ lock }) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => onShowDetails(lock)}>
            Details
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={releasingId === lock.id}
            onClick={() => onRelease(lock.id)}
          >
            Release
          </Button>
        </div>
      ),
    },
  ];

  return <Table columns={columns} rows={enrichedLocks} rowKey={({ lock }) => lock.id} />;
}
