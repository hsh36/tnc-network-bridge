import { type UpdateHistoryEntry } from '../../shared';
import { Badge, type BadgeTone } from './ui/Badge';
import { Table, type Column } from './ui/Table';

interface UpdateHistoryProps {
  readonly entries: readonly UpdateHistoryEntry[];
}

const RESULT_TONES: Record<UpdateHistoryEntry['result'], BadgeTone> = {
  ok: 'ok',
  failed: 'error',
  rolled_back: 'warn',
};

const RESULT_LABELS: Record<UpdateHistoryEntry['result'], string> = {
  ok: 'Success',
  failed: 'Failed',
  rolled_back: 'Rolled Back',
};

export function UpdateHistory({ entries }: UpdateHistoryProps): JSX.Element {
  const columns: readonly Column<UpdateHistoryEntry>[] = [
    {
      key: 'ts',
      header: 'Date',
      render: (entry) => new Date(entry.ts * 1000).toLocaleString(),
    },
    {
      key: 'fromVersion',
      header: 'From',
      render: (entry) => entry.fromVersion ?? '—',
    },
    {
      key: 'toVersion',
      header: 'To',
      render: (entry) => entry.toVersion ?? '—',
    },
    {
      key: 'result',
      header: 'Result',
      render: (entry) => (
        <Badge tone={RESULT_TONES[entry.result]}>{RESULT_LABELS[entry.result]}</Badge>
      ),
    },
  ];

  if (entries.length === 0) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">No update history</p>;
  }

  return <Table columns={columns} rows={entries} rowKey={(entry) => entry.id} />;
}
