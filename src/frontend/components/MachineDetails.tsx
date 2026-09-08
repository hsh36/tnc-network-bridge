import { useEffect, useState } from 'react';
import { type TncClient } from '../../shared';
import { Button } from './ui/Button';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Input, Select } from './ui/Input';
import { useApiQuery } from '../hooks/useApi';
import { api, ApiError } from '../lib/api-client';

interface MachineDetailsProps {
  readonly machineId: number;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}

export function MachineDetails({
  machineId,
  onClose,
  onRefresh,
}: MachineDetailsProps): JSX.Element {
  const machine = useApiQuery('tncClients.get', { params: { id: machineId } });
  const [form, setForm] = useState<TncClient | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setForm(machine.data);
  }, [machine.data]);

  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  if (machine.loading && form === undefined) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-2xl rounded-lg bg-white p-6 dark:bg-surface-dark">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (form === undefined) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-2xl rounded-lg bg-white p-6 dark:bg-surface-dark">
          <p className="text-red-600">Could not load machine details</p>
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

    api('tncClients.update', {
      params: { id: machineId },
      body: {
        name: form.name,
        model: form.model,
        dhcpStatic: form.dhcpStatic,
        notes: form.notes,
      },
    })
      .then(() => {
        setSuccess(true);
        onRefresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Could not save machine');
      })
      .finally(() => setSaving(false));
  };

  const isOnline = form.lastSeenAt !== null && Date.now() / 1000 - form.lastSeenAt < 300;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white dark:bg-surface-dark">
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-white p-6 dark:border-border-dark dark:bg-surface-dark">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {form.name ?? `TNC-${form.mac?.slice(-4)}`}
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
              <p className="text-sm text-status-ok">Saved successfully</p>
            </div>
          )}

          <Card>
            <CardHeader title="General Information" />
            <CardBody className="flex flex-col gap-4">
              <Input
                id="name"
                label="Machine Name"
                value={form.name ?? ''}
                onChange={(e) => setForm({ ...form, name: e.target.value || null })}
                placeholder={`TNC-${form.mac?.slice(-4)}`}
              />
              <Select
                id="model"
                label="Model"
                value={form.model ?? ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    model: (e.target.value || null) as typeof form.model,
                  })
                }
              >
                <option value="">Unknown</option>
                <option value="iTNC530">iTNC 530</option>
                <option value="TNC620">TNC 620</option>
                <option value="TNC640">TNC 640</option>
                <option value="other">Other</option>
              </Select>
              <Input
                id="notes"
                label="Notes"
                value={form.notes ?? ''}
                onChange={(e) => setForm({ ...form, notes: e.target.value || null })}
                placeholder="Operator notes or location"
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Network Information" />
            <CardBody className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  MAC Address
                </label>
                <code className="text-xs font-mono text-slate-600 dark:text-slate-400">
                  {form.mac ?? '—'}
                </code>
              </div>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Current IP
                </label>
                <code className="text-xs font-mono text-slate-600 dark:text-slate-400">
                  {form.ip ?? '—'}
                </code>
              </div>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Status
                </label>
                <span className={isOnline ? 'text-status-ok' : 'text-status-idle'}>
                  {isOnline ? 'Online' : 'Offline'}
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-4 dark:border-border-dark">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  DHCP Reservation
                </label>
                <input
                  type="checkbox"
                  checked={form.dhcpStatic}
                  onChange={(e) => setForm({ ...form, dhcpStatic: e.target.checked })}
                  className="h-4 w-4"
                />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Activity" />
            <CardBody className="flex flex-col gap-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600 dark:text-slate-400">First Seen</span>
                <span className="text-slate-900 dark:text-slate-100">
                  {form.firstSeenAt !== null
                    ? new Date(form.firstSeenAt * 1000).toLocaleString()
                    : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-600 dark:text-slate-400">Last Activity</span>
                <span className="text-slate-900 dark:text-slate-100">
                  {form.lastSeenAt !== null
                    ? new Date(form.lastSeenAt * 1000).toLocaleString()
                    : '—'}
                </span>
              </div>
            </CardBody>
          </Card>

          <div className="flex gap-3">
            <Button onClick={handleSave} loading={saving}>
              Save
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
