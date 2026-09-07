import { z } from 'zod';
import { LOCK_ORIGINS, SERVER_LOCK_KINDS } from '../constants';
import {
  entityIdSchema,
  ipAddressSchema,
  paginationQuerySchema,
  relPathSchema,
  unixSecondsSchema,
} from './primitives';

/** What caused the lock to be taken (T24). */
export const lockOriginSchema = z.enum(LOCK_ORIGINS);
export type LockOrigin = z.infer<typeof lockOriginSchema>;

/** How the lock is mirrored onto the server share so other clients can see it (T26). */
export const serverLockKindSchema = z.enum(SERVER_LOCK_KINDS);
export type ServerLockKind = z.infer<typeof serverLockKindSchema>;

export const lockSchema = z.object({
  id: entityIdSchema,
  shareId: entityIdSchema,
  relPath: relPathSchema,
  origin: lockOriginSchema,
  /** Human-facing owner, e.g. "TNC-640-Halle2". */
  ownerLabel: z.string().nullable(),
  tncIp: ipAddressSchema.nullable(),
  smbPid: z.number().int().nonnegative().nullable(),
  smbSessionId: z.string().nullable(),
  serverLockKind: serverLockKindSchema,
  /** False when projection onto the server failed — a warning, never a sync blocker. */
  serverLockOk: z.boolean(),
  serverLockError: z.string().nullable(),
  acquiredAt: unixSecondsSchema,
  /** `null` means the lock is held until explicitly released. */
  expiresAt: unixSecondsSchema.nullable(),
  releasedAt: unixSecondsSchema.nullable(),
  note: z.string().nullable(),
});

export type Lock = z.infer<typeof lockSchema>;

/**
 * Manual lock creation. Origin is fixed to `manual` by the backend — a client cannot
 * claim to be a TNC or the scheduler, because that would change the precedence rules.
 */
export const createLockRequestSchema = z
  .object({
    shareId: entityIdSchema,
    relPath: relPathSchema,
    ttlSeconds: z.number().int().min(30).max(86_400).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export type CreateLockRequest = z.infer<typeof createLockRequestSchema>;

export const listLocksQuerySchema = paginationQuerySchema.extend({
  share: z.coerce.number().int().positive().optional(),
  origin: lockOriginSchema.optional(),
  /** Include locks that have already been released. Defaults to active locks only. */
  includeReleased: z.coerce.boolean().default(false),
});

export type ListLocksQuery = z.infer<typeof listLocksQuerySchema>;

/** Force-releasing another party's lock is audited, so it carries a reason. */
export const releaseLockQuerySchema = z.object({
  reason: z.string().max(500).optional(),
});
