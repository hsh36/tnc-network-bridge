import { type Lock } from '../../shared';
import { Button } from './ui/Button';
import { Card, CardBody, CardHeader } from './ui/Card';

export interface ForceReleaseDialogProps {
  readonly lock: Lock | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly loading?: boolean;
}

/**
 * Confirmation dialog for force-releasing a lock.
 * Warns the operator that the machine may have unsaved work.
 */
export function ForceReleaseDialog({
  lock,
  onConfirm,
  onCancel,
  loading,
}: ForceReleaseDialogProps): JSX.Element | null {
  if (lock === undefined) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="release-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <Card className="w-full max-w-lg">
        <CardHeader title={<span id="release-title">Force-release this lock?</span>} />
        <CardBody className="flex flex-col gap-4 text-sm">
          <p className="text-slate-700 dark:text-slate-200">
            Release the lock held by <strong>{lock.ownerLabel ?? lock.tncIp ?? 'unknown'}</strong>{' '}
            on file <span className="font-mono">{lock.relPath}</span>?
          </p>
          <div className="rounded-md border border-orange-300 bg-orange-50 p-3 text-xs text-orange-900 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-200">
            <strong>Warning:</strong> This machine may have the file open with unsaved work. Forcing
            a release could cause data loss or corruption on the machine.
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            This action will be logged in the audit trail.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={loading ?? false}>
              Cancel
            </Button>
            <Button variant="danger" loading={loading ?? false} onClick={onConfirm}>
              Force Release
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
