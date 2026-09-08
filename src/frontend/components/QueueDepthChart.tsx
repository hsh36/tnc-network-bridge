import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { type MetricSeries } from '../../shared';
import { Card, CardHeader } from './ui/Card';
import { Spinner } from './ui/Spinner';
import { formatTimestamp } from '../hooks/useMetrics';

export interface QueueDepthChartProps {
  readonly series: MetricSeries | undefined;
  readonly loading?: boolean;
}

export function QueueDepthChart({ series, loading = false }: QueueDepthChartProps): JSX.Element {
  const data =
    series?.samples
      .map((sample) => ({
        timestamp: sample.ts,
        depth: sample.value,
      }))
      .sort((a, b) => a.timestamp - b.timestamp) ?? [];

  if (loading) {
    return (
      <Card>
        <CardHeader title="Queue Depth" subtitle="Pending files waiting to sync" />
        <div className="flex h-72 items-center justify-center">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader title="Queue Depth" subtitle="Pending files waiting to sync" />
        <div className="flex h-72 items-center justify-center text-sm text-slate-500">
          No data available
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Queue Depth" subtitle="Pending files waiting to sync" />
      <div className="p-4">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
            <XAxis
              dataKey="timestamp"
              tick={{ fontSize: 12 }}
              tickFormatter={(ts) => formatTimestamp(ts)}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              label={{ value: 'Files', angle: -90, position: 'insideLeft' }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '4px',
              }}
              formatter={(value: unknown) => [Math.round(value as number), 'Files']}
              labelFormatter={(label) => formatTimestamp(label)}
            />
            <Line
              type="monotone"
              dataKey="depth"
              stroke="#f59e0b"
              dot={false}
              strokeWidth={2}
              name="Queue Depth"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
