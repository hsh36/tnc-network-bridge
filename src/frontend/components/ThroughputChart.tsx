import {
  CartesianGrid,
  Legend,
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
import { formatBytes, formatTimestamp } from '../hooks/useMetrics';

export interface ThroughputChartProps {
  readonly seriesIn: MetricSeries | undefined;
  readonly seriesOut: MetricSeries | undefined;
  readonly loading?: boolean;
}

export function ThroughputChart({
  seriesIn,
  seriesOut,
  loading = false,
}: ThroughputChartProps): JSX.Element {
  // Merge both series by timestamp
  const data = mergeMetricSeries(seriesIn, seriesOut);

  if (loading) {
    return (
      <Card>
        <CardHeader title="Throughput" subtitle="Server ↔ TNC sync speed" />
        <div className="flex h-72 items-center justify-center">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader title="Throughput" subtitle="Server ↔ TNC sync speed" />
        <div className="flex h-72 items-center justify-center text-sm text-slate-500">
          No data available
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Throughput" subtitle="Server ↔ TNC sync speed" />
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
              label={{ value: 'Bytes/sec', angle: -90, position: 'insideLeft' }}
              tickFormatter={(v: unknown) => formatBytes(v as number, 0)}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '4px',
              }}
              formatter={(value: unknown) => [formatBytes(value as number, 2), '']}
              labelFormatter={(label: unknown) => formatTimestamp(label as number)}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="throughput_in"
              stroke="#3b82f6"
              dot={false}
              name="In (Server→TNC)"
              strokeWidth={2}
            />
            <Line
              type="monotone"
              dataKey="throughput_out"
              stroke="#22c55e"
              dot={false}
              name="Out (TNC→Server)"
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function mergeMetricSeries(
  seriesIn: MetricSeries | undefined,
  seriesOut: MetricSeries | undefined,
): { timestamp: number; throughput_in: number; throughput_out: number }[] {
  const map = new Map<
    number,
    { timestamp: number; throughput_in: number; throughput_out: number }
  >();

  if (seriesIn) {
    for (const sample of seriesIn.samples) {
      const key = sample.ts;
      if (!map.has(key)) {
        map.set(key, { timestamp: key, throughput_in: 0, throughput_out: 0 });
      }
      const entry = map.get(key)!;
      entry.throughput_in = sample.value;
    }
  }

  if (seriesOut) {
    for (const sample of seriesOut.samples) {
      const key = sample.ts;
      if (!map.has(key)) {
        map.set(key, { timestamp: key, throughput_in: 0, throughput_out: 0 });
      }
      const entry = map.get(key)!;
      entry.throughput_out = sample.value;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}
