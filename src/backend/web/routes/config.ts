import { Router } from 'express';
import { configSectionNameSchema } from '../../../shared';
import { type AppContext } from '../context';
import { ok, requireCsrf, requireSession } from '../middleware';

/** `/config/:section` (T30), over T5's {@link AppContext.config}. */
export function configRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/config/:section', requireSession(ctx), (req, res) => {
    const section = configSectionNameSchema.parse(req.params.section);
    ok(res, ctx.config.get(section));
  });

  router.put('/config/:section', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const section = configSectionNameSchema.parse(req.params.section);
    const updated = ctx.config.set(section, req.body, 'admin');
    ok(res, updated);
  });

  return router;
}
