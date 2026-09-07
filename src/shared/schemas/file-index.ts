import { z } from 'zod';
import { FILE_STATES } from '../constants';
import {
  entityIdSchema,
  paginationQuerySchema,
  relPathOrRootSchema,
  relPathSchema,
  unixMillisSchema,
  unixSecondsSchema,
  xxhash64Schema,
} from './primitives';

/** Reconciliation state of one indexed path (T15/T18). */
export const fileStateSchema = z.enum(FILE_STATES);
export type FileState = z.infer<typeof fileStateSchema>;

/**
 * One side of the `(base, local, remote)` triple that the diff engine reasons over.
 *
 * `null` means "absent on this side" — which is a meaningful verdict input, not
 * missing data. A `size`/`mtime` pair is always known; `hash` is populated lazily
 * because hashing costs a full read (T16).
 */
export const fileSideSchema = z.object({
  size: z.number().int().nonnegative(),
  mtime: unixMillisSchema,
  hash: xxhash64Schema.nullable(),
});

export type FileSide = z.infer<typeof fileSideSchema>;

export const fileIndexEntrySchema = z.object({
  id: entityIdSchema,
  shareId: entityIdSchema,
  relPath: relPathSchema,
  isDir: z.boolean(),
  /** State of the local cache copy. */
  local: fileSideSchema.nullable(),
  /** State of the copy on the server share. */
  remote: fileSideSchema.nullable(),
  /** The last state both sides agreed on. The absence of this is what makes a change ambiguous. */
  base: fileSideSchema.nullable(),
  state: fileStateSchema,
  lastSyncAt: unixSecondsSchema.nullable(),
  lastError: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
  nextRetryAt: unixSecondsSchema.nullable(),
});

export type FileIndexEntry = z.infer<typeof fileIndexEntrySchema>;

export const listFilesQuerySchema = paginationQuerySchema.extend({
  share: z.coerce.number().int().positive().optional(),
  /** Directory prefix to list under; empty or absent means the share root. */
  path: relPathOrRootSchema.optional(),
  state: fileStateSchema.optional(),
  /** Free-text substring match against the relative path. */
  q: z.string().max(255).optional(),
});

export type ListFilesQuery = z.infer<typeof listFilesQuerySchema>;
