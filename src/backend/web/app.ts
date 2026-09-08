import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { API_BASE_PATH } from '../../shared';
import { type AppContext } from './context';
import { errorHandler, notFoundHandler, requestIdMiddleware } from './middleware';
import { authRoutes } from './routes/auth';
import { configRoutes } from './routes/config';
import { eventsRoutes } from './routes/events';
import { locksRoutes } from './routes/locks';
import { logsRoutes } from './routes/logs';
import { metricsRoutes } from './routes/metrics';
import { schedulesRoutes } from './routes/schedules';
import { statusRoutes } from './routes/status';
import { systemRoutes } from './routes/system';
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

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 15_552_000, includeSubDomains: true },
    }),
  );
  app.use(requestIdMiddleware);
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  const router = express.Router();
  router.use(authRoutes(ctx));
  router.use(statusRoutes(ctx));
  router.use(configRoutes(ctx));
  router.use(locksRoutes(ctx));
  router.use(logsRoutes(ctx));
  router.use(systemRoutes(ctx));
  router.use(versionsRoutes(ctx));
  router.use(schedulesRoutes(ctx));
  router.use(metricsRoutes(ctx));
  router.use(eventsRoutes(ctx));
  app.use(API_BASE_PATH, router);

  app.use(notFoundHandler);
  app.use(errorHandler(ctx));

  return app;
}
