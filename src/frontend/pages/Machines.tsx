import { useState } from 'react';
import { type TncClient } from '../../shared';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { FullPageSpinner } from '../components/ui/Spinner';
import { Table, type Column } from '../components/ui/Table';
import { useApiQuery } from '../hooks/useApi';
import { MachineDetails } from '../components/MachineDetails';
import { Badge } from '../components/ui/Badge';

export function Machines(): JSX.Element {
  const machines = useApiQuery('tncClients.list', {}, { pollMs: 30_000 });
  const [selectedId, setSelectedId] = useState<number>();
  const [selectedMachines, setSelectedMachines] = useState<Set<number>>(new Set());

  if (machines.loading && machines.data === undefined) {
    return <FullPageSpinner />;
  }

  const handleSelectAll = (checked: boolean): void => {
    if (checked) {
      setSelectedMachines(new Set(machines.data?.items.map((m) => m.id) ?? []));
    } else {
      setSelectedMachines(new Set());
    }
  };

  const handleSelect = (id: number, checked: boolean): void => {
    const newSet = new Set(selectedMachines);
    if (checked) {
      newSet.add(id);
    } else {
      newSet.delete(id);
    }
    setSelectedMachines(newSet);
  };

  const machineColumns: readonly Column<TncClient>[] = [
    {
      key: 'checkbox',
      header: (
        <input
          type="checkbox"
          checked={
            machines.data !== undefined &&
            machines.data.items.length > 0 &&
            selectedMachines.size === machines.data.items.length
          }
          onChange={(e) => handleSelectAll(e.target.checked)}
          aria-label="Select all machines"
        />
      ),
      render: (m) => (
        <input
          type="checkbox"
          checked={selectedMachines.has(m.id)}
          onChange={(e) => handleSelect(m.id, e.target.checked)}
          aria-label={`Select ${m.name || m.mac}`}
        />
      ),
    },
    {
      key: 'name',
      header: 'Name',
      render: (m) => <span className="font-medium">{m.name || `TNC-${m.mac?.slice(-4)}`}</span>,
    },
    {
      key: 'mac',
      header: 'MAC Address',
      render: (m) => <span className="font-mono text-xs text-slate-500">{m.mac || '—'}</span>,
    },
    {
      key: 'ip',
      header: 'IP Address',
      render: (m) => <span className="font-mono text-xs">{m.ip || '—'}</span>,
    },
    {
      key: 'model',
      header: 'Model',
      render: (m) => m.model || '—',
    },
    {
      key: 'status',
      header: 'Status',
      render: (m) => {
        const isOnline = m.lastSeenAt !== null && Date.now() / 1000 - m.lastSeenAt < 300;
        return <Badge tone={isOnline ? 'ok' : 'idle'}>{isOnline ? 'Online' : 'Offline'}</Badge>;
      },
    },
    {
      key: 'lastActivity',
      header: 'Last Activity',
      render: (m) => (m.lastSeenAt !== null ? new Date(m.lastSeenAt * 1000).toLocaleString() : '—'),
    },
    {
      key: 'actions',
      header: '',
      render: (m) => (
        <Button size="sm" variant="ghost" onClick={() => setSelectedId(m.id)}>
          Edit
        </Button>
      ),
    },
  ];

  const data = machines.data;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Machines</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Discovered TNC machines on the network.
        </p>
      </div>

      {data !== undefined && selectedMachines.size > 0 && (
        <Card className="border-accent/40">
          <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              {selectedMachines.size} machine{selectedMachines.size === 1 ? '' : 's'} selected
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost">
                Reserve Selected
              </Button>
              <Button size="sm" variant="danger">
                Remove Selected
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Discovered machines"
          subtitle={`${data?.total ?? 0} machine${data?.total === 1 ? '' : 's'} found`}
        />
        {data?.items.length === 0 ? (
          <EmptyState
            title="No machines discovered"
            description="Machines appearing on the TNC network will be listed here."
          />
        ) : (
          <Table columns={machineColumns} rows={data?.items ?? []} rowKey={(m) => m.id} />
        )}
      </Card>

      {selectedId !== undefined && (
        <MachineDetails
          machineId={selectedId}
          onClose={() => setSelectedId(undefined)}
          onRefresh={() => machines.refresh()}
        />
      )}
    </div>
  );
}
