import { useCallback, useEffect, useState } from 'react';
import { type Conflict } from '../../shared';
import { api, ApiError } from '../lib/api-client';
import { useSSE } from './useSSE';

export interface ConflictsState {
  readonly unresolved: readonly Conflict[];
  readonly resolved: readonly Conflict[];
  readonly loading: boolean;
  readonly error: ApiError | undefined;
  readonly refresh: () => Promise<void>;
}

/**
 * Manages conflict lists: unresolved and resolved conflicts with real-time SSE updates.
 * Updates whenever a conflict event occurs via SSE.
 */
export function useConflicts(): ConflictsState {
  const [unresolved, setUnresolved] = useState<Conflict[]>([]);
  const [resolved, setResolved] = useState<Conflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError>();

  // Subscribe to conflict events via SSE
  const sse = useSSE({ types: ['conflict'] });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      // Fetch unresolved conflicts
      const unresolvedConflicts = await api('conflicts.list', {
        query: { acknowledged: false, limit: 500 },
      });

      // Fetch resolved conflicts
      const resolvedConflicts = await api('conflicts.list', {
        query: { acknowledged: true, limit: 500 },
      });

      setUnresolved(unresolvedConflicts.items);
      setResolved(resolvedConflicts.items);
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

  // Refresh when conflict events occur via SSE
  useEffect(() => {
    if (sse.latest !== undefined && sse.latest.type === 'conflict') {
      void refresh();
    }
  }, [sse.latest, refresh]);

  return {
    unresolved,
    resolved,
    loading,
    error,
    refresh,
  };
}
