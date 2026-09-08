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
import { formatTimestamp } from '../hooks/useMetrics';

export interface CPUMemChartProps {
  readonly seriesCpu: MetricSeries | undefined;
  readonly seriesMem: MetricSeries | undefined;
  readonly loading?: boolean;
}

export function CPUMemChart({
  seriesCpu,
  seriesMem,
  loading = false,
}: CPUMemChartProps): JSX.Element {
  const data = mergeMetricSeries(seriesCpu, seriesMem);

  if (loading) {
    return (
      <Card>
        <CardHeader title="CPU & Memory" subtitle="System resource usage" />
        <div className="flex h-72 items-center justify-center">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader title="CPU & Memory" subtitle="System resource usage" />
        <div className="flex h-72 items-center justify-center text-sm text-slate-500">
          No data available
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="CPU & Memory" subtitle="System resource usage" />
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
              yAxisId="left"
              tick={{ fontSize: 12 }}
              domain={[0, 100]}
              label={{ value: 'CPU %', angle: -90, position: 'insideLeft' }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 12 }}
              domain={[0, 100]}
              label={{ value: 'Memory %', angle: 90, position: 'insideRight' }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '4px',
              }}
              formatter={(value: unknown) => `${(value as number).toFixed(1)}%`}
              labelFormatter={(label) => formatTimestamp(label)}
            />
            <Legend />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="cpu"
              stroke="#f97316"
              dot={false}
              strokeWidth={2}
              name="CPU Load %"
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="memory"
              stroke="#a855f7"
              dot={false}
              strokeWidth={2}
              name="Memory %"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function mergeMetricSeries(
  seriesCpu: MetricSeries | undefined,
  seriesMem: MetricSeries | undefined,
): Array<{ timestamp: number; cpu: number; memory: number }> {
  const map = new Map<number, { timestamp: number; cpu: number; memory: number }>();

  if (seriesCpu) {
    for (const sample of seriesCpu.samples) {
      const key = sample.ts;
      if (!map.has(key)) {
        map.set(key, { timestamp: key, cpu: 0, memory: 0 });
      }
      const entry = map.get(key)!;
      entry.cpu = Math.min(sample.value, 100); // Clamp to 100%
    }
  }

  if (seriesMem) {
    for (const sample of seriesMem.samples) {
      const key = sample.ts;
      if (!map.has(key)) {
        map.set(key, { timestamp: key, cpu: 0, memory: 0 });
      }
      const entry = map.get(key)!;
      entry.memory = Math.min(sample.value, 100); // Clamp to 100%
    }
  }

  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}
