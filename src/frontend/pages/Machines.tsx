import { useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
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
  const t = useTranslation('machines');
  const machines = useApiQuery('tncClients.list', { query: {} }, { pollMs: 30_000 });
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
          aria-label={t('select_all_machines')}
        />
      ),
      render: (m) => (
        <input
          type="checkbox"
          checked={selectedMachines.has(m.id)}
          onChange={(e) => handleSelect(m.id, e.target.checked)}
          aria-label={t('select_machine', { name: m.name ?? m.mac ?? 'unknown' })}
        />
      ),
    },
    {
      key: 'name',
      header: t('name'),
      render: (m) => <span className="font-medium">{m.name ?? `TNC-${m.mac?.slice(-4)}`}</span>,
    },
    {
      key: 'mac',
      header: t('mac_address'),
      render: (m) => <span className="font-mono text-xs text-slate-500">{m.mac ?? '—'}</span>,
    },
    {
      key: 'ip',
      header: t('ip_address'),
      render: (m) => <span className="font-mono text-xs">{m.ip ?? '—'}</span>,
    },
    {
      key: 'model',
      header: t('model'),
      render: (m) => m.model ?? '—',
    },
    {
      key: 'status',
      header: t('status'),
      render: (m) => {
        const isOnline = m.lastSeenAt !== null && Date.now() / 1000 - m.lastSeenAt < 300;
        return (
          <Badge tone={isOnline ? 'ok' : 'idle'}>{isOnline ? t('online') : t('offline')}</Badge>
        );
      },
    },
    {
      key: 'lastActivity',
      header: t('last_activity'),
      render: (m) => (m.lastSeenAt !== null ? new Date(m.lastSeenAt * 1000).toLocaleString() : '—'),
    },
    {
      key: 'actions',
      header: '',
      render: (m) => (
        <Button size="sm" variant="ghost" onClick={() => setSelectedId(m.id)}>
          {t('edit')}
        </Button>
      ),
    },
  ];

  const data = machines.data;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('subtitle')}</p>
      </div>

      {data !== undefined && selectedMachines.size > 0 && (
        <Card className="border-accent/40">
          <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              {t('machines_selected', {
                count: selectedMachines.size,
                plural: selectedMachines.size === 1 ? '' : 's',
              })}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost">
                {t('reserve_selected')}
              </Button>
              <Button size="sm" variant="danger">
                {t('remove_selected')}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title={t('discovered_machines')}
          subtitle={t('found_count', {
            total: data?.total ?? 0,
            plural: (data?.total ?? 0) === 1 ? '' : 's',
          })}
        />
        {data?.items.length === 0 ? (
          <EmptyState
            title={t('no_machines_discovered')}
            description={t('machines_list_description')}
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
