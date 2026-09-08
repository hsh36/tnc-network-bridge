import { Router } from 'express';
import {
  listVersionsQuerySchema,
  pinVersionRequestSchema,
  restoreVersionRequestSchema,
} from '../../../shared';
import { BlobNotFoundError } from '../../versioning/blob-store';
import { PathTraversalError, VersionNotFoundError } from '../../versioning/version-store';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import {
  asyncHandler,
  ok,
  requireCsrf,
  requireSession,
  requireSessionOrToken,
} from '../middleware';

/**
 * `/versions` (T34/T35), over the {@link AppContext.versions} store.
 *
 * Restore and delete are the two endpoints here that can destroy work, so both are
 * session-only, CSRF-guarded and written to the audit log (T43) — a read-only monitoring
 * token can list history and nothing more.
 */

function idParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Expected a positive integer id');
  }
  return n;
}

/** Maps versioning's own failures onto the API's error taxonomy. */
function toHttp(err: unknown): unknown {
  if (err instanceof VersionNotFoundError) {
    return new HttpError(404, 'NOT_FOUND', err.message);
  }
  if (err instanceof PathTraversalError) {
    return new HttpError(400, 'VALIDATION_FAILED', 'The target path escapes the share root');
  }
  if (err instanceof BlobNotFoundError) {
    // The row exists but its content does not — a store inconsistency, not a client error.
    return new HttpError(
      410,
      'NOT_FOUND',
      'The stored content for this version is no longer available',
    );
  }
  return err;
}

export function versionsRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/versions', requireSessionOrToken(ctx), (req, res) => {
    const query = listVersionsQuerySchema.parse(req.query);
    const page = ctx.versions.list({
      ...(query.share !== undefined ? { shareId: query.share } : {}),
      ...(query.path !== undefined ? { relPath: query.path } : {}),
      limit: query.limit,
      offset: query.offset,
    });
    ok(res, { items: page.items, total: page.total, limit: query.limit, offset: query.offset });
  });

  router.get(
    '/versions/:id/download',
    requireSession(ctx),
    asyncHandler(async (req, res) => {
      const id = idParam(req.params.id);
      try {
        const version = ctx.versions.require(id);
        const stream = await ctx.versions.openContent(id);

        // `attachment` with an explicitly quoted, sanitised filename: a rel_path can
        // contain characters that would otherwise let a header break out of its value.
        const filename = version.relPath.split('/').pop() ?? 'version';
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`,
        );
        res.setHeader('Content-Length', String(version.size));
        stream.pipe(res);
      } catch (err) {
        throw toHttp(err);
      }
    }),
  );

  router.post(
    '/versions/:id/restore',
    requireSession(ctx),
    requireCsrf(ctx),
    asyncHandler(async (req, res) => {
      const id = idParam(req.params.id);
      const body = restoreVersionRequestSchema.parse(req.body ?? {});
      try {
        const version = ctx.versions.require(id);
        const cacheRoot = ctx.shareCacheRoot(version.shareId);
        const result = await ctx.versions.restore(id, {
          cacheRoot,
          ...(body.targetPath !== undefined ? { targetPath: body.targetPath } : {}),
        });
        ctx.audit?.record({
          actor: 'admin',
          action: 'version.restore',
          target: `${String(version.shareId)}:${result.restoredTo}`,
          result: 'ok',
          detail: `restored version ${String(id)}`,
          ...(req.ip !== undefined ? { ip: req.ip } : {}),
        });
        ok(res, result);
      } catch (err) {
        throw toHttp(err);
      }
    }),
  );

  router.post('/versions/:id/pin', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const id = idParam(req.params.id);
    const body = pinVersionRequestSchema.parse(req.body);
    try {
      const version = ctx.versions.setPinned(id, body.pinned);
      ctx.audit?.record({
        actor: 'admin',
        action: body.pinned ? 'version.pin' : 'version.unpin',
        target: String(id),
        result: 'ok',
        ...(req.ip !== undefined ? { ip: req.ip } : {}),
      });
      ok(res, version);
    } catch (err) {
      throw toHttp(err);
    }
  });

  router.delete(
    '/versions/:id',
    requireSession(ctx),
    requireCsrf(ctx),
    asyncHandler(async (req, res) => {
      const id = idParam(req.params.id);
      try {
        const version = ctx.versions.require(id);
        if (version.pinned) {
          throw new HttpError(409, 'VALIDATION_FAILED', 'Unpin this version before deleting it');
        }
        const result = await ctx.versions.delete(id);
        ctx.audit?.record({
          actor: 'admin',
          action: 'version.delete',
          target: `${String(version.shareId)}:${version.relPath}`,
          result: 'ok',
          detail: result.blobDeleted ? 'blob removed' : 'blob retained (shared content)',
          ...(req.ip !== undefined ? { ip: req.ip } : {}),
        });
        ok(res, { acknowledged: true as const });
      } catch (err) {
        throw toHttp(err);
      }
    }),
  );

  return router;
}
