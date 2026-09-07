import { z } from 'zod';
import { conflictModeSchema } from './config';
import {
  entityIdSchema,
  paginationQuerySchema,
  relPathSchema,
  unixMillisSchema,
  unixSecondsSchema,
  xxhash64Schema,
} from './primitives';

/** Which side of the reconciliation won. */
export const conflictWinnerSchema = z.enum(['local', 'remote']);
export type ConflictWinner = z.infer<typeof conflictWinnerSchema>;

export const conflictSchema = z.object({
  id: entityIdSchema,
  ts: unixSecondsSchema,
  shareId: entityIdSchema,
  relPath: relPathSchema,
  /** The conflict mode actually in force when this was decided. */
  modeApplied: conflictModeSchema,
  winner: conflictWinnerSchema,
  /**
   * The losing content, captured before it was overwritten. Never null in practice:
   * the diff engine's core invariant is that no verdict discards data without a
   * version capture (T18).
   */
  loserVersionId: entityIdSchema.nullable(),
  winnerHash: xxhash64Schema.nullable(),
  loserHash: xxhash64Schema.nullable(),
  localMtime: unixMillisSchema.nullable(),
  remoteMtime: unixMillisSchema.nullable(),
  acknowledged: z.boolean(),
  detail: z.string().nullable(),
});

export type Conflict = z.infer<typeof conflictSchema>;

export const listConflictsQuerySchema = paginationQuerySchema.extend({
  share: z.coerce.number().int().positive().optional(),
  acknowledged: z.coerce.boolean().optional(),
});

export type ListConflictsQuery = z.infer<typeof listConflictsQuerySchema>;

/**
 * Manual resolution after the fact: promote the losing side by restoring its captured
 * version through the normal sync path.
 */
export const resolveConflictRequestSchema = z
  .object({
    keep: conflictWinnerSchema,
  })
  .strict();

export type ResolveConflictRequest = z.infer<typeof resolveConflictRequestSchema>;
