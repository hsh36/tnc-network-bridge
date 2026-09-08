import { z } from 'zod';
import {
  cronSchema,
  entityIdSchema,
  globPatternSchema,
  paginationQuerySchema,
  unixSecondsSchema,
} from './primitives';

/** The job kinds the scheduler knows how to run (T41). */
export const SCHEDULE_KINDS = [
  'lock',
  'unlock',
  'update',
  'restart',
  'prune',
  'scan',
  'backup',
] as const;

export const scheduleKindSchema = z.enum(SCHEDULE_KINDS);
export type ScheduleKind = z.infer<typeof scheduleKindSchema>;

/** Job-specific parameters. Lock and unlock windows address files by glob (T42). */
export const scheduleTargetSchema = z
  .object({
    shareId: entityIdSchema.optional(),
    pathGlob: globPatternSchema.optional(),
    /** For `lock`: how long the window stays open. */
    durationMinutes: z.number().int().min(1).max(10_080).optional(),
  })
  .strict();

export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>;

export const scheduleSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  kind: scheduleKindSchema,
  cron: cronSchema,
  target: scheduleTargetSchema.nullable(),
  enabled: z.boolean(),
  lastRunAt: unixSecondsSchema.nullable(),
  nextRunAt: unixSecondsSchema.nullable(),
  lastResult: z.enum(['ok', 'error', 'skipped']).nullable(),
  lastError: z.string().nullable(),
});

export type Schedule = z.infer<typeof scheduleSchema>;

export const createScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(64),
    kind: scheduleKindSchema,
    cron: cronSchema,
    target: scheduleTargetSchema.nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((s, ctx) => {
    if ((s.kind === 'lock' || s.kind === 'unlock') && s.target?.pathGlob === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target', 'pathGlob'],
        message: 'Lock and unlock schedules must specify which paths they apply to',
      });
    }
  });

export type CreateScheduleRequest = z.infer<typeof createScheduleRequestSchema>;

export const updateScheduleRequestSchema = z
  .object({
    name: z.string().min(1).max(64),
    cron: cronSchema,
    target: scheduleTargetSchema.nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .strict();

export const listSchedulesQuerySchema = paginationQuerySchema.extend({
  kind: scheduleKindSchema.optional(),
  enabled: z.coerce.boolean().optional(),
});

/**
 * "When would this actually fire?" — answered before the expression is saved (T37).
 *
 * A five-field expression can be syntactically perfect and still never run (`0 0 30 2 *`)
 * or fire at an hour the operator did not intend. Showing the next few occurrences is
 * the only way to make that visible at the moment the mistake is being made.
 */
export const previewScheduleRequestSchema = z.object({ cron: cronSchema }).strict();

export const previewScheduleResponseSchema = z.object({
  cron: cronSchema,
  /** Unix seconds of the next occurrences, soonest first. */
  nextRuns: z.array(unixSecondsSchema),
});

export const runScheduleResponseSchema = z.object({
  accepted: z.literal(true),
  result: z.enum(['ok', 'error', 'skipped']),
});
