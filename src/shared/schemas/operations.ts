import { z } from 'zod';
import { adminPasswordSchema } from './auth';
import { updateChannelSchema } from './config';
import {
  entityIdSchema,
  hostnameSchema,
  interfaceNameSchema,
  ipAddressSchema,
  paginationQuerySchema,
  portSchema,
  sha256Schema,
  unixSecondsSchema,
} from './primitives';

// ---------------------------------------------------------------------------
// Self-update (T43/T44)
// ---------------------------------------------------------------------------

/** Phases the updater passes through; also the shape of its SSE progress events. */
export const updatePhaseSchema = z.enum([
  'idle',
  'checking',
  'downloading',
  'verifying',
  'extracting',
  'installing',
  'migrating',
  'switching',
  'restarting',
  'health_gate',
  'rolling_back',
  'done',
  'failed',
]);

export type UpdatePhase = z.infer<typeof updatePhaseSchema>;

export const availableReleaseSchema = z.object({
  version: z.string(),
  channel: updateChannelSchema,
  publishedAt: unixSecondsSchema,
  /** Release body, rendered as the changelog in the UI. */
  notes: z.string(),
  assetUrl: z.string().url(),
  assetSize: z.number().int().nonnegative(),
  /**
   * Verified before anything is swapped; a mismatch aborts the update.
   *
   * Null when the release carries no published digest — GitHub computes none for the
   * source tarball it generates. Null is the honest value: inventing one by hashing
   * the download would make the verify step compare a value against itself and pass
   * unconditionally, which is worse than admitting there is nothing to check against.
   */
  sha256: sha256Schema.nullable(),
});

export const updateStatusSchema = z.object({
  currentVersion: z.string(),
  available: availableReleaseSchema.nullable(),
  phase: updatePhaseSchema,
  /** 0-100 within the current phase, when the phase can report progress. */
  progressPct: z.number().min(0).max(100).nullable(),
  lastCheckAt: unixSecondsSchema.nullable(),
  lastError: z.string().nullable(),
  /** The release the service would fall back to on a failed health gate. */
  rollbackVersion: z.string().nullable(),
});

export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const applyUpdateRequestSchema = z
  .object({
    /** Defaults to the latest release on the configured channel. */
    version: z.string().max(64).optional(),
  })
  .strict();

export const updateHistoryEntrySchema = z.object({
  id: entityIdSchema,
  ts: unixSecondsSchema,
  fromVersion: z.string().nullable(),
  toVersion: z.string().nullable(),
  channel: updateChannelSchema.nullable(),
  result: z.enum(['ok', 'failed', 'rolled_back']),
  log: z.string().nullable(),
});

export type UpdateHistoryEntry = z.infer<typeof updateHistoryEntrySchema>;

// ---------------------------------------------------------------------------
// TLS certificates (T27)
// ---------------------------------------------------------------------------

const pemBlock = (label: string) =>
  z
    .string()
    .min(1)
    .max(1_000_000)
    .refine(
      (s) => s.includes(`-----BEGIN ${label}-----`) && s.includes(`-----END ${label}-----`),
      `Expected a PEM-encoded ${label.toLowerCase()} block`,
    );

export const certificateInfoSchema = z.object({
  subject: z.string(),
  issuer: z.string(),
  serialNumber: z.string(),
  notBefore: unixSecondsSchema,
  notAfter: unixSecondsSchema,
  fingerprintSha256: z.string(),
  subjectAltNames: z.array(z.string()),
  selfSigned: z.boolean(),
  keyType: z.string(),
  keyBits: z.number().int().positive().nullable(),
  /** Convenience for the UI banner; derived from `notAfter`. */
  daysUntilExpiry: z.number().int(),
});

export type CertificateInfo = z.infer<typeof certificateInfoSchema>;

/**
 * Uploaded material is fully validated — parseable, key matches certificate, not
 * expired — *before* the live certificate is replaced. Getting this wrong locks the
 * operator out of the only management interface (R11).
 */
