import { z } from 'zod';
import { SHARE_STATUSES } from '../constants';
import { conflictModeSchema } from './config';
import {
  absolutePathSchema,
  entityIdSchema,
  globPatternSchema,
  secretWriteSchema,
  shareNameSchema,
  uncPathSchema,
  unixSecondsSchema,
} from './primitives';

/** Per-share lifecycle state owned by the sync orchestrator (T22). */
export const shareStatusSchema = z.enum(SHARE_STATUSES);
export type ShareStatus = z.infer<typeof shareStatusSchema>;

/** Dialect used for the LAN-side mount. */
export const smbVersionSchema = z.enum(['3.1.1', '3.0', '2.1']);
export type ShareSmbVersion = z.infer<typeof smbVersionSchema>;

/** A share exactly as stored in the `shares` table. */
export const shareSchema = z.object({
  id: entityIdSchema,
  name: shareNameSchema,
  enabled: z.boolean(),
  serverUnc: uncPathSchema,
  mountPoint: absolutePathSchema,
  cachePath: absolutePathSchema,
  smbDomain: z.string().nullable(),
  smbUser: z.string().nullable(),
  smbVersion: smbVersionSchema,
  smbSeal: z.boolean(),
  conflictMode: conflictModeSchema,
  excludePatterns: z.array(globPatternSchema),
  scanIntervalMs: z.number().int().positive(),
  bandwidthLimitKbps: z.number().int().positive().nullable(),
  maxFileSizeMb: z.number().int().positive(),
  /** Set by an operator. */
  readOnly: z.boolean(),
  /** Set by the failover controller when the server is unreachable (T23). Not operator-editable. */
  failoverReadOnly: z.boolean(),
  tncGuestOk: z.boolean(),
  status: shareStatusSchema,
  lastScanAt: unixSecondsSchema.nullable(),
  lastError: z.string().nullable(),
  createdAt: unixSecondsSchema,
  updatedAt: unixSecondsSchema,
});

export type Share = z.infer<typeof shareSchema>;

/**
 * Live state layered on top of the stored row for `/status` and the dashboard.
 * Never persisted — recomputed on every read.
 */
export const shareRuntimeSchema = shareSchema.extend({
  mounted: z.boolean(),
  serverReachable: z.boolean(),
  /** True when either the operator or the failover controller has imposed read-only. */
  effectiveReadOnly: z.boolean(),
  queueDepth: z.number().int().nonnegative(),
  filesIndexed: z.number().int().nonnegative(),
  filesPending: z.number().int().nonnegative(),
  filesConflicted: z.number().int().nonnegative(),
  activeLocks: z.number().int().nonnegative(),
  bytesInPerSec: z.number().nonnegative(),
  bytesOutPerSec: z.number().nonnegative(),
});

export type ShareRuntime = z.infer<typeof shareRuntimeSchema>;

/**
 * `mountPoint` and `cachePath` are derived from the name by the backend rather than
 * accepted from the client — letting a caller choose arbitrary filesystem roots would
 * hand it the mount and cache namespaces.
 */
export const createShareRequestSchema = z
  .object({
    name: shareNameSchema,
    serverUnc: uncPathSchema,
    enabled: z.boolean().default(true),
    smbDomain: z.string().max(255).nullable().default(null),
    smbUser: z.string().max(255).nullable().default(null),
    /** Omit to fall back to the global service account from the `smb` config section. */
    smbPassword: secretWriteSchema.optional(),
    smbVersion: smbVersionSchema.default('3.1.1'),
    smbSeal: z.boolean().default(true),
    conflictMode: conflictModeSchema.default('last_write_wins'),
    excludePatterns: z.array(globPatternSchema).max(200).default([]),
    scanIntervalMs: z.number().int().min(1000).max(600_000).default(15_000),
    bandwidthLimitKbps: z.number().int().positive().nullable().default(null),
    maxFileSizeMb: z.number().int().min(1).max(102_400).default(512),
    tncGuestOk: z.boolean().default(true),
  })
  .strict();

export type CreateShareRequest = z.infer<typeof createShareRequestSchema>;

/**
 * PATCH body. `name` is absent deliberately: it determines the mount point, the cache
 * path and the Samba section name, so renaming is a delete-and-recreate.
 * `failoverReadOnly` is absent because it belongs to the failover controller alone.
 */
export const updateShareRequestSchema = createShareRequestSchema
  .omit({ name: true })
  .extend({ readOnly: z.boolean() })
  .partial()
  .strict();

export type UpdateShareRequest = z.infer<typeof updateShareRequestSchema>;

export const SHARE_ACTIONS = ['scan', 'resync', 'pause', 'resume', 'mount', 'unmount'] as const;
export const shareActionSchema = z.enum(SHARE_ACTIONS);
export type ShareAction = z.infer<typeof shareActionSchema>;

export const shareIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });
