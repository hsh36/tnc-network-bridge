import { type Conflict } from '../../shared';
import { Badge, type BadgeTone } from './ui/Badge';
import { Button } from './ui/Button';
import { Table, type Column } from './ui/Table';

export interface ConflictsListProps {
  readonly conflicts: readonly Conflict[];
  readonly onShowDetails: (conflict: Conflict) => void;
  readonly onAcknowledge: (id: number) => void;
  readonly acknowledgingId: number | undefined;
}

const MODE_LABEL: Record<string, string> = {
  last_write_wins: 'Last Write Wins',
  tnc_wins: 'TNC Wins',
  server_wins: 'Server Wins',
};

const WINNER_LABEL: Record<string, string> = {
  local: 'Local won',
  remote: 'Server won',
};

function getWinnerTone(winner: string): BadgeTone {
  return winner === 'local' ? 'ok' : 'accent';
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

/**
 * Display conflicts in a table: unresolved conflicts with applied mode, winner, and actions.
 * Click "View Details" to see both sides and options to restore the losing version.
 */
export function ConflictsList({
  conflicts,
  onShowDetails,
  onAcknowledge,
  acknowledgingId,
}: ConflictsListProps): JSX.Element {
  const columns: readonly Column<Conflict>[] = [
    {
      key: 'path',
      header: 'File Path',
      render: (conflict) => <span className="font-mono text-xs">{conflict.relPath}</span>,
    },
    {
      key: 'share',
      header: 'Share',
      render: (conflict) => <span>{conflict.shareId}</span>,
    },
    {
      key: 'timestamp',
      header: 'Detected At',
      render: (conflict) => formatDate(conflict.ts),
    },
    {
      key: 'winner',
      header: 'Outcome',
      render: (conflict) => (
        <Badge tone={getWinnerTone(conflict.winner)}>{WINNER_LABEL[conflict.winner]}</Badge>
      ),
    },
    {
      key: 'mode',
      header: 'Mode Applied',
      render: (conflict) => (
        <span className="text-xs">{MODE_LABEL[conflict.modeApplied] ?? conflict.modeApplied}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (conflict) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => onShowDetails(conflict)}>
            Details
          </Button>
          {!conflict.acknowledged && (
            <Button
              size="sm"
              variant="secondary"
              loading={acknowledgingId === conflict.id}
              onClick={() => onAcknowledge(conflict.id)}
            >
              Acknowledge
            </Button>
          )}
        </div>
      ),
    },
  ];

  return <Table columns={columns} rows={conflicts} rowKey={(c) => c.id} />;
}
