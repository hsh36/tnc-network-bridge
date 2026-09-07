import { z } from 'zod';
import {
  entityIdSchema,
  paginationQuerySchema,
  relPathSchema,
  sha256Schema,
  unixMillisSchema,
  unixSecondsSchema,
} from './primitives';

/**
 * Why this version was captured. Every one of these corresponds to a point where
 * content was about to be overwritten or lost (IMPLEMENTATION_PLAN §4).
 */
export const versionOriginSchema = z.enum([
  'server',
  'tnc',
  'restore',
  'initial',
  'conflict_loser',
]);
export type VersionOrigin = z.infer<typeof versionOriginSchema>;

export const fileVersionSchema = z.object({
  id: entityIdSchema,
  shareId: entityIdSchema,
  relPath: relPathSchema,
  /** sha256 of the content, and the blob's address in the store. */
  hash: sha256Schema,
  size: z.number().int().nonnegative(),
  mtime: unixMillisSchema,
  origin: versionOriginSchema,
  reason: z.string().nullable(),
  createdAt: unixSecondsSchema,
  /** Pinned versions are exempt from retention pruning (T39). */
  pinned: z.boolean(),
});

export type FileVersion = z.infer<typeof fileVersionSchema>;

export const listVersionsQuerySchema = paginationQuerySchema.extend({
  share: z.coerce.number().int().positive().optional(),
  path: relPathSchema.optional(),
});

export type ListVersionsQuery = z.infer<typeof listVersionsQuerySchema>;

/**
 * A restore writes the blob into the local cache as an ordinary local change, so the
 * normal sync path propagates it. The pre-restore content is captured first, which is
 * what makes a restore itself reversible (T40).
 */
export const restoreVersionRequestSchema = z
  .object({
    /** Restore somewhere else instead of over the original path. */
    targetPath: relPathSchema.optional(),
  })
  .strict();

export type RestoreVersionRequest = z.infer<typeof restoreVersionRequestSchema>;

export const pinVersionRequestSchema = z.object({ pinned: z.boolean() }).strict();

export const restoreVersionResponseSchema = z.object({
  restoredTo: relPathSchema,
  /** The version capturing the content that the restore replaced. */
  preRestoreVersionId: entityIdSchema,
});
