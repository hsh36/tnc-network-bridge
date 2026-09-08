import { useEffect, useState } from 'react';
import { type ConflictMode } from '../../shared';
import { Button } from './ui/Button';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Checkbox, Input, Select, Textarea } from './ui/Input';
import { useApiQuery } from '../hooks/useApi';
import { api, ApiError } from '../lib/api-client';

interface ShareEditProps {
  readonly shareId: number;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}

interface ShareForm {
  conflictMode: ConflictMode;
  excludePatterns: string;
  bandwidthLimitKbps: number | null;
  readOnly: boolean;
  scanIntervalMs: number;
  maxFileSizeMb: number;
}

export function ShareEdit({ shareId, onClose, onRefresh }: ShareEditProps): JSX.Element {
  const share = useApiQuery('shares.get', { params: { id: shareId } });
  const [form, setForm] = useState<ShareForm | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (share.data !== undefined) {
      setForm({
        conflictMode: share.data.conflictMode,
        excludePatterns: share.data.excludePatterns.join('\n'),
        bandwidthLimitKbps: share.data.bandwidthLimitKbps,
        readOnly: share.data.readOnly,
        scanIntervalMs: share.data.scanIntervalMs,
        maxFileSizeMb: share.data.maxFileSizeMb,
      });
    }
  }, [share.data]);

  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(false), 3000);
    return () => clearTimeout(timer);
  }, [success]);

  if (share.loading && form === undefined) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-2xl rounded-lg bg-white p-6 dark:bg-surface-dark">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (form === undefined || share.data === undefined) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-2xl rounded-lg bg-white p-6 dark:bg-surface-dark">
          <p className="text-red-600">Could not load share details</p>
          <Button onClick={onClose} className="mt-4">
            Close
          </Button>
        </div>
      </div>
    );
  }

  const handleSave = (): void => {
    if (form === undefined) return;
    setError(undefined);
    setSaving(true);

    const patterns = form.excludePatterns
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    api('shares.update', {
      params: { id: shareId },
      body: {
        conflictMode: form.conflictMode,
        excludePatterns: patterns,
        bandwidthLimitKbps: form.bandwidthLimitKbps,
        readOnly: form.readOnly,
        scanIntervalMs: form.scanIntervalMs,
        maxFileSizeMb: form.maxFileSizeMb,
      },
    })
      .then(() => {
        setSuccess(true);
        onRefresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Could not save share');
      })
      .finally(() => setSaving(false));
  };

  const handleReset = (): void => {
    if (share.data !== undefined) {
      setForm({
        conflictMode: share.data.conflictMode,
        excludePatterns: share.data.excludePatterns.join('\n'),
        bandwidthLimitKbps: share.data.bandwidthLimitKbps,
        readOnly: share.data.readOnly,
        scanIntervalMs: share.data.scanIntervalMs,
        maxFileSizeMb: share.data.maxFileSizeMb,
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white dark:bg-surface-dark">
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-white p-6 dark:border-border-dark dark:bg-surface-dark">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {share.data.name} Settings
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-6 p-6">
          {error !== undefined && (
            <div className="rounded-md border border-status-error/20 bg-status-error/10 p-3">
              <p className="text-sm text-status-error">{error}</p>
            </div>
          )}

          {success && (
            <div className="rounded-md border border-status-ok/20 bg-status-ok/10 p-3">
              <p className="text-sm text-status-ok">Settings saved successfully</p>
            </div>
          )}

          <Card>
            <CardHeader title="Sync Behavior" />
            <CardBody className="flex flex-col gap-4">
              <Select
                id="conflictMode"
                label="Conflict Resolution"
                value={form.conflictMode}
                onChange={(e) => setForm({ ...form, conflictMode: e.target.value as ConflictMode })}
              >
                <option value="last_write_wins">Last Write Wins</option>
                <option value="tnc_wins">TNC Wins</option>
                <option value="server_wins">Server Wins</option>
              </Select>
              <Checkbox
                id="readOnly"
                label="Read-only mode (sync from server only)"
                checked={form.readOnly}
                onChange={(e) => setForm({ ...form, readOnly: e.target.checked })}
              />
              <Input
                id="bandwidthLimit"
                label="Bandwidth Limit (Kbps, empty for unlimited)"
                type="number"
                min="0"
                value={form.bandwidthLimitKbps ?? ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    bandwidthLimitKbps: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="File Handling" />
            <CardBody className="flex flex-col gap-4">
              <Textarea
                id="excludePatterns"
                label="Exclude Patterns (one per line)"
                value={form.excludePatterns}
                onChange={(e) => setForm({ ...form, excludePatterns: e.target.value })}
                placeholder="**/*.tmp&#10;.~lock.*&#10;Thumbs.db"
                className="h-24 font-mono text-xs"
              />
              <Input
                id="maxFileSize"
                label="Max File Size (MB)"
                type="number"
                min="1"
                value={form.maxFileSizeMb}
                onChange={(e) => setForm({ ...form, maxFileSizeMb: Number(e.target.value) })}
              />
            </CardBody>
          </Card>

          <Card>
            <div
              className="cursor-pointer"
              onClick={() => setShowAdvanced(!showAdvanced)}
              role="button"
              tabIndex={0}
            >
              <CardHeader title="Advanced" />
            </div>
            {showAdvanced && (
              <CardBody className="flex flex-col gap-4 border-t border-border dark:border-border-dark">
                <Input
                  id="scanInterval"
                  label="Scan Interval (milliseconds)"
                  type="number"
                  min="1000"
                  value={form.scanIntervalMs}
                  onChange={(e) => setForm({ ...form, scanIntervalMs: Number(e.target.value) })}
                  hint="How often to scan for changes"
                />
              </CardBody>
            )}
          </Card>

          <div className="flex gap-3">
            <Button onClick={handleSave} loading={saving}>
              Save Settings
            </Button>
            <Button variant="ghost" onClick={handleReset}>
              Reset
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
