import { Router } from 'express';
import { configSectionNameSchema } from '../../../shared';
import { rateLimit } from '../../security/rate-limit';
import { type AppContext } from '../context';
import { ok, requireCsrf, requireSession } from '../middleware';

/**
 * `/config/:section` (T30), over T5's {@link AppContext.config}, hardened per T43.
 *
 * Writes are rate limited and audited. Reads are neither: reading a section is
 * idempotent, the secrets are already redacted to the sentinel by the config manager,
 * and auditing every dashboard poll would bury the entries that matter under noise.
 */
export function configRoutes(ctx: AppContext): Router {
  const router = Router();

  /**
   * Ten writes per minute per principal.
   *
   * Not a defence against a determined attacker — they have a valid session by this
   * point — but against the two things that actually happen: a runaway script
   * rewriting a section in a loop, and an attacker with a stolen session probing which
   * settings they can change. Both look like a burst, and both are worth recording.
   */
  const limitWrites = rateLimit({
    limit: 10,
    windowMs: 60_000,
    onDenied: (key, req) => {
      ctx.audit?.recordDenied({
        actor: key,
        action: 'config.update',
        target: String(req.params.section ?? 'unknown'),
        detail: 'rate limit exceeded',
        ...(req.ip !== undefined ? { ip: req.ip } : {}),
      });
    },
  });

  router.get('/config/:section', requireSession(ctx), (req, res) => {
    const section = configSectionNameSchema.parse(req.params.section);
    ok(res, ctx.config.get(section));
  });

  router.put('/config/:section', requireSession(ctx), requireCsrf(ctx), limitWrites, (req, res) => {
    const section = configSectionNameSchema.parse(req.params.section);
    const updated = ctx.config.set(section, req.body, 'admin');

    // The section is named, but its values are not: a config section can hold a
    // service-account password, and an audit log is not a place to leak one. The
    // config manager already keeps the before/after in its own change events.
    ctx.audit?.record({
      actor: 'admin',
      action: 'config.update',
      target: section,
      result: 'ok',
      ...(req.ip !== undefined ? { ip: req.ip } : {}),
    });

    ok(res, updated);
  });

  return router;
}
