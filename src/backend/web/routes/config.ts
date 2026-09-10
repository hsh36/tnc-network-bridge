import { Router } from 'express';
import { configSectionNameSchema, SECRET_SENTINEL, testSmbRequestSchema } from '../../../shared';
import { rateLimit } from '../../security/rate-limit';
import { testSmbConnection } from '../../smb/tester';
import { type AppContext } from '../context';
import { asyncHandler, ok, requireCsrf, requireSession } from '../middleware';

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

  /**
   * Probe a server share before committing to it.
   *
   * The contract has declared this since the API was written and no route stood behind
   * it, so the "Test" button had nothing to call. `tester.ts` — which classifies the
   * failure into something an operator can act on, rather than passing through
   * smbclient's output — was likewise complete and unreachable.
   *
   * `probeWrite` is off. This runs against a live production share on somebody's file
   * server, from a form the operator may still be typing into; listing and connecting
   * prove reachability and credentials without creating a file on it.
   */
  router.post(
    '/config/test/smb',
    requireSession(ctx),
    requireCsrf(ctx),
    limitWrites,
    asyncHandler(async (req, res) => {
      const body = testSmbRequestSchema.parse(req.body);
      const credentials = ctx.config.get('smb').server.credentials;

      const result = await testSmbConnection({
        unc: body.unc,
        // Falls back to the configured service account, which is what makes the button
        // useful on a share whose own credentials have not been filled in yet.
        domain: body.domain ?? credentials.domain,
        username: body.username ?? credentials.username,
        // The sentinel means "the stored one": a client testing a share it fetched has
        // never held the plaintext and cannot send it.
        password:
          body.password === undefined || body.password === SECRET_SENTINEL
            ? ctx.config.getSecret('smb.server.credentials.password')
            : body.password,
        ...(body.smbVersion === undefined ? {} : { smbVersion: body.smbVersion }),
        ...(body.seal === undefined ? {} : { seal: body.seal }),
        probeWrite: false,
      });

      ctx.audit?.record({
        actor: 'admin',
        action: 'config.testSmb',
        target: body.unc,
        detail: result.success ? 'ok' : `failed: ${result.failure}`,
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });

      // 200 even for a refused connection: the probe ran and reached a verdict, which
      // is a result. A 5xx would say the appliance failed, and send the operator
      // looking in the wrong place.
      ok(res, result);
    }),
  );

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
