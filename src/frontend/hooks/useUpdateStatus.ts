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

  /*
   * The poll is the source of truth; SSE only says "ask again now".
   *
   * This used to be `sseStatus ?? status.data`, which assumes the stream is at least as
   * fresh as the poll. During an update that is exactly false: applying restarts the
   * service, so the connection drops — and the last event the browser received before
   * it dropped was the `downloading` one that `apply()` published. Nothing republished
   * afterwards, so that event sat in `sse.latest` forever and shadowed a polled status
   * that had long since said `done`. The screen showed "downloading" and a progress bar
   * stuck at zero, on an update that had finished minutes earlier.
   *
   * Making the poll authoritative removes the whole class: there is one answer, and a
   * dropped stream can no longer contradict it. Liveness is kept by refreshing on each
   * event instead of rendering it.
   */
  const latestSSEEvent = sse.latest;
  const refresh = status.refresh;
  useEffect(() => {
    if (latestSSEEvent?.type === 'update') {
      refresh();
    }
  }, [latestSSEEvent, refresh]);

  const mergedStatus = status.data;

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
