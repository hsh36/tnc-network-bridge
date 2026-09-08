import { type FileVersion } from '../../shared';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Button } from './ui/Button';
import { Badge, type BadgeTone } from './ui/Badge';

const ORIGIN_TONE: Record<FileVersion['origin'], BadgeTone> = {
  server: 'accent',
  tnc: 'ok',
  restore: 'warn',
  initial: 'idle',
  conflict_loser: 'error',
};

const ORIGIN_LABEL: Record<FileVersion['origin'], string> = {
  server: 'From server',
  tnc: 'From machine',
  restore: 'Restored version',
  initial: 'Initial import',
  conflict_loser: 'Conflict loser',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function VersionDetailModal({
  version,
  onClose,
  onRestore,
  onDownload,
}: {
  readonly version: FileVersion;
  readonly onClose: () => void;
  readonly onRestore: (version: FileVersion) => void;
  readonly onDownload: (version: FileVersion) => void;
}): JSX.Element {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader
          title="Version Details"
          action={
            <Button variant="ghost" size="sm" onClick={onClose}>
              ✕
            </Button>
          }
        />
        <CardBody className="space-y-4">
          <div>
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">Origin</p>
            <Badge tone={ORIGIN_TONE[version.origin]} className="mt-1">
              {ORIGIN_LABEL[version.origin]}
            </Badge>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">Size</p>
            <p className="mt-1 text-sm">{formatBytes(version.size)}</p>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">Hash</p>
            <p className="mt-1 font-mono text-xs text-slate-600 dark:text-slate-400">
              {version.hash}
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">Created</p>
            <p className="mt-1 text-sm">{new Date(version.createdAt * 1000).toLocaleString()}</p>
          </div>

          {version.reason && (
            <div>
              <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">Reason</p>
              <p className="mt-1 text-sm">{version.reason}</p>
            </div>
          )}

          <div className="flex gap-2 pt-4">
            <Button variant="secondary" size="sm" onClick={() => onDownload(version)}>
              Download
            </Button>
            <Button variant="primary" size="sm" onClick={() => onRestore(version)}>
              Restore
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
