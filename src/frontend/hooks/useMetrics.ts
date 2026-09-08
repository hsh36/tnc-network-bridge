import { useCallback, useEffect, useMemo, useState } from 'react';
import { type MetricSeries, type MetricsQuery } from '../../shared';
import { api, ApiError } from '../lib/api-client';

export interface MetricsState {
  readonly series: MetricSeries[];
  readonly error: ApiError | undefined;
  readonly loading: boolean;
  readonly refresh: () => void;
}

/**
 * Hook to fetch metrics data for the monitoring dashboard.
 * Handles time range conversion and data caching with a 30-second TTL.
 *
 * @param metric - Single metric name or array of metric names to fetch
 * @param since - Start time in seconds (Unix timestamp), defaults to now - 3600 (1 hour ago)
 * @param until - End time in seconds (Unix timestamp), defaults to now
 * @param deps - Dependency array to trigger refetch when these values change
 */
export function useMetrics(
  metric: string | string[] | undefined,
  options: {
    readonly since?: number;
    readonly until?: number;
    readonly deps?: readonly unknown[];
    readonly enabled?: boolean;
  } = {},
): MetricsState {
  const { since, until, deps = [], enabled = true } = options;
  const [series, setSeries] = useState<MetricSeries[]>([]);
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Build the query parameters
  const query = useMemo<MetricsQuery>(() => {
    const q: MetricsQuery = {};
    if (metric !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-explicit-any
      q.metric = (Array.isArray(metric) ? metric : [metric]) as any;
    }
    if (since !== undefined) {
      q.since = since;
    }
    if (until !== undefined) {
      q.until = until;
    }
    return q;
  }, [metric, since, until]);

  useEffect(() => {
    if (!enabled || metric === undefined) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    api('metrics.get', { query })
      .then((result) => {
        if (!cancelled) {
          setSeries(result.series);
          setError(undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled && err instanceof ApiError) {
          setError(err);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, query, metric, tick, ...deps]);

  return { series, error, loading, refresh };
}

/**
 * Convert a time range string to Unix timestamps (seconds).
 * Returns { since, until } where until is now and since is calculated from range.
 */
export function getTimeRangeSeconds(
  range: '1h' | '24h' | '7d' | '30d',
  now?: number,
): { since: number; until: number } {
  const until = Math.floor((now ?? Date.now()) / 1000);
  let since: number;

  switch (range) {
    case '1h':
      since = until - 3600;
      break;
    case '24h':
      since = until - 86400;
      break;
    case '7d':
      since = until - 604800;
      break;
    case '30d':
      since = until - 2592000;
      break;
  }

  return { since, until };
}

/**
 * Format a Unix timestamp (seconds) to a readable string for display.
 */
export function formatTimestamp(ts: number, format: 'short' | 'long' = 'short'): string {
  const date = new Date(ts * 1000);
  if (format === 'short') {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return date.toLocaleString();
}

/**
 * Format bytes to human-readable format (B, KB, MB, GB, TB).
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(dm)} ${sizes[i]}`;
}

/**
 * Format bytes per second to throughput (MB/s, KB/s, etc.).
 */
export function formatThroughput(bytesPerSec: number, decimals = 1): string {
  return `${formatBytes(bytesPerSec, decimals)}/s`;
}
