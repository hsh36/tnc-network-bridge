import { useApiQuery } from './useApi';
import { type FileIndexEntry } from '../../shared';

export interface FileIndexState {
  readonly items: readonly FileIndexEntry[];
  readonly total: number;
  readonly loading: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
}

/**
 * Hook for fetching and managing file index state.
 *
 * Handles pagination, filtering, and caching of file listings.
 */
export function useFileIndex(options: {
  readonly shareId: number;
  readonly path?: string;
  readonly state?: string;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly enabled?: boolean;
}): FileIndexState {
  const { shareId, path, state, search, limit = 1000, offset = 0, enabled = true } = options;

  const query = useApiQuery(
    'files.list',
    {
      query: {
        share: shareId,
        ...(path ? { path } : {}),
        ...(state && state !== 'all'
          ? {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-explicit-any
              state: state as any,
            }
          : {}),
        ...(search ? { q: search } : {}),
        limit,
        offset,
      },
    },
    {
      deps: [shareId, path, state, search, limit, offset],
      enabled,
    },
  );

  return {
    items: query.data?.items ?? [],
    total: query.data?.total ?? 0,
    loading: query.loading,
    error: query.error,
    refresh: query.refresh,
  };
}
