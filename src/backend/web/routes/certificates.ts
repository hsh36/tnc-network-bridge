import { hostname } from 'node:os';

import { Router } from 'express';

import {
  regenerateCertificateRequestSchema,
  uploadCertificateRequestSchema,
  type CertificateInfo,
} from '../../../shared';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import { ok, requireCsrf, requireSession } from '../middleware';
import {
  CertificateError,
  type CertificateMaterial,
  describeCertificate,
  generateSelfSignedCertificate,
  loadCertificateMaterial,
  saveCertificateMaterial,
  validateCertificateMaterial,
} from '../https-setup';

/**
 * `/certificates` — the TLS material behind the admin interface itself.
 *
 * The ordering in {@link install} is the whole point of this module. A certificate that
 * the running server cannot serve locks the operator out of the only interface they
 * have for fixing it, on a headless appliance, with no console. So: validate first,
 * hot-swap into the live server second, and only write to disk once the swap has
 * succeeded. A failure at any step leaves both the running server and `certDir`
 * exactly as they were.
 *
 * Writing to disk *last* is deliberate and the opposite of the obvious order. Persisting
 * first would leave a certificate that survives a restart but that the live process
 * rejected — the worst of both, and invisible until the next reboot.
 */
export function certificateRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/certificates', requireSession(ctx), (_req, res) => {
    ok(res, currentCertificate(ctx));
  });

  router.post('/certificates', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const body = uploadCertificateRequestSchema.parse(req.body);
    const material: CertificateMaterial =
      body.chainPem === undefined
        ? { certPem: body.certPem, keyPem: body.keyPem }
        : { certPem: body.certPem, keyPem: body.keyPem, chainPem: body.chainPem };

    const info = install(ctx, material, 'certificates.upload', req.ip);
    ok(res, info);
  });

  router.post('/certificates/regenerate', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const body = regenerateCertificateRequestSchema.parse(req.body ?? {});
    const material = generateSelfSignedCertificate({
      commonName: hostname(),
      validityYears: body.validityYears,
      additionalSans: body.additionalSans,
    });

    const info = install(ctx, material, 'certificates.regenerate', req.ip);
    ok(res, info);
  });

  return router;
}

function currentCertificate(ctx: AppContext): CertificateInfo {
  try {
    return describeCertificate(loadCertificateMaterial(ctx.certDir).certPem);
  } catch (error) {
    throw new HttpError(
      404,
      'NOT_FOUND',
      error instanceof CertificateError
        ? error.message
        : `No certificate could be read from ${ctx.certDir}`,
    );
  }
}

/**
 * Validate → hot-swap → persist. See the module comment for why that order and not
 * the other one.
 */
function install(
  ctx: AppContext,
  material: CertificateMaterial,
  action: string,
  ip: string | undefined,
): CertificateInfo {
  const validation = validateCertificateMaterial(material);
  if (!validation.ok) {
    ctx.audit?.recordDenied({
      actor: 'admin',
      action,
      detail: validation.issues.map((issue) => issue.message).join('; '),
      ...(ip === undefined ? {} : { ip }),
    });
    throw new HttpError(
      400,
      'VALIDATION_FAILED',
      'The certificate was rejected and nothing was changed',
      validation.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }

  // No httpsManager means the process is serving over a listener it does not own — the
  // dev proxy, or a test. Persisting anyway would be a lie: the certificate on disk
  // would not be the one being served until a restart nobody asked for.
  if (ctx.httpsManager === undefined) {
    throw new HttpError(
      503,
      'SERVICE_UNAVAILABLE',
      'The HTTPS server is not under this process’s control, so the certificate cannot be replaced',
    );
  }

  try {
    ctx.httpsManager.reload(material, ctx.config.get('security').tlsMin);
  } catch (error) {
    ctx.audit?.recordDenied({
      actor: 'admin',
      action,
      detail: `hot-reload failed: ${error instanceof Error ? error.message : String(error)}`,
      ...(ip === undefined ? {} : { ip }),
    });
    throw new HttpError(
      400,
      'VALIDATION_FAILED',
      'The live server refused the certificate; the previous one is still in use',
    );
  }

  saveCertificateMaterial(ctx.certDir, material);

  const info = validation.info ?? describeCertificate(material.certPem);
  ctx.audit?.record({
    actor: 'admin',
    action,
    target: info.fingerprintSha256,
    detail: `subject=${info.subject} notAfter=${new Date(info.notAfter * 1000).toISOString()}`,
    ...(ip === undefined ? {} : { ip }),
  });
  return info;
}
