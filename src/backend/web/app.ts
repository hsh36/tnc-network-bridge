import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { API_BASE_PATH } from '../../shared';
import { type AppContext } from './context';
import { managementGuard } from './management-guard';
import { errorHandler, notFoundHandler, requestIdMiddleware } from './middleware';
import { authRoutes } from './routes/auth';
import { certificateRoutes } from './routes/certificates';
import { configRoutes } from './routes/config';
import { dhcpRoutes } from './routes/dhcp';
import { eventsRoutes } from './routes/events';
import { filesRoutes } from './routes/files';
import { locksRoutes } from './routes/locks';
import { logsRoutes } from './routes/logs';
import { metricsRoutes } from './routes/metrics';
import { networkRoutes } from './routes/network';
import { schedulesRoutes } from './routes/schedules';
import { sharesRoutes } from './routes/shares';
import { statusRoutes } from './routes/status';
import { systemRoutes } from './routes/system';
import { tokensRoutes } from './routes/tokens';
import { versionsRoutes } from './routes/versions';

export interface AppOptions {
  /**
   * Directory holding the built browser bundle (`dist/frontend`).
   *
   * Set by the service, which is the only origin the admin UI is served from. Omitted by
   * the dev server — there Vite serves the frontend and proxies the API here — and by
   * tests, which exercise the API alone.
   */
  readonly staticDir?: string;
}

/**
 * Assembles the Express app (T29/T30): security headers, body parsing, every route
 * module mounted under {@link API_BASE_PATH}, the admin UI if a bundle was given, and
 * the error handler last so nothing mounted after it is ever reachable.
 *
 * `createApp` takes an {@link AppContext} rather than building its own dependencies —
 * exactly what makes it possible to stand this up in a test against an in-memory
 * database and a fresh set of managers (see `app.test.ts`) instead of the real process.
 */
export function createApp(ctx: AppContext, options: AppOptions = {}): Express {
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
  // Before anything else that could act on the request: a caller on the TNC segment
  // must not reach a route, a session check or a rate limiter. See management-guard.ts.
  app.use(requestIdMiddleware);
  app.use(managementGuard(ctx));
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  const router = express.Router();
  router.use(authRoutes(ctx));
  router.use(statusRoutes(ctx));
  router.use(configRoutes(ctx));
  router.use(dhcpRoutes(ctx));
  router.use(filesRoutes(ctx));
  router.use(locksRoutes(ctx));
  router.use(logsRoutes(ctx));
  router.use(systemRoutes(ctx));
  router.use(versionsRoutes(ctx));
  router.use(schedulesRoutes(ctx));
  router.use(tokensRoutes(ctx));
  router.use(metricsRoutes(ctx));
  router.use(eventsRoutes(ctx));
  router.use(networkRoutes(ctx));
  router.use(certificateRoutes(ctx));
  router.use(sharesRoutes(ctx));
  app.use(API_BASE_PATH, router);

  if (options.staticDir !== undefined) {
    mountAdminUi(app, options.staticDir);
  }

  app.use(notFoundHandler);
  app.use(errorHandler(ctx));

  return app;
}

/** Vite emits content-hashed asset filenames, so a hit under `assets/` never goes stale. */
const ASSET_MAX_AGE_S = 31_536_000;

/**
 * Serves the admin UI from the same origin as the API.
 *
 * Same-origin is not incidental: the CSP above is `'self'`-only and the session cookie is
 * host-scoped, so a bundle served from anywhere else would be blocked and unauthenticated
 * in the same breath.
 */
function mountAdminUi(app: Express, staticDir: string): void {
  const indexHtml = join(staticDir, 'index.html');
  if (!existsSync(indexHtml)) {
    // Fail here rather than answering every page load with a 500. A missing bundle means
    // the release was built without `npm run build:frontend`, and saying so at startup is
    // the difference between a one-line fix and an afternoon in the browser console.
    throw new Error(
      `The admin UI bundle is missing: ${indexHtml} does not exist. Run \`npm run build\`.`,
    );
  }

  app.use(
    express.static(staticDir, {
      // `index.html` is served by the fallback below so that it gets `no-cache` even when
      // requested as `/`; letting express.static answer `/` would cache the entry point.
      index: false,
      setHeaders: (res, filePath) => {
        const hashed = filePath.includes(`${sep}assets${sep}`);
        res.setHeader(
          'Cache-Control',
          hashed ? `public, max-age=${ASSET_MAX_AGE_S}, immutable` : 'no-cache',
        );
      },
    }),
  );

  // The admin UI is a single-page app: reloading the browser on `/config` must return the
  // bundle and let the client router render the page, not a 404. API paths are excluded
  // so that an unknown endpoint still answers with the JSON error envelope rather than
  // with HTML that a fetch() caller cannot parse.
  app.get('*', (req, res, next) => {
    if (req.path === API_BASE_PATH || req.path.startsWith(`${API_BASE_PATH}/`)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml, (error?: Error) => {
      if (error) {
        next(error);
      }
    });
  });
}
