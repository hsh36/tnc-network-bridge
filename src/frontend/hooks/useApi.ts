import { useCallback, useEffect, useState } from 'react';
import { type EndpointId, type HasParams, type HasQuery, type PathParams, type RequestQuery, type ResponseData } from '../../shared';
import { api, ApiError } from '../lib/api-client';

export interface QueryState<T> {
  readonly data: T | undefined;
  readonly error: ApiError | undefined;
  readonly loading: boolean;
  readonly refresh: () => void;
}

// `object`, not `Record<string, never>`, in the "absent" branches — see the comment on
// `CallArgs` in `lib/api-client.ts` for why the latter breaks the intersection.
type QueryArgs<K extends EndpointId> = (HasParams<K> extends true ? { params: PathParams<K> } : object) &
  (HasQuery<K> extends true ? { query: RequestQuery<K> } : object);

/**
 * A small `GET`-endpoint query hook — no external data-fetching library, since one
 * request per panel with an optional poll interval is all any Phase 1 page needs.
 * `deps` lets a page re-run the query when its own filters change.
 */
export function useApiQuery<K extends EndpointId>(
  endpoint: K,
  args: QueryArgs<K>,
  options: { readonly pollMs?: number; readonly deps?: readonly unknown[]; readonly enabled?: boolean } = {},
): QueryState<ResponseData<K>> {
  const { pollMs, deps = [], enabled = true } = options;
  const [data, setData] = useState<ResponseData<K>>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    api(endpoint, args as never)
      .then((result) => {
        if (!cancelled) {
          setData(result);
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
    // `args` is intentionally excluded: callers pass a fresh object literal on every
    // render, and `deps` is exactly the caller-declared list of values that should
    // actually trigger a re-fetch.
  }, [endpoint, enabled, tick, ...deps]);

  useEffect(() => {
    if (pollMs === undefined || !enabled) {
      return;
    }
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [pollMs, enabled, refresh]);

  return { data, error, loading, refresh };
}