export const uploadCertificateRequestSchema = z
  .object({
    certPem: pemBlock('CERTIFICATE'),
    keyPem: z
      .string()
      .min(1)
      .max(1_000_000)
      .refine(
        (s) => /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(s),
        'Expected a PEM-encoded private key block',
      ),
    chainPem: pemBlock('CERTIFICATE').optional(),
  })
  .strict();

export type UploadCertificateRequest = z.infer<typeof uploadCertificateRequestSchema>;

export const regenerateCertificateRequestSchema = z
  .object({
    validityYears: z.number().int().min(1).max(20).default(10),
    /** Added to the automatic SANs (hostname, every interface address, localhost). */
    additionalSans: z
      .array(z.union([hostnameSchema, ipAddressSchema]))
      .max(32)
      .default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Firewall (T36)
// ---------------------------------------------------------------------------

export const firewallProtocolSchema = z.enum(['tcp', 'udp', 'icmp', 'any']);
export const firewallActionSchema = z.enum(['accept', 'drop', 'reject']);

export const firewallRuleSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  action: firewallActionSchema,
  protocol: firewallProtocolSchema,
  /** Single port or inclusive range. Absent means any port. */
  port: portSchema.nullable(),
  portEnd: portSchema.nullable(),
  /** CIDR or single address. Absent means any source. */
  source: z.string().nullable(),
  interface: interfaceNameSchema.nullable(),
  comment: z.string().max(200).nullable(),
});

export type FirewallRule = z.infer<typeof firewallRuleSchema>;

/** Rules are additive on top of the spec's default-accept policy. */
export const firewallConfigSchema = z
  .object({
    defaultPolicy: z.enum(['allow', 'deny']),
    rules: z.array(firewallRuleSchema).max(500),
  })
  .strict();

export type FirewallConfig = z.infer<typeof firewallConfigSchema>;

export const applyFirewallResponseSchema = z.object({
  applied: z.boolean(),
  /**
   * Set when the new ruleset could lock the admin out. The change is staged and
   * reverted automatically unless confirmed before this deadline (R11).
   */
  revertAt: unixSecondsSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Fail2Ban (T37)
// ---------------------------------------------------------------------------

export const bannedIpSchema = z.object({
  ip: ipAddressSchema,
  bannedAt: unixSecondsSchema,
  expiresAt: unixSecondsSchema.nullable(),
  failures: z.number().int().nonnegative(),
});

export const fail2banStatusSchema = z.object({
  enabled: z.boolean(),
  /** False when fail2ban is not installed or the jail failed to load. */
  jailActive: z.boolean(),
  currentlyBanned: z.number().int().nonnegative(),
  totalBanned: z.number().int().nonnegative(),
  bannedIps: z.array(bannedIpSchema),
  maxRetry: z.number().int().positive(),
  findTimeSeconds: z.number().int().positive(),
  banTimeSeconds: z.number().int().positive(),
});

export type Fail2banStatus = z.infer<typeof fail2banStatusSchema>;

export const unbanRequestSchema = z.object({ ip: ipAddressSchema }).strict();

// ---------------------------------------------------------------------------
// Setup wizard — returns 410 Gone once completed
// ---------------------------------------------------------------------------

export const SETUP_STEPS = ['password', 'network', 'credentials', 'share', 'review'] as const;
export const setupStepSchema = z.enum(SETUP_STEPS);
export type SetupStep = z.infer<typeof setupStepSchema>;

export const setupStatusSchema = z.object({
  completed: z.boolean(),
  currentStep: setupStepSchema,
  completedSteps: z.array(setupStepSchema),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** First step: replace the install-time password before anything else is configured. */
export const setupPasswordRequestSchema = z
  .object({
    password: adminPasswordSchema,
  })
  .strict();

export const completeSetupRequestSchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Shared list queries
// ---------------------------------------------------------------------------

export const updateHistoryQuerySchema = paginationQuerySchema;
