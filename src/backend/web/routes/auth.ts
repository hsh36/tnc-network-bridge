import { Router, type Request, type Response } from 'express';
import {
  changePasswordRequestSchema,
  completeSetupRequestSchema,
  loginRequestSchema,
  setupPasswordRequestSchema,
} from '../../../shared';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import { asyncHandler, ok, requireCsrf, requireSession, SESSION_COOKIE_NAME } from '../middleware';

/**
 * `/auth/*` and `/setup/*` (T30, against T28's {@link AppContext.auth}).
 *
 * The setup wizard is deliberately minimal here — a real T53 wizard walks network,
 * credentials and share configuration too — but the two steps that gate everything
 * else (set the admin password, mark setup complete) are real and enforced: every
 * `/setup/*` route after completion returns 410 Gone, exactly as the contract says.
 */
export function authRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const body = loginRequestSchema.parse(req.body);
      const result = await ctx.auth.login({
        username: body.username,
        password: body.password,
        ip: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      });
      setSessionCookie(req, res, result.cookieValue, result.session.expiresAt);
      ok(res, ctx.auth.toSessionInfo(result.session));
    }),
  );

  router.post('/auth/logout', requireSession(ctx), (req, res) => {
    const cookieValue = (req.cookies as Record<string, string>)[SESSION_COOKIE_NAME];
    if (cookieValue !== undefined) {
      ctx.auth.logout(cookieValue);
    }
    res.clearCookie(SESSION_COOKIE_NAME);
    ok(res, { acknowledged: true as const });
  });

  router.get('/auth/session', requireSession(ctx), (req, res) => {
    ok(res, ctx.auth.toSessionInfo(req.session!));
  });

  router.post(
    '/auth/password',
    requireSession(ctx),
    requireCsrf(ctx),
    asyncHandler(async (req, res) => {
      const body = changePasswordRequestSchema.parse(req.body);
      await ctx.auth.changePassword(body.currentPassword, body.newPassword);
      ok(res, { acknowledged: true as const });
    }),
  );

  // -------------------------------------------------------------------------
  // Setup wizard
  // -------------------------------------------------------------------------

  router.get('/setup/status', (_req, res) => {
    ok(res, {
      completed: ctx.config.getFlag<boolean>('setup.completed', false),
      currentStep: ctx.config.getFlag<string>('setup.step', 'password'),
      completedSteps: ctx.config.getFlag<string[]>('setup.completedSteps', []),
    });
  });

  router.post(
    '/setup/password',
    asyncHandler(async (req, res) => {
      assertSetupOpen(ctx);
      const body = setupPasswordRequestSchema.parse(req.body);
      await ctx.auth.setPassword(body.password);
      ctx.config.setFlag('setup.step', 'network');
      ctx.config.setFlag('setup.completedSteps', [
        ...ctx.config.getFlag<string[]>('setup.completedSteps', []),
        'password',
      ]);
      ok(res, { acknowledged: true as const });
    }),
  );

  router.post('/setup/complete', requireSession(ctx), (req, res) => {
    assertSetupOpen(ctx);
    completeSetupRequestSchema.parse(req.body);
    ctx.config.setFlag('setup.completed', true);
    ok(res, { acknowledged: true as const });
  });

  return router;
}

function assertSetupOpen(ctx: AppContext): void {
  if (ctx.config.getFlag<boolean>('setup.completed', false)) {
    throw new HttpError(410, 'SETUP_ALREADY_COMPLETED', 'The setup wizard has already run');
  }
}

function setSessionCookie(req: Request, res: Response, value: string, expiresAtSeconds: number): void {
  res.cookie(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    // `req.secure` reflects the real connection: true behind the real HTTPS listener
    // (`dev-server.ts` / production), false under a plain-HTTP test harness such as
    // supertest. A cookie marked `Secure` over a genuinely insecure connection is
    // simply never sent by a real browser, so this is never a downgrade in production —
    // only what makes the identical route testable without also standing up TLS.
    secure: req.secure,
    sameSite: 'strict',
    expires: new Date(expiresAtSeconds * 1000),
    path: '/',
  });
}
