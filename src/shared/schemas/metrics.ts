import { z } from 'zod';
import { entityIdSchema, unixSecondsSchema } from './primitives';

/**
 * Metric identifiers. Dotted names, sampled on a fixed interval and rolled up hourly
 * after seven days (T45).
 */
export const METRIC_NAMES = [
  'sync.bytes_in',
  'sync.bytes_out',
  'sync.files_per_s',
  'sync.error_rate',
  'queue.depth',
  'locks.active',
  'disk.used_pct',
  'disk.free_bytes',
  'cpu.load',
  'cpu.temp',
  'mem.used_pct',
  'net.rx_bytes',
  'net.tx_bytes',
  'uptime.seconds',
] as const;

export const metricNameSchema = z.enum(METRIC_NAMES);
export type MetricName = z.infer<typeof metricNameSchema>;

export const metricSampleSchema = z.object({
  ts: unixSecondsSchema,
  value: z.number(),
});

/** One metric over a time range, optionally narrowed to a single share. */
export const metricSeriesSchema = z.object({
  metric: metricNameSchema,
  shareId: entityIdSchema.nullable(),
  /** `raw` below the retention cut-off, `hourly` above it. */
  resolution: z.enum(['raw', 'hourly']),
  samples: z.array(metricSampleSchema),
});

export type MetricSeries = z.infer<typeof metricSeriesSchema>;

export const metricsQuerySchema = z.object({
  metric: z
    .union([metricNameSchema, z.array(metricNameSchema)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  share: z.coerce.number().int().positive().optional(),
  since: z.coerce.number().int().nonnegative().optional(),
  until: z.coerce.number().int().nonnegative().optional(),
  resolution: z.enum(['raw', 'hourly']).optional(),
});

export type MetricsQuery = z.infer<typeof metricsQuerySchema>;

export const metricsResponseSchema = z.object({
  series: z.array(metricSeriesSchema),
});

// ---------------------------------------------------------------------------
// PRTG — HTTP Data Advanced
// ---------------------------------------------------------------------------

/**
 * PRTG's "HTTP Data Advanced" sensor shape. PRTG is strict about this structure and
 * about the limit fields being strings, so it is modelled exactly rather than
 * generated ad hoc (T46).
 */
export const prtgChannelSchema = z.object({
  channel: z.string(),
  value: z.union([z.string(), z.number()]),
  unit: z.string().optional(),
  customunit: z.string().optional(),
  float: z.union([z.literal(0), z.literal(1)]).optional(),
  mode: z.enum(['Absolute', 'Difference']).optional(),
  limitmaxwarning: z.string().optional(),
  limitmaxerror: z.string().optional(),
  limitminwarning: z.string().optional(),
  limitminerror: z.string().optional(),
  limitmode: z.union([z.literal(0), z.literal(1)]).optional(),
  limiterrormsg: z.string().optional(),
  limitwarningmsg: z.string().optional(),
});

export type PrtgChannel = z.infer<typeof prtgChannelSchema>;

/** Not wrapped in the standard envelope — PRTG requires this exact top-level shape. */
export const prtgResponseSchema = z.object({
  prtg: z.object({
    result: z.array(prtgChannelSchema),
    text: z.string().optional(),
    error: z.union([z.literal(0), z.literal(1)]).optional(),
  }),
});

export type PrtgResponse = z.infer<typeof prtgResponseSchema>;
