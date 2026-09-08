import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { API_BASE_PATH } from '../../shared';
import { type AppContext } from './context';
import { errorHandler, notFoundHandler, requestIdMiddleware } from './middleware';
import { authRoutes } from './routes/auth';
import { configRoutes } from './routes/config';
import { dhcpRoutes } from './routes/dhcp';
import { eventsRoutes } from './routes/events';
import { locksRoutes } from './routes/locks';
import { logsRoutes } from './routes/logs';
import { metricsRoutes } from './routes/metrics';
import { networkRoutes } from './routes/network';
import { schedulesRoutes } from './routes/schedules';
import { statusRoutes } from './routes/status';
import { systemRoutes } from './routes/system';
import { tokensRoutes } from './routes/tokens';
import { versionsRoutes } from './routes/versions';

/**
 * Assembles the Express app (T29/T30): security headers, body parsing, every route
 * module mounted under {@link API_BASE_PATH}, and the error handler last so nothing
 * mounted after it is ever reachable.
 *
 * `createApp` takes an {@link AppContext} rather than building its own dependencies —
 * exactly what makes it possible to stand this up in a test against an in-memory
 * database and a fresh set of managers (see `app.test.ts`) instead of the real process.
 */
export function createApp(ctx: AppContext): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  /**
   * Security headers (T43).
   *
   * The policy is deliberately strict, and it can be: the admin UI is a self-contained
   * bundle served from this origin that loads no third-party script, font or analytics.
   * Every directive below is therefore `'self'` or `'none'` with no exception to carve
   * out later.
   *
   * - `styleSrc` keeps `'unsafe-inline'` because the bundler emits inline style
   *   attributes; script is *not* granted it, which is the directive that actually
   *   stops an injected payload from executing.
   * - `frameAncestors: 'none'` prevents clickjacking of the admin UI — a framed bridge
   *   with an invisible overlay could have an operator click "force release lock" while
   *   believing they clicked something else.
   * - `formAction: 'self'` stops an injected form from posting a session elsewhere.
   * - HSTS is 180 days with subdomains. Not preloaded: this is an internal appliance,
   *   often on a private hostname, and a preload entry is effectively irreversible.
   * - `noSniff` matters specifically for `/metrics/prometheus`, which serves text a
   *   browser might otherwise try to interpret.
   */
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'none'"],
          frameSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          baseUri: ["'self'"],
          upgradeInsecureRequests: [],
        },
      },
      hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: false },
      noSniff: true,
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
      // Cross-origin isolation headers would break nothing here and close off a class
      // of side-channel and resource-inclusion attacks against the admin origin.
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  app.use(requestIdMiddleware);
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  const router = express.Router();
  router.use(authRoutes(ctx));
  router.use(statusRoutes(ctx));
  router.use(configRoutes(ctx));
  router.use(dhcpRoutes(ctx));
  router.use(locksRoutes(ctx));
  router.use(logsRoutes(ctx));
  router.use(systemRoutes(ctx));
  router.use(versionsRoutes(ctx));
  router.use(schedulesRoutes(ctx));
  router.use(tokensRoutes(ctx));
  router.use(metricsRoutes(ctx));
  router.use(eventsRoutes(ctx));
  router.use(networkRoutes(ctx));
  app.use(API_BASE_PATH, router);

  app.use(notFoundHandler);
  app.use(errorHandler(ctx));

  return app;
}
