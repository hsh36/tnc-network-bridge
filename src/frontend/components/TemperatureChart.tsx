import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { type MetricSeries } from '../../shared';
import { Card, CardHeader } from './ui/Card';
import { Spinner } from './ui/Spinner';
import { formatTimestamp } from '../hooks/useMetrics';

export interface TemperatureChartProps {
  readonly series: MetricSeries | undefined;
  readonly loading?: boolean;
}

export function TemperatureChart({ series, loading = false }: TemperatureChartProps): JSX.Element {
  const data =
    series?.samples
      .map((sample) => ({
        timestamp: sample.ts,
        temp: sample.value,
      }))
      .sort((a, b) => a.timestamp - b.timestamp) ?? [];

  // Find current temperature for status badge
  const lastData = data.length > 0 ? data[data.length - 1] : undefined;
  const currentTemp = lastData?.temp ?? null;

  let tempColor = '#22c55e';
  if (currentTemp !== null && typeof currentTemp === 'number') {
    if (currentTemp > 80) {
      tempColor = '#ef4444';
    } else if (currentTemp > 60) {
      tempColor = '#f59e0b';
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader title="Temperature" subtitle="SoC temperature (Raspberry Pi)" />
        <div className="flex h-72 items-center justify-center">
          <Spinner />
        </div>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader title="Temperature" subtitle="SoC temperature (Raspberry Pi)" />
        <div className="flex h-72 items-center justify-center text-sm text-slate-500">
          No data available
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Temperature"
        subtitle={
          currentTemp !== null
            ? `Currently ${currentTemp.toFixed(1)}°C`
            : 'SoC temperature (Raspberry Pi)'
        }
      />
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
              domain={[20, 100]}
              label={{ value: '°C', angle: -90, position: 'insideLeft' }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '4px',
              }}
              formatter={(value: unknown) => `${(value as number).toFixed(1)}°C`}
              labelFormatter={(label: unknown) => formatTimestamp(label as number)}
            />
            <ReferenceLine
              y={60}
              stroke="#f59e0b"
              strokeDasharray="5 5"
              label={{ value: 'Warn (60°C)', position: 'right', fill: '#f59e0b', fontSize: 11 }}
            />
            <ReferenceLine
              y={80}
              stroke="#ef4444"
              strokeDasharray="5 5"
              label={{ value: 'Critical (80°C)', position: 'right', fill: '#ef4444', fontSize: 11 }}
            />
            <Line
              type="monotone"
              dataKey="temp"
              stroke={tempColor}
              dot={false}
              strokeWidth={2}
              name="Temperature"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center gap-2 border-t border-border px-4 py-3 dark:border-border-dark">
        <div className="flex items-center gap-1">
          <div className="h-3 w-3 rounded-full" style={{ backgroundColor: '#22c55e' }} />
          <span className="text-xs text-slate-600 dark:text-slate-300">Good (&lt; 60°C)</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-3 rounded-full" style={{ backgroundColor: '#f59e0b' }} />
          <span className="text-xs text-slate-600 dark:text-slate-300">Warm (60-80°C)</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="h-3 w-3 rounded-full" style={{ backgroundColor: '#ef4444' }} />
          <span className="text-xs text-slate-600 dark:text-slate-300">Hot (&gt; 80°C)</span>
        </div>
      </div>
    </Card>
  );
}
