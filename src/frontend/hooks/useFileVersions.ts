import { useApiQuery } from './useApi';
import { type FileVersion } from '../../shared';

export interface FileVersionsState {
  readonly items: readonly FileVersion[];
  readonly total: number;
  readonly loading: boolean;
  readonly error: unknown;
  readonly refresh: () => void;
}

/**
 * Hook for fetching and managing file version history state.
 *
 * Handles pagination and caching of version listings for a specific file.
 */
export function useFileVersions(
  options: {
    readonly shareId: number;
    readonly path: string;
    readonly limit?: number;
    readonly offset?: number;
    readonly enabled?: boolean;
  } = { shareId: 1, path: '' },
): FileVersionsState {
  const { shareId, path, limit = 50, offset = 0, enabled = true } = options;

  const query = useApiQuery(
    'versions.list',
    {
      query: {
        share: shareId,
        ...(path ? { path } : {}),
        limit,
        offset,
      },
    },
    {
      deps: [shareId, path, limit, offset],
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
