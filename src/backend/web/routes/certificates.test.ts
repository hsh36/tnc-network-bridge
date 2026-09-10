import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Express } from 'express';
import request from 'supertest';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../../config/config-manager';
import { type Db } from '../../config/db';
import { runMigrations } from '../../config/migrations/runner';
import { generateSecretKey } from '../../config/secrets';
import { ConflictResolver } from '../../locking/conflict-resolver';
import { LockManager } from '../../locking/lock-manager';
import { createShareCacheRootResolver } from '../../config/share-paths';
import { createBridgeMetrics } from '../../monitoring/registry';
import { JobRegistry } from '../../scheduling/jobs';
import { Scheduler } from '../../scheduling/scheduler';
import { AuditLog, installAuditGuards } from '../../security/audit-log';
import { BlobStore } from '../../versioning/blob-store';
import { VersionStore } from '../../versioning/version-store';
import { createApp } from '../app';
import { AuthLogWriter } from '../../logging/auth-log';
import { AuthManager } from '../auth';
import { type AppContext } from '../context';
import { EventBus } from '../event-bus';
import {
  type CertificateMaterial,
  generateSelfSignedCertificate,
  saveCertificateMaterial,
} from '../https-setup';

/**
 * The invariant these tests exist for: a rejected certificate must change nothing —
 * not the running listener, not the files on disk. Getting that wrong on a headless
 * appliance means an operator who can no longer reach the interface that would let
 * them undo it.
 */

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let ctx: AppContext;
let certDir: string;
let reloaded: CertificateMaterial[];
let reloadFails: boolean;

function buildContext(): AppContext {
  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  installAuditGuards(db);
  return {
    db,
    config,
    // Without an explicit writer this reaches for /var/log/tnc-bridge, which the
    // constructor creates eagerly — fine as root, EACCES on a CI runner.
    auth: new AuthManager({ db, config, authLog: new AuthLogWriter(`${tmpDir()}/auth.log`) }),
    locks: new LockManager({ db, config }),
    conflicts: new ConflictResolver(db),
    events: new EventBus(),
    versions: new VersionStore({ db, blobs: new BlobStore({ root: `${tmpDir()}/versions` }) }),
    schedules: new Scheduler({ db, jobs: new JobRegistry() }),
    metrics: createBridgeMetrics(),
    audit: new AuditLog(db),
    shareCacheRoot: createShareCacheRootResolver(db),
    certDir,
    version: '0.0.0-test',
    startedAt: Date.now() - 1000,
    now: () => Date.now(),
    // A stand-in for the real manager: the routes only ever call reload(), and what
    // matters here is whether they call it, in what order, and what they do when it
    // throws — not that a socket really renegotiated.
    httpsManager: {
      reload: (material: CertificateMaterial) => {
        if (reloadFails) {
          throw new Error('the live server refused this context');
        }
        reloaded.push(material);
      },
    } as NonNullable<AppContext['httpsManager']>,
  };
}

