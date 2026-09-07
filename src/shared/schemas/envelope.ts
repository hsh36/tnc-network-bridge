import { z } from 'zod';

/**
 * The uniform API envelope (IMPLEMENTATION_PLAN §5).
 *
 * Every response — success or failure — is one of these two shapes, so the frontend
 * has exactly one branch to write and errors can never be mistaken for data.
 */

/**
 * Machine-readable error codes.
 *
 * The frontend switches on these; `message` is for humans and may be reworded freely.
 * Codes are append-only: removing or repurposing one is a breaking API change.
 */
export const API_ERROR_CODES = [
  // Request-shaped failures
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',

  // Authentication and authorisation
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'SESSION_EXPIRED',
  'CSRF_INVALID',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'RATE_LIMITED',

  // Domain failures
  'SHARE_NOT_MOUNTED',
  'SERVER_UNREACHABLE',
  'READ_ONLY_MODE',
  'PATH_LOCKED',
  'PATH_TRAVERSAL',
  'FILE_TOO_LARGE',
  'INSUFFICIENT_DISK_SPACE',
  'SMB_AUTH_FAILED',
  'SMB_SHARE_NOT_FOUND',
  'CERTIFICATE_INVALID',
  'UPDATE_IN_PROGRESS',
  'SETUP_ALREADY_COMPLETED',
  'SETUP_REQUIRED',

  // Infrastructure
  'PRIVILEGED_HELPER_FAILED',
  'DATABASE_ERROR',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/**
 * Field-level detail for validation failures, keyed by dotted path into the request body.
 * Populated from the Zod issue list by the API middleware (T29).
 */
export const fieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

export const apiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: apiErrorCodeSchema,
    /** Human-readable, safe to display. Never contains a stack trace or internal path. */
    message: z.string(),
    details: z.array(fieldErrorSchema).optional(),
    /** Correlates this response with the server log line that produced it (T6). */
    requestId: z.string().optional(),
    /** Present on RATE_LIMITED and SERVICE_UNAVAILABLE. */
    retryAfterSeconds: z.number().int().positive().optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** Wraps a payload schema in the success envelope. */
export const apiSuccess = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ ok: z.literal(true), data });

/** Wraps a payload schema in the full success-or-error union. */
export const apiEnvelope = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('ok', [apiSuccess(data), apiErrorSchema]);

/** Response body for endpoints whose only meaningful answer is "it worked". */
export const acknowledgedSchema = z.object({
  acknowledged: z.literal(true),
});

/** Response body for actions that start background work the client can then follow. */
export const acceptedSchema = z.object({
  accepted: z.literal(true),
  /** Correlate with SSE progress events on `/events/stream`. */
  operationId: z.string(),
});
