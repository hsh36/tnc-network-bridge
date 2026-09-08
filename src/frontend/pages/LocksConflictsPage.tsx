import { useState } from 'react';
import { type Conflict, type Lock } from '../../shared';
import { ActiveLocksTable } from '../components/ActiveLocksTable';
import { ConflictDetail } from '../components/ConflictDetail';
import { ConflictsList } from '../components/ConflictsList';
import { ForceReleaseDialog } from '../components/ForceReleaseDialog';
import { LockHistoryTable } from '../components/LockHistoryTable';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { Tabs } from '../components/ui/Tabs';
import { useConflicts } from '../hooks/useConflicts';
import { useLocks } from '../hooks/useLocks';
import { api, ApiError } from '../lib/api-client';

/**
 * Locks & Conflicts management page (T51).
 *
 * Three tabs:
 * 1. Active Locks: Real-time updates via SSE, shows who has what locked and why
 * 2. Lock History: Past locks with duration and release reason
 * 3. Conflicts: Unresolved and resolved conflicts with ability to restore losing versions
 */

export function LocksConflictsPage(): JSX.Element {
  // Locks state and hooks
  const locks = useLocks();
  const [releaseConfirm, setReleaseConfirm] = useState<Lock>();
  const [releasingId, setReleasingId] = useState<number>();
  const [lockHistoryPath, setLockHistoryPath] = useState('');

  // Conflicts state and hooks
  const conflicts = useConflicts();
  const [conflictShown, setConflictShown] = useState<Conflict>();
  const [acknowledgingId, setAcknowledgingId] = useState<number>();
  const [isRestoringConflict, setIsRestoringConflict] = useState(false);
  const [isDownloadingConflict, setIsDownloadingConflict] = useState(false);

  // Error state
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  // Handle lock release
  const handleReleaseLock = (lockId: number): void => {
    setReleasingId(lockId);
    const lock = locks.active.find((l) => l.id === lockId);
    if (lock !== undefined) {
      setReleaseConfirm(lock);
    }
  };

  const handleConfirmRelease = (): void => {
    if (releaseConfirm === undefined) {
      return;
    }
    const lockId = releaseConfirm.id;
    api('locks.release', {
      params: { id: lockId },
      query: { reason: 'Force-released from dashboard' },
    })
      .then(() => {
        setNotice(`Lock released`);
        setReleaseConfirm(undefined);
        void locks.refresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Could not release the lock');
      })
      .finally(() => setReleasingId(undefined));
  };

  // Handle conflict acknowledgment
  const handleAcknowledgeConflict = (conflictId: number): void => {
    setAcknowledgingId(conflictId);
    api('conflicts.acknowledge', { params: { id: conflictId } })
      .then(() => {
        setNotice('Conflict acknowledged');
        void conflicts.refresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Could not acknowledge the conflict');
      })
      .finally(() => setAcknowledgingId(undefined));
  };

  // Handle conflict resolution (restore losing version)
  const handleRestoreConflictVersion = (): void => {
    if (conflictShown === undefined || conflictShown.loserVersionId === null) {
      return;
    }
    setIsRestoringConflict(true);
    api('versions.restore', {
      params: { id: conflictShown.loserVersionId },
      body: {},
    })
      .then((result) => {
        setNotice(
          `Restored version ${String(result.restoredTo)}. The content it replaced was saved as version ${String(
            result.preRestoreVersionId,
          )}.`,
        );
        setConflictShown(undefined);
        void conflicts.refresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Could not restore the version');
      })
      .finally(() => setIsRestoringConflict(false));
  };

  // Handle download losing version
  const handleDownloadConflictVersion = (versionId: number): void => {
    setIsDownloadingConflict(true);
    api('versions.download', { params: { id: versionId } })
      .then(async (blob) => {
        const url = URL.createObjectURL(blob as Blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `version-${String(versionId)}.bin`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Could not download the version');
      })
      .finally(() => setIsDownloadingConflict(false));
  };

  // Build tab items
  const activeLocksTab: React.ComponentProps<typeof Tabs>['items'][0] = {
    id: 'active-locks',
    label: `Active Locks (${String(locks.active.length)})`,
    content: locks.loading ? (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    ) : locks.active.length === 0 ? (
      <EmptyState title="No active locks" />
    ) : (
      <Card>
        <CardBody>
          <ActiveLocksTable
            locks={locks.active}
            onRelease={handleReleaseLock}
            onShowDetails={() => {}}
            releasingId={releasingId}
            nowMs={Date.now()}
          />
        </CardBody>
      </Card>
    ),
  };

  const lockHistoryTab: React.ComponentProps<typeof Tabs>['items'][0] = {
    id: 'lock-history',
    label: `Lock History (${String(locks.history.length)})`,
    content: locks.loading ? (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    ) : (
      <LockHistoryTable
        locks={locks.history}
        onSearchChange={setLockHistoryPath}
        searchPath={lockHistoryPath}
      />
    ),
  };

  const unresolvedCount = conflicts.unresolved.length;
  const conflictsTab: React.ComponentProps<typeof Tabs>['items'][0] = {
    id: 'conflicts',
    label: `Conflicts (${String(unresolvedCount)} unresolved)`,
    content: conflicts.loading ? (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    ) : conflicts.unresolved.length === 0 && conflicts.resolved.length === 0 ? (
      <EmptyState title="No conflicts" description="Great! Everything is in sync." />
    ) : (
      <div className="flex flex-col gap-6">
        {conflicts.unresolved.length > 0 && (
          <Card>
            <CardHeader title={`Unresolved (${String(conflicts.unresolved.length)})`} />
            <CardBody>
              <ConflictsList
                conflicts={conflicts.unresolved}
                onShowDetails={setConflictShown}
                onAcknowledge={handleAcknowledgeConflict}
                acknowledgingId={acknowledgingId}
              />
            </CardBody>
          </Card>
        )}

        {conflicts.resolved.length > 0 && (
          <Card>
            <CardHeader title={`Resolved (${String(conflicts.resolved.length)})`} />
            <CardBody>
              <ConflictsList
                conflicts={conflicts.resolved}
                onShowDetails={setConflictShown}
                onAcknowledge={handleAcknowledgeConflict}
                acknowledgingId={acknowledgingId}
              />
            </CardBody>
          </Card>
        )}
      </div>
    ),
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Locks & Conflicts
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Manage file locks across machines and resolve any conflicts.
        </p>
      </div>

      {/* Alerts */}
      {notice !== undefined && (
        <div
          role="status"
          className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200"
        >
          {notice}
          <button
            onClick={() => setNotice(undefined)}
            className="float-right font-medium hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {error !== undefined && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200"
        >
          {error}
          <button
            onClick={() => setError(undefined)}
            className="float-right font-medium hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Tabs */}
      <Card>
        <CardBody>
          <Tabs items={[activeLocksTab, lockHistoryTab, conflictsTab]} />
        </CardBody>
      </Card>

      {/* Modals */}
      <ForceReleaseDialog
        lock={releaseConfirm}
        onConfirm={handleConfirmRelease}
        onCancel={() => setReleaseConfirm(undefined)}
        loading={releasingId !== undefined}
      />

      <ConflictDetail
        conflict={conflictShown}
        onRestore={() => handleRestoreConflictVersion()}
        onDownload={handleDownloadConflictVersion}
        onClose={() => setConflictShown(undefined)}
        isRestoring={isRestoringConflict}
        isDownloading={isDownloadingConflict}
      />
    </div>
  );
}