async function loginAgent(): Promise<{ agent: ReturnType<typeof request.agent>; csrf: string }> {
  const agent = request.agent(app);
  await agent.post('/api/v1/setup/password').send({ password: PASSWORD }).expect(200);
  const login = await agent
    .post('/api/v1/auth/login')
    .send({ username: 'admin', password: PASSWORD })
    .expect(200);
  const csrf = (login.body as { data: { csrfToken: string } }).data.csrfToken;
  await agent.post('/api/v1/setup/complete').set('x-csrf-token', csrf).send({}).expect(200);
  return { agent, csrf };
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  certDir = tmpDir('tnc-tls-');
  reloaded = [];
  reloadFails = false;
  ctx = buildContext();
  app = createApp(ctx);
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('GET /certificates', () => {
  it('needs a session', async () => {
    expect((await request(app).get('/api/v1/certificates')).status).toBe(401);
  });

  it('describes the certificate on disk', async () => {
    const material = generateSelfSignedCertificate({ commonName: 'bridge.example' });
    saveCertificateMaterial(certDir, material);
    const { agent } = await loginAgent();

    const res = await agent.get('/api/v1/certificates').expect(200);

    expect(res.body.data).toMatchObject({ selfSigned: true, keyType: 'rsa' });
    expect(res.body.data.subject).toContain('bridge.example');
    expect(res.body.data.daysUntilExpiry).toBeGreaterThan(0);
  });

  it('answers 404 rather than 500 when there is nothing to describe', async () => {
    const { agent } = await loginAgent();
    expect((await agent.get('/api/v1/certificates')).status).toBe(404);
  });
});

describe('POST /certificates/regenerate', () => {
  it('installs a fresh self-signed pair and hot-reloads it', async () => {
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/certificates/regenerate')
      .set('x-csrf-token', csrf)
      .send({ validityYears: 2, additionalSans: ['bridge.local', '10.0.0.5'] })
      .expect(200);

    expect(res.body.data.selfSigned).toBe(true);
    expect(res.body.data.subjectAltNames).toEqual(
      expect.arrayContaining(['bridge.local', '10.0.0.5']),
    );
    expect(reloaded).toHaveLength(1);
    // Disk and listener must agree, or a restart would silently change the certificate.
    expect(readFileSync(join(certDir, 'cert.pem'), 'utf8')).toBe(reloaded[0]?.certPem);
  });

  it('rejects a request without the CSRF header', async () => {
    const { agent } = await loginAgent();
    const res = await agent.post('/api/v1/certificates/regenerate').send({});
    expect(res.status).toBe(403);
    expect(reloaded).toHaveLength(0);
  });
});

describe('POST /certificates', () => {
  it('installs a valid uploaded pair', async () => {
    const material = generateSelfSignedCertificate({ commonName: 'uploaded.example' });
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/certificates')
      .set('x-csrf-token', csrf)
      .send({ certPem: material.certPem, keyPem: material.keyPem })
      .expect(200);

    expect(res.body.data.subject).toContain('uploaded.example');
    expect(reloaded).toHaveLength(1);
  });

  it('refuses a key that does not match the certificate, changing nothing', async () => {
    const existing = generateSelfSignedCertificate({ commonName: 'in-place.example' });
    saveCertificateMaterial(certDir, existing);
    const a = generateSelfSignedCertificate({ commonName: 'a.example' });
    const b = generateSelfSignedCertificate({ commonName: 'b.example' });
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/certificates')
      .set('x-csrf-token', csrf)
      .send({ certPem: a.certPem, keyPem: b.keyPem });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(reloaded).toHaveLength(0);
    // The certificate that was already serving is still the one on disk.
    expect(readFileSync(join(certDir, 'cert.pem'), 'utf8')).toBe(existing.certPem);
  });

  it('refuses material that is not a certificate at all', async () => {
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/certificates')
      .set('x-csrf-token', csrf)
      .send({ certPem: 'not a pem block', keyPem: 'neither is this' });

    expect(res.status).toBe(400);
    expect(reloaded).toHaveLength(0);
    expect(existsSync(join(certDir, 'cert.pem'))).toBe(false);
  });

  it('does not persist a certificate the live server refused', async () => {
    const material = generateSelfSignedCertificate({ commonName: 'rejected.example' });
    reloadFails = true;
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/certificates')
      .set('x-csrf-token', csrf)
      .send({ certPem: material.certPem, keyPem: material.keyPem });

    expect(res.status).toBe(400);
    // The point of writing to disk last: a certificate that survives a restart but that
    // the running process rejected is the one failure mode nobody would notice until
    // the next reboot.
    expect(existsSync(join(certDir, 'cert.pem'))).toBe(false);
  });

  it('refuses when no listener is under this process’s control', async () => {
    const material = generateSelfSignedCertificate({ commonName: 'orphan.example' });
    // The dev server proxies through Vite and owns no HttpsServerManager. Storing a
    // certificate there would claim a change that only takes effect on a restart.
    const { httpsManager: _omitted, ...withoutManager } = buildContext();
    ctx = withoutManager;
    app = createApp(ctx);
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/certificates')
      .set('x-csrf-token', csrf)
      .send({ certPem: material.certPem, keyPem: material.keyPem });

    expect(res.status).toBe(503);
    expect(existsSync(join(certDir, 'cert.pem'))).toBe(false);
  });

  it('records the installation in the audit log', async () => {
    const material = generateSelfSignedCertificate({ commonName: 'audited.example' });
    const { agent, csrf } = await loginAgent();

    await agent
      .post('/api/v1/certificates')
      .set('x-csrf-token', csrf)
      .send({ certPem: material.certPem, keyPem: material.keyPem })
      .expect(200);

    const entries = ctx.audit?.query({ action: 'certificates.upload' });
    expect(entries?.items).toHaveLength(1);
    expect(entries?.items[0]?.result).toBe('ok');
  });
});
