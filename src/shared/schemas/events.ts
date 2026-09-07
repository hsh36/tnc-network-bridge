import { z } from 'zod';
import { conflictSchema } from './conflict';
import { logEntrySchema, syncEventSchema } from './log';
import { lockSchema } from './lock';
import { updateStatusSchema } from './operations';
import { shareRuntimeSchema, shareStatusSchema } from './share';
import { statusSchema } from './system';
import { entityIdSchema, relPathSchema, unixMillisSchema } from './primitives';

/**
 * Typed events delivered over SSE on `/events/stream` and `/logs/stream` (T31).
 *
 * The dashboard is driven entirely by these — it never polls. Every variant carries
 * `ts` so a client can detect gaps, and the union is discriminated on `type` so the
 * frontend gets exhaustiveness checking for free.
 */

const base = { ts: unixMillisSchema };

export const heartbeatEventSchema = z.object({
  ...base,
  type: z.literal('heartbeat'),
});

export const statusEventSchema = z.object({
  ...base,
  type: z.literal('status'),
  status: statusSchema,
});

export const shareStateEventSchema = z.object({
  ...base,
  type: z.literal('share.state'),
  share: shareRuntimeSchema,
  previousStatus: shareStatusSchema,
});

export const syncProgressEventSchema = z.object({
  ...base,
  type: z.literal('sync.progress'),
  shareId: entityIdSchema,
  relPath: relPathSchema,
  direction: z.enum(['pull', 'push']),
  bytesTransferred: z.number().int().nonnegative(),
  bytesTotal: z.number().int().nonnegative(),
});

export const syncEventEventSchema = z.object({
  ...base,
  type: z.literal('sync.event'),
  event: syncEventSchema,
});

export const lockEventSchema = z.object({
  ...base,
  type: z.literal('lock'),
  action: z.enum(['acquired', 'released', 'expired', 'force_released']),
  lock: lockSchema,
});

export const conflictEventSchema = z.object({
  ...base,
  type: z.literal('conflict'),
  conflict: conflictSchema,
});

export const logEventSchema = z.object({
  ...base,
  type: z.literal('log'),
  entry: logEntrySchema,
});

export const updateEventSchema = z.object({
  ...base,
  type: z.literal('update'),
  status: updateStatusSchema,
});

/** Emitted when the failover controller flips a share in or out of read-only (T23). */
export const failoverEventSchema = z.object({
  ...base,
  type: z.literal('failover'),
  shareId: entityIdSchema,
  readOnly: z.boolean(),
  reason: z.string(),
});

export const bridgeEventSchema = z.discriminatedUnion('type', [
  heartbeatEventSchema,
  statusEventSchema,
  shareStateEventSchema,
  syncProgressEventSchema,
  syncEventEventSchema,
  lockEventSchema,
  conflictEventSchema,
  logEventSchema,
  updateEventSchema,
  failoverEventSchema,
]);

export type BridgeEvent = z.infer<typeof bridgeEventSchema>;
export type BridgeEventType = BridgeEvent['type'];

export const BRIDGE_EVENT_TYPES = [
  'heartbeat',
  'status',
  'share.state',
  'sync.progress',
  'sync.event',
  'lock',
  'conflict',
  'log',
  'update',
  'failover',
] as const;

const csvList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.split(',').filter((v) => v.length > 0))
    .pipe(z.array(z.enum(values)));

/** Per-client filtering, so a log viewer does not also receive every sync progress tick. */
export const eventStreamQuerySchema = z.object({
  types: csvList(BRIDGE_EVENT_TYPES).optional(),
  share: z.coerce.number().int().positive().optional(),
  /**
   * Last event id the client saw. The server replays what it still holds, so a
   * reconnect resumes without a gap.
   */
  lastEventId: z.string().max(64).optional(),
});

export type EventStreamQuery = z.infer<typeof eventStreamQuerySchema>;
