import { z } from 'zod';

/**
 * Monitoring page schema for frontend state and filtering.
 * Contains time range selection and chart display options.
 */

export const timeRangeSchema = z.enum(['1h', '24h', '7d', '30d', 'custom']);
export type TimeRange = z.infer<typeof timeRangeSchema>;

export const monitoringFiltersSchema = z.object({
  timeRange: timeRangeSchema.default('24h'),
  customFrom: z.number().int().optional(),
  customTo: z.number().int().optional(),
});

export type MonitoringFilters = z.infer<typeof monitoringFiltersSchema>;
