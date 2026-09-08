import { type Conflict } from '../../shared';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardBody, CardHeader } from './ui/Card';

export interface ConflictDetailProps {
  readonly conflict: Conflict | undefined;
  readonly onRestore: () => void;
  readonly onDownload: (versionId: number) => void;
  readonly onClose: () => void;
  readonly isRestoring: boolean | undefined;
  readonly isDownloading: boolean | undefined;
}

const MODE_LABEL: Record<string, string> = {
  last_write_wins: 'Last Write Wins',
  tnc_wins: 'TNC Wins',
  server_wins: 'Server Wins',
};

const ORIGIN_LABEL: Record<'local' | 'remote', string> = {
  local: 'Local (TNC Machine)',
  remote: 'Server',
};

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

/**
 * Modal displaying conflict details: both sides with metadata, and options to restore or download.
 * Losing version can be restored with one click; current version is preserved as a new version first.
 */
export function ConflictDetail({
  conflict,
  onRestore,
  onDownload,
  onClose,
  isRestoring,
  isDownloading,
}: ConflictDetailProps): JSX.Element | null {
  if (conflict === undefined) {
    return null;
  }

  const isLocalWinner = conflict.winner === 'local';
  const losingOrigin = isLocalWinner ? 'remote' : 'local';
  const winningOrigin = conflict.winner;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <Card>
          <CardHeader
            title={
              <span id="conflict-title">
                Conflict on <span className="font-mono text-sm">{conflict.relPath}</span>
              </span>
            }
          />
          <CardBody className="flex flex-col gap-6 text-sm">
            {/* Conflict metadata */}
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <p className="uppercase tracking-wide text-slate-500 dark:text-slate-400">Share</p>
                <p className="font-medium text-slate-900 dark:text-slate-100">{conflict.shareId}</p>
              </div>
              <div>
                <p className="uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Detected
                </p>
                <p className="font-medium text-slate-900 dark:text-slate-100">
                  {formatDate(conflict.ts)}
                </p>
              </div>
              <div>
                <p className="uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Mode Applied
                </p>
                <p className="font-medium text-slate-900 dark:text-slate-100">
                  {MODE_LABEL[conflict.modeApplied] ?? conflict.modeApplied}
                </p>
              </div>
              <div>
                <p className="uppercase tracking-wide text-slate-500 dark:text-slate-400">Status</p>
                <p className="font-medium">
                  <Badge tone={conflict.acknowledged ? 'idle' : 'error'}>
                    {conflict.acknowledged ? 'Acknowledged' : 'Unresolved'}
                  </Badge>
                </p>
              </div>
            </div>

            {/* Two-column display for losing and winning sides */}
            <div className="grid grid-cols-2 gap-4">
              {/* Losing side */}
              <div className="rounded-md border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20">
                <h3 className="mb-2 font-semibold text-red-900 dark:text-red-200">
                  Losing Version ({ORIGIN_LABEL[losingOrigin]})
                </h3>
                <dl className="space-y-2 text-xs">
                  <div>
                    <dt className="font-medium text-slate-700 dark:text-slate-300">Modified</dt>
                    <dd className="text-slate-600 dark:text-slate-400">
                      {losingOrigin === 'local' && conflict.localMtime
                        ? formatDate(Math.floor(conflict.localMtime / 1000))
                        : losingOrigin === 'remote' && conflict.remoteMtime
                          ? formatDate(Math.floor(conflict.remoteMtime / 1000))
                          : 'Unknown'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-700 dark:text-slate-300">Hash</dt>
                    <dd className="font-mono text-slate-600 dark:text-slate-400">
                      {conflict.loserHash?.slice(0, 12) ?? 'Unknown'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-700 dark:text-slate-300">Status</dt>
                    <dd>
                      <Badge tone="error">
                        {conflict.loserVersionId !== null ? 'Stored in versions' : 'Lost'}
                      </Badge>
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-col gap-2">
                  {conflict.loserVersionId !== null && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={isRestoring ?? false}
                        onClick={onRestore}
                      >
                        Restore This Version
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={isDownloading ?? false}
                        onClick={() => onDownload(conflict.loserVersionId!)}
                      >
                        Download
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Winning side */}
              <div className="rounded-md border border-green-300 bg-green-50 p-4 dark:border-green-800 dark:bg-green-900/20">
                <h3 className="mb-2 font-semibold text-green-900 dark:text-green-200">
                  Winning Version ({ORIGIN_LABEL[winningOrigin]})
                </h3>
                <dl className="space-y-2 text-xs">
                  <div>
                    <dt className="font-medium text-slate-700 dark:text-slate-300">Modified</dt>
                    <dd className="text-slate-600 dark:text-slate-400">
                      {winningOrigin === 'local' && conflict.localMtime
                        ? formatDate(Math.floor(conflict.localMtime / 1000))
                        : winningOrigin === 'remote' && conflict.remoteMtime
                          ? formatDate(Math.floor(conflict.remoteMtime / 1000))
                          : 'Unknown'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-700 dark:text-slate-300">Hash</dt>
                    <dd className="font-mono text-slate-600 dark:text-slate-400">
                      {conflict.winnerHash?.slice(0, 12) ?? 'Unknown'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-slate-700 dark:text-slate-300">Status</dt>
                    <dd>
                      <Badge tone="ok">Currently active</Badge>
                    </dd>
                  </div>
                </dl>
              </div>
            </div>

            {/* Help text */}
            <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              <strong>Did you know?</strong> You can always restore the losing version using the
              Versions page. Every restore is captured as a new version, so you can undo it if
              needed.
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
