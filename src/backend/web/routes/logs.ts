import { Router } from 'express';
import { type SqlValue } from '../../config/db';
import { listLogsQuerySchema, type LogEntry } from '../../../shared';
import { type AppContext } from '../context';
import { ok, requireSessionOrToken } from '../middleware';

interface LogRow {
  id: number;
  ts: number;
  level: string;
  source: string;
  message: string;
  request_id: string | null;
  share_id: number | null;
  context: string | null;
}

function toLogEntry(row: LogRow): LogEntry {
  return {
    id: row.id,
    ts: row.ts,
    level: row.level as LogEntry['level'],
    source: row.source as LogEntry['source'],
    message: row.message,
    requestId: row.request_id,
    shareId: row.share_id,
    context: row.context === null ? null : (JSON.parse(row.context) as Record<string, unknown>),
  };
}

/** `/logs` (T30), reading the SQLite sink T6 writes. */
export function logsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/logs', requireSessionOrToken(ctx), (req, res) => {
    const query = listLogsQuerySchema.parse(req.query);
    const clauses: string[] = [];
    const params: Record<string, SqlValue> = { limit: query.limit, offset: query.offset };

    if (query.source !== undefined) {
      clauses.push('source = @source');
      params.source = query.source;
    }
    if (query.level !== undefined) {
      clauses.push('level = @level');
      params.level = query.level;
    }
    if (query.since !== undefined) {
      clauses.push('ts >= @since');
      params.since = query.since * 1000;
    }
    if (query.until !== undefined) {
      clauses.push('ts <= @until');
      params.until = query.until * 1000;
    }
    if (query.share !== undefined) {
      clauses.push('share_id = @share');
      params.share = query.share;
    }
    if (query.q !== undefined && query.q.length > 0) {
      clauses.push('message LIKE @q');
      params.q = `%${query.q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const total = ctx.db.pluck<number>(`SELECT count(*) FROM log_entries ${where}`, params) ?? 0;
    const rows = ctx.db.all<LogRow>(
      `SELECT * FROM log_entries ${where} ORDER BY ts DESC, id DESC LIMIT @limit OFFSET @offset`,
      params,
    );
    ok(res, {
      items: rows.map(toLogEntry),
      total,
      limit: query.limit,
      offset: query.offset,
    });
  });

  return router;
}
