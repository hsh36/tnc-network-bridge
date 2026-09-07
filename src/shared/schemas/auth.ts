import { z } from 'zod';
import { entityIdSchema, ipAddressSchema, unixSecondsSchema } from './primitives';

/**
 * Minimum password policy for the single admin account.
 *
 * Length is the requirement that actually matters; composition rules mostly drive
 * people toward predictable substitutions. The bar is length plus a rejection of the
 * obvious defaults.
 */
export const adminPasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(1024, 'Password must be at most 1024 characters')
  .refine(
    (p) => !['password', 'tncbridge', '123456789012', 'administrator'].includes(p.toLowerCase()),
    'Password is too common',
  );

export const loginRequestSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(1024),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionInfoSchema = z.object({
  username: z.string(),
  /** Double-submit token; required on every mutating request (T28). */
  csrfToken: z.string(),
  createdAt: unixSecondsSchema,
  /** Absolute expiry. The idle timer is enforced separately and is not exposed. */
  expiresAt: unixSecondsSchema,
  ip: ipAddressSchema.nullable(),
  /** True until the setup wizard has been completed; the UI routes to it. */
  setupRequired: z.boolean(),
});

export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: adminPasswordSchema,
  })
  .strict()
  .refine((b) => b.currentPassword !== b.newPassword, {
    path: ['newPassword'],
    message: 'The new password must differ from the current one',
  });

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

// ---------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------

/** Tokens are read-only by design: monitoring integrations must not be able to mutate. */
export const tokenScopeSchema = z.enum(['read']);

export const apiTokenSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  scopes: z.array(tokenScopeSchema),
  createdAt: unixSecondsSchema,
  lastUsedAt: unixSecondsSchema.nullable(),
  revokedAt: unixSecondsSchema.nullable(),
});

export type ApiToken = z.infer<typeof apiTokenSchema>;

export const createTokenRequestSchema = z
  .object({
    name: z.string().min(1).max(64),
    scopes: z.array(tokenScopeSchema).nonempty().default(['read']),
  })
  .strict();

/** The only response that ever carries the token value — it is not recoverable later. */
export const createTokenResponseSchema = z.object({
  token: apiTokenSchema,
  /** Shown once. Only its sha256 is stored. */
  value: z.string(),
});

export type CreateTokenResponse = z.infer<typeof createTokenResponseSchema>;
