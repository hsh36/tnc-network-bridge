import { Router } from 'express';
import { listFilesQuerySchema } from '../../../shared';
import { type SqlValue } from '../../config/db';
import { type AppContext } from '../context';
import { ok, requireSessionOrToken } from '../middleware';

/**
 * `/files` (T30) - File index browser.
 *
 * Browse the file_index table, filtered by share, directory path, state, or full-text search.
 * Results are paginated and sorted by path. Read-only, usable with a monitoring token.
 */
export function filesRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/files', requireSessionOrToken(ctx), (req, res) => {
    const query = listFilesQuerySchema.parse(req.query);

    // Build WHERE clauses
    const where: string[] = [];
    const params: Record<string, SqlValue> = {};

    if (query.share !== undefined) {
      where.push('share_id = @share_id');
      params.share_id = query.share;
    }

    if (query.state !== undefined) {
      where.push('state = @state');
      params.state = query.state;
    }

    // Path filter: match exact directory or files under that directory
    if (query.path !== undefined && query.path.length > 0) {
      // Path can be "/" (root) or "/PARTS" (directory) or "/PARTS/001.H" (file)
      const pathWithSlash = query.path.endsWith('/') ? query.path : `${query.path}/`;
      where.push(
        `(rel_path = @exact_path OR rel_path GLOB @prefix_glob OR rel_path = @path_no_slash)`,
      );
      params.exact_path = query.path;
      params.prefix_glob = `${pathWithSlash}*`;
      params.path_no_slash = query.path.replace(/\/$/, '');
    }

    // Free-text search on relative path (case-insensitive)
    if (query.q !== undefined && query.q.length > 0) {
      where.push(`rel_path_ci LIKE '%' || @search_term || '%'`);
      params.search_term = query.q.toLowerCase();
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // Count total
    const countRow = ctx.db.all<{ 'COUNT(*)': number }>(
      `SELECT COUNT(*) FROM file_index ${whereClause}`,
      params,
    );
    const total = countRow[0]?.['COUNT(*)'] ?? 0;

    // Fetch paginated results, sorted by path
    const items = ctx.db.all(
      `SELECT
        id, share_id, rel_path, is_dir,
        loc_size, loc_mtime, loc_hash,
        srv_size, srv_mtime, srv_hash,
        base_size, base_mtime, base_hash,
        state, last_sync_at, last_error, retry_count, next_retry_at
       FROM file_index
       ${whereClause}
       ORDER BY rel_path ASC
       LIMIT @limit OFFSET @offset`,
      { ...params, limit: query.limit, offset: query.offset },
    );

    // Transform rows to match the expected schema (convert nulls and SQL integers to booleans)
    interface FileIndexRow {
      id: number;
      share_id: string;
      rel_path: string;
      is_dir: 0 | 1;
      loc_size: number | null;
      loc_mtime: number | null;
      loc_hash: string | null;
      srv_size: number | null;
      srv_mtime: number | null;
      srv_hash: string | null;
      base_size: number | null;
      base_mtime: number | null;
      base_hash: string | null;
      state: string;
      last_sync_at: number | null;
      last_error: string | null;
      retry_count: number;
      next_retry_at: number | null;
    }
    const transformedItems = (items as FileIndexRow[]).map((row) => ({
      id: row.id,
      shareId: row.share_id,
      relPath: row.rel_path,
      isDir: row.is_dir === 1,
      local:
        row.loc_size !== null
          ? {
              size: row.loc_size,
              mtime: row.loc_mtime,
              hash: row.loc_hash,
            }
          : null,
      remote:
        row.srv_size !== null
          ? {
              size: row.srv_size,
              mtime: row.srv_mtime,
              hash: row.srv_hash,
            }
          : null,
      base:
        row.base_size !== null
          ? {
              size: row.base_size,
              mtime: row.base_mtime,
              hash: row.base_hash,
            }
          : null,
      state: row.state,
      lastSyncAt: row.last_sync_at,
      lastError: row.last_error,
      retryCount: row.retry_count,
      nextRetryAt: row.next_retry_at,
    }));

    ok(res, {
      items: transformedItems,
      total,
      limit: query.limit,
      offset: query.offset,
    });
  });

  return router;
}
