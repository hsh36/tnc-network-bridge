import { useCallback, useEffect, useState } from 'react';
import { type Lock } from '../../shared';
import { api, ApiError } from '../lib/api-client';
import { useSSE } from './useSSE';

export interface LocksState {
  readonly active: readonly Lock[];
  readonly history: readonly Lock[];
  readonly loading: boolean;
  readonly error: ApiError | undefined;
  readonly refresh: () => Promise<void>;
}

/**
 * Manages lock lists: active locks with real-time SSE updates and lock history.
 * Active locks are refreshed both on initial load and via SSE lock events.
 */
export function useLocks(): LocksState {
  const [active, setActive] = useState<Lock[]>([]);
  const [history, setHistory] = useState<Lock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError>();

  // Subscribe to lock events via SSE
  const sse = useSSE({ types: ['lock'] });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      // Fetch active locks (not released)
      const activeLocks = await api('locks.list', {
        query: { includeReleased: false, limit: 500 },
      });

      // Fetch released locks for history (last 500)
      const releasedLocks = await api('locks.list', {
        query: { includeReleased: true, limit: 500 },
      });

      setActive(activeLocks.items);
      // History is released locks, sorted newest first
      const historyLocks = releasedLocks.items.filter((l) => l.releasedAt !== null);
      setHistory(historyLocks);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Refresh when lock events occur via SSE
  useEffect(() => {
    if (sse.latest !== undefined && sse.latest.type === 'lock') {
      void refresh();
    }
  }, [sse.latest, refresh]);

  return {
    active,
    history,
    loading,
    error,
    refresh,
  };
}
