import { useState, type FormEvent } from 'react';
import { type Lock } from '../../shared';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { Table, type Column } from '../components/ui/Table';
import { useApiQuery } from '../hooks/useApi';
import { api, ApiError } from '../lib/api-client';

export function Locks(): JSX.Element {
  const locks = useApiQuery('locks.list', { query: { includeReleased: false } }, { pollMs: 8000 });
  const [shareId, setShareId] = useState('1');
  const [relPath, setRelPath] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [releasingId, setReleasingId] = useState<number>();

  const handleCreate = (e: FormEvent): void => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    api('locks.create', { body: { shareId: Number(shareId), relPath } })
      .then(() => {
        setRelPath('');
        locks.refresh();
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not create the lock'),
      )
      .finally(() => setBusy(false));
  };

  const handleRelease = (id: number): void => {
    setReleasingId(id);
    void api('locks.release', { params: { id }, query: { reason: 'Released from the dashboard' } })
      .then(() => locks.refresh())
      .finally(() => setReleasingId(undefined));
  };

  const columns: readonly Column<Lock>[] = [
    {
      key: 'path',
      header: 'Path',
      render: (l) => <span className="font-mono text-xs">{l.relPath}</span>,
    },
    { key: 'share', header: 'Share', render: (l) => l.shareId },
    {
      key: 'origin',
      header: 'Origin',
      render: (l) => <Badge tone={l.origin === 'tnc' ? 'accent' : 'idle'}>{l.origin}</Badge>,
    },
    { key: 'owner', header: 'Owner', render: (l) => l.ownerLabel ?? l.tncIp ?? '—' },
    {
      key: 'acquired',
      header: 'Acquired',
      render: (l) => new Date(l.acquiredAt * 1000).toLocaleString(),
    },
    {
      key: 'expires',
      header: 'Expires',
      render: (l) =>
        l.expiresAt !== null ? new Date(l.expiresAt * 1000).toLocaleString() : 'Never',
    },
    {
      key: 'actions',
      header: '',
      render: (l) => (
        <Button
          size="sm"
          variant="danger"
          loading={releasingId === l.id}
          onClick={() => handleRelease(l.id)}
        >
          Release
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Locks</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Files currently locked by a TNC, the scheduler, or an operator.
        </p>
      </div>

      <Card>
        <CardHeader title="Take a manual lock" />
        <CardBody>
          <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
            <Input
              id="shareId"
              label="Share ID"
              value={shareId}
              onChange={(e) => setShareId(e.target.value)}
              className="w-24"
            />
            <Input
              id="relPath"
              label="Path"
              value={relPath}
              onChange={(e) => setRelPath(e.target.value)}
              placeholder="programs/part1.h"
              className="min-w-[16rem] flex-1"
              error={error}
            />
            <Button type="submit" loading={busy} disabled={relPath.trim().length === 0}>
              Lock
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Active locks" subtitle={`${locks.data?.total ?? 0} currently held`} />
        {locks.data?.items.length === 0 ? (
          <EmptyState title="No active locks" />
        ) : (
          <Table columns={columns} rows={locks.data?.items ?? []} rowKey={(l) => l.id} />
        )}
      </Card>
    </div>
  );
}
