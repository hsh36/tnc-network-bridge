import { useMemo, useState } from 'react';
import { LOG_SOURCES, type LogEntry, type LogLevel, type LogSource } from '../../shared';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Select } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { useApiQuery } from '../hooks/useApi';

const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const levelTone: Record<LogLevel, BadgeTone> = {
  trace: 'idle',
  debug: 'idle',
  info: 'accent',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

function toCsv(rows: readonly LogEntry[]): string {
  const header = ['id', 'ts', 'level', 'source', 'message', 'requestId', 'shareId'];
  const escape = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [r.id, new Date(r.ts).toISOString(), r.level, r.source, r.message, r.requestId ?? '', r.shareId ?? ''].map(escape).join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

function downloadCsv(rows: readonly LogEntry[]): void {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tnc-bridge-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function Logs(): JSX.Element {
  const [level, setLevel] = useState<LogLevel | ''>('');
  const [source, setSource] = useState<LogSource | ''>('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(100);

  const query = useMemo(
    () => ({
      limit,
      offset: 0,
      ...(level !== '' ? { level } : {}),
      ...(source !== '' ? { source } : {}),
      ...(q.trim() !== '' ? { q: q.trim() } : {}),
    }),
    [level, source, q, limit],
  );

  const logs = useApiQuery('logs.list', { query }, { pollMs: 10_000, deps: [level, source, q, limit] });

  const columns: readonly Column<LogEntry>[] = [
    { key: 'ts', header: 'Time', render: (l) => new Date(l.ts).toLocaleString() },
    { key: 'level', header: 'Level', render: (l) => <Badge tone={levelTone[l.level]}>{l.level}</Badge> },
    { key: 'source', header: 'Source', render: (l) => l.source },
    { key: 'message', header: 'Message', render: (l) => <span className="break-words">{l.message}</span> },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Logs</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Filter, search and export sync/error/audit logs.</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={(logs.data?.items.length ?? 0) === 0}
          onClick={() => logs.data !== undefined && downloadCsv(logs.data.items)}
        >
          Export CSV
        </Button>
      </div>

      <Card>
        <CardHeader title="Filters" />
        <CardBody className="flex flex-wrap items-end gap-3">
          <Select
            id="level"
            label="Level"
            value={level}
            onChange={(e) => setLevel(e.target.value as LogLevel | '')}
            className="w-32"
          >
            <option value="">Any</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <Select
            id="source"
            label="Module"
            value={source}
            onChange={(e) => setSource(e.target.value as LogSource | '')}
            className="w-36"
          >
            <option value="">Any</option>
            {LOG_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Input id="q" label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Message contains…" className="min-w-[14rem] flex-1" />
          <Select id="limit" label="Rows" value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))} className="w-24">
            {[50, 100, 250, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Entries" subtitle={`${logs.data?.total ?? 0} matching`} />
        {logs.data?.items.length === 0 ? (
          <EmptyState title="No log entries" description="Nothing matches the current filters yet." />
        ) : (
          <Table columns={columns} rows={logs.data?.items ?? []} rowKey={(l) => l.id} />
        )}
      </Card>
    </div>
  );
}
