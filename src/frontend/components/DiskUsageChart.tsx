import { useState } from 'react';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { type SystemInfo } from '../../shared';
import { Card, CardHeader } from './ui/Card';
import { Spinner } from './ui/Spinner';
import { formatBytes } from '../hooks/useMetrics';
import { Badge } from './ui/Badge';

export interface DiskUsageChartProps {
  readonly systemInfo: SystemInfo | undefined;
  readonly loading?: boolean;
}

export function DiskUsageChart({ systemInfo, loading = false }: DiskUsageChartProps): JSX.Element {
  const [expandDetail, setExpandDetail] = useState(false);

  const disk = systemInfo?.disks[0];

  if (loading) {
    return (
      <Card>
        <CardHeader title="Disk Usage" subtitle="Cache and version store" />
        <div className="flex h-72 items-center justify-center">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (!disk) {
    return (
      <Card>
        <CardHeader title="Disk Usage" subtitle="Cache and version store" />
        <div className="flex h-72 items-center justify-center text-sm text-slate-500">
          No disk data available
        </div>
      </Card>
    );
  }

  const usedPct = disk.usedPct;
  const data = [
    {
      name: 'Used',
      value: disk.usedBytes,
      color: usedPct >= 90 ? '#ef4444' : usedPct >= 80 ? '#f59e0b' : '#3b82f6',
    },
    { name: 'Free', value: disk.freeBytes, color: '#e5e7eb' },
  ];

  let statusTone = 'ok';
  if (usedPct >= 90) {
    statusTone = 'error';
  } else if (usedPct >= 80) {
    statusTone = 'warn';
  }

  return (
    <Card>
      <CardHeader
        title="Disk Usage"
        subtitle={`${formatBytes(disk.usedBytes)} of ${formatBytes(disk.totalBytes)} used`}
      />
      <div className="p-4">
        <ResponsiveContainer width="100%" height={300}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={80}
              outerRadius={120}
              paddingAngle={2}
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: unknown) => formatBytes(value as number)}
              contentStyle={{
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '4px',
              }}
            />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="space-y-3 border-t border-border px-4 py-3 dark:border-border-dark">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Usage: {usedPct}%
          </span>
          <Badge tone={statusTone as 'ok' | 'warn' | 'error'}>
            {usedPct >= 90 ? 'Critical' : usedPct >= 80 ? 'Warning' : 'Healthy'}
          </Badge>
        </div>

        <div className="flex text-xs text-slate-600 dark:text-slate-300">
          <div className="flex-1">
            <p className="text-slate-500 dark:text-slate-400">Used</p>
            <p className="font-mono font-semibold">{formatBytes(disk.usedBytes)}</p>
          </div>
          <div className="flex-1">
            <p className="text-slate-500 dark:text-slate-400">Free</p>
            <p className="font-mono font-semibold">{formatBytes(disk.freeBytes)}</p>
          </div>
          <div className="flex-1">
            <p className="text-slate-500 dark:text-slate-400">Total</p>
            <p className="font-mono font-semibold">{formatBytes(disk.totalBytes)}</p>
          </div>
        </div>

        {expandDetail && (
          <div className="rounded-md bg-slate-50 p-2 dark:bg-slate-900">
            <p className="text-xs font-medium text-slate-600 dark:text-slate-300">Details:</p>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <dt className="text-slate-500 dark:text-slate-400">Mount point:</dt>
              <dd className="font-mono text-slate-700 dark:text-slate-300">{disk.mountPoint}</dd>
            </dl>
          </div>
        )}

        <button
          onClick={() => setExpandDetail(!expandDetail)}
          className="text-xs font-medium text-accent hover:text-accent/80"
        >
          {expandDetail ? 'Hide' : 'Show'} details
        </button>
      </div>
    </Card>
  );
}
