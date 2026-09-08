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

export interface ErrorRateChartProps {
  readonly series: MetricSeries | undefined;
  readonly loading?: boolean;
}

export function ErrorRateChart({ series, loading = false }: ErrorRateChartProps): JSX.Element {
  const data =
    series?.samples
      .map((sample) => ({
        timestamp: sample.ts,
        rate: sample.value,
      }))
      .sort((a, b) => a.timestamp - b.timestamp) ?? [];

  if (loading) {
    return (
      <Card>
        <CardHeader title="Error Rate" subtitle="Errors per minute" />
        <div className="flex h-72 items-center justify-center">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader title="Error Rate" subtitle="Errors per minute" />
        <div className="flex h-72 items-center justify-center text-sm text-slate-500">
          No data available
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Error Rate" subtitle="Errors per minute" />
      <div className="p-4">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
            <XAxis
              dataKey="timestamp"
              tick={{ fontSize: 12 }}
              tickFormatter={(ts: unknown) => formatTimestamp(ts as number)}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              label={{ value: 'Errors/min', angle: -90, position: 'insideLeft' }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '4px',
              }}
              formatter={(value: unknown) => [(value as number).toFixed(2), 'Errors/min']}
              labelFormatter={(label: unknown) => formatTimestamp(label as number)}
            />
            <Line
              type="monotone"
              dataKey="rate"
              stroke="#ef4444"
              dot={false}
              strokeWidth={2}
              name="Error Rate"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
