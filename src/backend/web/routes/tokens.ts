import { Router } from 'express';
import { createTokenRequestSchema, paginationQuerySchema } from '../../../shared';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import { asyncHandler, ok, requireCsrf, requireSession } from '../middleware';

function idParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Expected a positive integer id');
  }
  return n;
}

/**
 * `/tokens` (T46): Create, list, and revoke read-only API tokens for monitoring integrations.
 *
 * Tokens are shown exactly once on creation — never again. The database stores only the
 * SHA-256 hash, so a stolen database is not sufficient to forge valid tokens.
 *
 * All token endpoints require a browser session (not token auth), because managing tokens
 * is an admin operation that belongs behind the same interactive barrier as the rest of
 * the configuration. The tokens themselves are used by non-interactive monitoring systems.
 */
export function tokensRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/tokens', requireSession(ctx), (req, res) => {
    const query = paginationQuerySchema.parse(req.query);
    const allTokens = ctx.auth.listTokens();
    const total = allTokens.length;
    const items = allTokens.slice(query.offset, query.offset + query.limit);
    ok(res, { items, total, limit: query.limit, offset: query.offset });
  });

  router.post(
    '/tokens',
    requireSession(ctx),
    requireCsrf(ctx),
    asyncHandler((req, res) => {
      const body = createTokenRequestSchema.parse(req.body);
      const result = ctx.auth.createToken(body.name, body.scopes);
      ok(res, { token: result.token, value: result.value }, 201);
    }),
  );

  router.delete(
    '/tokens/:id',
    requireSession(ctx),
    requireCsrf(ctx),
    asyncHandler((req, res) => {
      const tokenId = idParam(req.params.id);

      // Ensure the token exists before attempting revocation.
      const allTokens = ctx.auth.listTokens();
      const token = allTokens.find((t) => t.id === tokenId);
      if (token === undefined) {
        throw new HttpError(404, 'NOT_FOUND', 'API token not found');
      }

      ctx.auth.revokeToken(tokenId);
      ok(res, { acknowledged: true as const });
    }),
  );

  return router;
}
