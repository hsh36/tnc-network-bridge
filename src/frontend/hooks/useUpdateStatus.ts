import { useCallback, useEffect, useState } from 'react';
import { type UpdateStatus, type UpdateHistoryEntry } from '../../shared';
import { useApiQuery } from './useApi';
import { useSSE } from './useSSE';
import { api, ApiError } from '../lib/api-client';

export interface UseUpdateStatusResult {
  readonly status: UpdateStatus | undefined;
  readonly history: UpdateHistoryEntry[];
  readonly loading: boolean;
  readonly error: ApiError | undefined;
  readonly checking: boolean;
  readonly checkError: string | undefined;
  readonly check: () => Promise<void>;
  readonly apply: (version?: string) => Promise<void>;
  readonly applyError: string | undefined;
  readonly applying: boolean;
  readonly rollback: () => Promise<void>;
  readonly rollbackError: string | undefined;
  readonly rolling: boolean;
  readonly refresh: () => void;
}

export function useUpdateStatus(): UseUpdateStatusResult {
  const status = useApiQuery('update.status', {}, { pollMs: 2000 });
  const history = useApiQuery('update.history', { query: { limit: 50, offset: 0 } });
  const sse = useSSE({ types: ['update'] });

  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string>();
  const [rolling, setRolling] = useState(false);
  const [rollbackError, setRollbackError] = useState<string>();

  // Extract the latest update status from SSE if available
  const latestSSEEvent = sse.latest;
  const sseStatus = latestSSEEvent?.type === 'update' ? latestSSEEvent.status : undefined;
  const mergedStatus = sseStatus ?? status.data;

  const check = useCallback(async () => {
    setChecking(true);
    setCheckError(undefined);
    try {
      await api('update.check', {});
      status.refresh();
    } catch (err) {
      setCheckError(err instanceof ApiError ? err.message : 'Failed to check for updates');
    } finally {
      setChecking(false);
    }
  }, [status]);

  const apply = useCallback(async (version?: string) => {
    setApplying(true);
    setApplyError(undefined);
    try {
      await api('update.apply', { body: { version } });
      // Don't refresh immediately; SSE will bring the status
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.message : 'Failed to apply update');
    } finally {
      setApplying(false);
    }
  }, []);

  const rollback = useCallback(async () => {
    setRolling(true);
    setRollbackError(undefined);
    try {
      await api('update.rollback', {});
      // Don't refresh immediately; SSE will bring the status
    } catch (err) {
      setRollbackError(err instanceof ApiError ? err.message : 'Failed to rollback');
    } finally {
      setRolling(false);
    }
  }, []);

  return {
    status: mergedStatus,
    history: history.data?.items ?? [],
    loading: status.loading || history.loading,
    error: status.error,
    checking,
    checkError,
    check,
    apply,
    applyError,
    applying,
    rollback,
    rollbackError,
    rolling,
    refresh: status.refresh,
  };
}
