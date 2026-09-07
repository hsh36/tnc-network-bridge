import { z } from 'zod';
import { hostnameSchema, ipAddressSchema, secretWriteSchema, uncPathSchema } from './primitives';

/**
 * Structured results for the "Verbindung testen" buttons (T11).
 *
 * The point of these schemas is that a wrong password, a wrong share name and a
 * blocked port are distinguishable outcomes rather than one generic failure — that
 * distinction is the difference between a five-minute fix and an afternoon.
 */

/** Failure taxonomy mapped from smbclient/mount.cifs output. */
export const smbFailureKindSchema = z.enum([
  'auth_failed',
  'account_locked',
  'account_expired',
  'access_denied',
  'share_not_found',
  'host_unreachable',
  'port_blocked',
  'name_resolution_failed',
  'protocol_negotiation_failed',
  'clock_skew',
  'signing_required',
  'unknown',
]);

export type SmbFailureKind = z.infer<typeof smbFailureKindSchema>;

/** Operators on the shop floor are German-speaking; diagnostics ship in both languages. */
export const localisedMessageSchema = z.object({
  de: z.string(),
  en: z.string(),
});

export type LocalisedMessage = z.infer<typeof localisedMessageSchema>;

export const testSmbRequestSchema = z
  .object({
    /** Defaults to the configured service account when omitted. */
    unc: uncPathSchema,
    domain: z.string().max(255).optional(),
    username: z.string().max(255).optional(),
    password: secretWriteSchema.optional(),
    smbVersion: z.enum(['3.1.1', '3.0', '2.1']).optional(),
    seal: z.boolean().optional(),
  })
  .strict();

export type TestSmbRequest = z.infer<typeof testSmbRequestSchema>;

export const testSmbResponseSchema = z.object({
  success: z.boolean(),
  /** Populated on success. */
  dialect: z.string().nullable(),
  authMethod: z.string().nullable(),
  signing: z.boolean().nullable(),
  encryption: z.boolean().nullable(),
  shares: z.array(z.string()),
  freeBytes: z.number().nonnegative().nullable(),
  /** Whether the scripted write/read/delete probe succeeded, not just the listing. */
  writable: z.boolean().nullable(),
  durationMs: z.number().nonnegative(),
  /** Populated on failure. */
  failure: smbFailureKindSchema.nullable(),
  message: localisedMessageSchema,
  /** What the operator should do next, in both languages. */
  remediation: localisedMessageSchema.nullable(),
});

export type TestSmbResponse = z.infer<typeof testSmbResponseSchema>;

export const testAdRequestSchema = z
  .object({
    domain: z.string().min(1).max(255),
    username: z.string().min(1).max(255),
    password: secretWriteSchema,
  })
  .strict();

export const testAdResponseSchema = z.object({
  success: z.boolean(),
  /** Domain controllers discovered via DNS SRV records. */
  controllers: z.array(z.string()),
  /** Kerberos is intolerant of clock drift; this is the usual root cause. */
  clockSkewSeconds: z.number().nullable(),
  message: localisedMessageSchema,
  remediation: localisedMessageSchema.nullable(),
});

export const testNetworkRequestSchema = z
  .object({
    target: z.union([ipAddressSchema, hostnameSchema]),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

export const testNetworkResponseSchema = z.object({
  success: z.boolean(),
  resolvedAddresses: z.array(ipAddressSchema),
  /** Round-trip time in milliseconds, null when unreachable. */
  rttMs: z.number().nonnegative().nullable(),
  portOpen: z.boolean().nullable(),
  /** Which interface the route to the target leaves by — catches LAN/TNC mix-ups. */
  viaInterface: z.string().nullable(),
  message: localisedMessageSchema,
});
