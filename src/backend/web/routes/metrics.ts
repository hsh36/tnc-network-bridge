import { Router } from 'express';
import {
  METRIC_NAMES,
  metricsQuerySchema,
  type MetricName,
  type MetricSeries,
} from '../../../shared';
import { buildPrtgResponse } from '../../monitoring/prtg';
import { type AppContext } from '../context';
import { ok, requireSessionOrToken } from '../middleware';

/**
 * `/metrics` in three shapes (T41): the dashboard's JSON series, the Prometheus text
 * exposition, and PRTG's sensor payload.
 *
 * All three are `session-or-token`, because a monitoring system holds a read-only API
 * key rather than a browser session — that is the entire reason API tokens exist.
 */

interface SampleRow {
  ts: number;
  metric: string;
  share_id: number;
  value: number;
}

export function metricsRoutes(ctx: AppContext): Router {
  const router = Router();

  /**
   * Time series for the dashboard.
   *
   * Defaults to the last hour: the common case is "what is happening now", and an
   * unbounded default would make the first request on a long-running install read the
   * entire table.
   */
  router.get('/metrics', requireSessionOrToken(ctx), (req, res) => {
    const query = metricsQuerySchema.parse(req.query);
    const now = Math.floor(ctx.now() / 1000);
    const since = query.since ?? now - 3600;
    const until = query.until ?? now;
    const wanted: readonly MetricName[] = query.metric ?? METRIC_NAMES;

    const conditions = ['ts >= @since', 'ts <= @until'];
    const params: Record<string, string | number> = { since, until };
    if (query.share !== undefined) {
      conditions.push('share_id = @share');
      params.share = query.share;
    }

    // `metric IN (...)` is built from METRIC_NAMES-validated values only — the Zod enum
    // has already proven every element is one of the known literals, so the interpolation
    // below cannot carry user input.
    const placeholders = wanted.map((_, i) => `@m${String(i)}`).join(', ');
    wanted.forEach((metric, i) => {
      params[`m${String(i)}`] = metric;
    });

    const rows = ctx.db.all<SampleRow>(
      `SELECT ts, metric, share_id, value
         FROM metrics_samples
        WHERE ${conditions.join(' AND ')} AND metric IN (${placeholders})
        ORDER BY ts ASC`,
      params,
    );

    // Group into one series per (metric, share).
    const grouped = new Map<string, MetricSeries>();
    for (const row of rows) {
      const key = `${row.metric}:${String(row.share_id)}`;
      let series = grouped.get(key);
      if (series === undefined) {
        series = {
          metric: row.metric as MetricName,
          shareId: row.share_id === 0 ? null : row.share_id,
          resolution: query.resolution ?? 'raw',
          samples: [],
        };
        grouped.set(key, series);
      }
      (series.samples as { ts: number; value: number }[]).push({ ts: row.ts, value: row.value });
    }

    ok(res, { series: [...grouped.values()] });
  });

  /**
   * Prometheus text exposition.
   *
   * The content type carries `version=0.0.4`, which is what tells a scraper it is reading
   * the text format rather than something it should try to sniff.
   */
  router.get('/metrics/prometheus', requireSessionOrToken(ctx), (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(ctx.metrics.registry.render());
  });

  /** PRTG HTTP Data Advanced. Deliberately unwrapped — PRTG parses the top level. */
  router.get('/metrics/prtg', requireSessionOrToken(ctx), (_req, res) => {
    const payload = buildPrtgResponse({
      metrics: ctx.metrics,
      diskWarnPct: ctx.config.get('monitoring').diskWarnPct,
    });
    res.status(200).json(payload);
  });

  return router;
}
