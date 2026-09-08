import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { FullPageSpinner } from '../components/ui/Spinner';
import { StatCard } from '../components/ui/StatCard';
import { Table, type Column } from '../components/ui/Table';
import { useApiQuery } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import { type Lock } from '../../shared';

function bytesToHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function connectionTone(state: string): BadgeTone {
  return state === 'open' ? 'ok' : state === 'connecting' ? 'warn' : 'error';
}

const lockColumns: readonly Column<Lock>[] = [
  {
    key: 'path',
    header: 'Path',
    render: (l) => <span className="font-mono text-xs">{l.relPath}</span>,
  },
  {
    key: 'origin',
    header: 'Origin',
    render: (l) => <Badge tone={l.origin === 'tnc' ? 'accent' : 'idle'}>{l.origin}</Badge>,
  },
  { key: 'owner', header: 'Owner', render: (l) => l.ownerLabel ?? l.tncIp ?? '—' },
  {
    key: 'age',
    header: 'Acquired',
    render: (l) => new Date(l.acquiredAt * 1000).toLocaleTimeString(),
  },
];

export function Dashboard(): JSX.Element {
  const status = useApiQuery('status.get', {}, { pollMs: 15_000 });
  const system = useApiQuery('system.get', {}, { pollMs: 15_000 });
  const locks = useApiQuery('locks.list', { query: {} }, { pollMs: 10_000 });
  const sse = useSSE({ types: ['status', 'lock', 'sync.progress', 'failover', 'conflict'] });

  if (status.loading && status.data === undefined) {
    return <FullPageSpinner />;
  }

  const data = status.data;
  const disk = system.data?.disks[0];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Live status of the sync bridge, version {data?.version ?? '—'}
          </p>
        </div>
        <Badge tone={connectionTone(sse.state)}>
          {sse.state === 'open'
            ? 'Live'
            : sse.state === 'connecting'
              ? 'Connecting…'
              : 'Disconnected'}
        </Badge>
      </div>

      {status.error !== undefined && (
        <Card className="border-status-error/40">
          <CardBody>
            <p className="text-sm text-status-error">
              Could not load status: {status.error.message}
            </p>
          </CardBody>
        </Card>
      )}

      {data !== undefined && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard
              label="Server link"
              value={data.serverLink.reachable ? 'Online' : 'Offline'}
              tone={data.serverLink.reachable ? 'ok' : 'error'}
              hint={data.serverLink.dialect ?? undefined}
            />
            <StatCard label="Shares enabled" value={data.totals.sharesEnabled} />
            <StatCard
              label="Files indexed"
              value={data.totals.filesIndexed}
              hint={`${data.totals.filesPending} pending`}
            />
            <StatCard
              label="Active locks"
              value={data.totals.activeLocks}
              tone={data.totals.activeLocks > 0 ? 'warn' : 'default'}
            />
            <StatCard
              label="Conflicts"
              value={data.totals.unacknowledgedConflicts}
              tone={data.totals.unacknowledgedConflicts > 0 ? 'error' : 'default'}
            />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard
              label="Throughput in"
              value={`${bytesToHuman(data.totals.bytesInPerSec)}/s`}
            />
            <StatCard
              label="Throughput out"
              value={`${bytesToHuman(data.totals.bytesOutPerSec)}/s`}
            />
            <StatCard
              label="Disk used"
              value={disk !== undefined ? `${disk.usedPct}%` : '—'}
              tone={disk !== undefined && disk.usedPct >= 85 ? 'warn' : 'default'}
              hint={disk !== undefined ? bytesToHuman(disk.freeBytes) + ' free' : undefined}
            />
            <StatCard
              label="Memory used"
              value={system.data !== undefined ? `${system.data.memory.usedPct}%` : '—'}
            />
          </div>

          {data.readOnlyReason !== null && (
            <Card className="border-status-warn/40">
              <CardBody>
                <p className="text-sm text-status-warn">Read-only: {data.readOnlyReason}</p>
              </CardBody>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardHeader title="Active locks" subtitle={`${locks.data?.total ?? 0} currently held`} />
        {locks.data?.items.length === 0 ? (
          <EmptyState
            title="No active locks"
            description="Files locked by a TNC or an operator appear here."
          />
        ) : (
          <Table columns={lockColumns} rows={locks.data?.items ?? []} rowKey={(l) => l.id} />
        )}
      </Card>

      <Card>
        <CardHeader title="Recent events" subtitle="Live from the bridge's event bus" />
        <CardBody className="max-h-72 overflow-y-auto p-0">
          {sse.events.length === 0 ? (
            <EmptyState
              title="No events yet"
              description="Sync, lock and status events will appear here as they happen."
            />
          ) : (
            <ul className="divide-y divide-border text-sm dark:divide-border-dark">
              {[...sse.events].reverse().map((event, i) => (
                <li
                  key={`${event.type}-${event.ts}-${i}`}
                  className="flex items-center justify-between gap-3 px-4 py-2"
                >
                  <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                    {event.type}
                  </span>
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {new Date(event.ts).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
