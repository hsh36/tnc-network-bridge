import { z } from 'zod';
import { logLevelSchema } from './config';
import {
  entityIdSchema,
  ipAddressSchema,
  paginationQuerySchema,
  relPathSchema,
  unixMillisSchema,
  unixSecondsSchema,
} from './primitives';

/** Logical log streams, each written by one subsystem's child logger (T6). */
export const LOG_SOURCES = [
  'app',
  'sync',
  'smb',
  'lock',
  'auth',
  'audit',
  'update',
  'system',
] as const;

export const logSourceSchema = z.enum(LOG_SOURCES);
export type LogSource = z.infer<typeof logSourceSchema>;

/** A row from the SQLite log sink, as served to the UI log viewer. */
export const logEntrySchema = z.object({
  id: entityIdSchema,
  ts: unixMillisSchema,
  level: logLevelSchema,
  source: logSourceSchema,
  message: z.string(),
  /** Ties the entry to the API request or sync operation that produced it. */
  requestId: z.string().nullable(),
  shareId: entityIdSchema.nullable(),
  /** Structured fields, already redacted of secrets by the logger. */
  context: z.record(z.unknown()).nullable(),
});

export type LogEntry = z.infer<typeof logEntrySchema>;

export const listLogsQuerySchema = paginationQuerySchema.extend({
  source: logSourceSchema.optional(),
  level: logLevelSchema.optional(),
  /** Unix seconds; only entries at or after this instant are returned. */
  since: z.coerce.number().int().nonnegative().optional(),
  until: z.coerce.number().int().nonnegative().optional(),
  q: z.string().max(255).optional(),
  share: z.coerce.number().int().positive().optional(),
});

export type ListLogsQuery = z.infer<typeof listLogsQuerySchema>;

// ---------------------------------------------------------------------------
// Sync events — the per-file record of what the engine actually did
// ---------------------------------------------------------------------------

export const syncDirectionSchema = z.enum(['pull', 'push', 'none']);
export type SyncDirection = z.infer<typeof syncDirectionSchema>;

export const syncActionSchema = z.enum([
  'copy',
  'delete',
  'mkdir',
  'rename',
  'skip',
  'defer',
  'verify',
]);
export type SyncAction = z.infer<typeof syncActionSchema>;

export const syncResultSchema = z.enum(['ok', 'error', 'skipped', 'deferred']);
export type SyncResult = z.infer<typeof syncResultSchema>;

export const syncEventSchema = z.object({
  id: entityIdSchema,
  ts: unixSecondsSchema,
  shareId: entityIdSchema.nullable(),
  relPath: relPathSchema.nullable(),
  direction: syncDirectionSchema.nullable(),
  action: syncActionSchema,
  bytes: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  result: syncResultSchema,
  message: z.string().nullable(),
});

export type SyncEvent = z.infer<typeof syncEventSchema>;

// ---------------------------------------------------------------------------
// Audit log — every mutation and every privileged invocation
// ---------------------------------------------------------------------------

export const auditActorSchema = z.string().max(128).describe('admin | token:<name> | system');

export const auditEntrySchema = z.object({
  id: entityIdSchema,
  ts: unixSecondsSchema,
  actor: auditActorSchema,
  action: z.string(),
  target: z.string().nullable(),
  ip: ipAddressSchema.nullable(),
  result: z.string().nullable(),
  detail: z.string().nullable(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;
