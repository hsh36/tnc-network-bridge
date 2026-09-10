import { type Express } from 'express';
import request from 'supertest';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../../config/config-manager';
import { type Db } from '../../config/db';
import { runMigrations } from '../../config/migrations/runner';
import { generateSecretKey } from '../../config/secrets';
import { createShareCacheRootResolver } from '../../config/share-paths';
import { ConflictResolver } from '../../locking/conflict-resolver';
import { LockManager } from '../../locking/lock-manager';
import { AuthLogWriter } from '../../logging/auth-log';
import { createBridgeMetrics } from '../../monitoring/registry';
import { JobRegistry } from '../../scheduling/jobs';
import { Scheduler } from '../../scheduling/scheduler';
import { AuditLog, installAuditGuards } from '../../security/audit-log';
import { BlobStore } from '../../versioning/blob-store';
import { VersionStore } from '../../versioning/version-store';
import { createApp } from '../app';
import { AuthManager } from '../auth';
import { type AppContext } from '../context';
import { EventBus } from '../event-bus';

/**
 * `/config/test/smb` had been declared in the API contract since the API was written,
 * with no route behind it — so the "Test connection" button had nothing to call, and
 * `tester.ts`, which classifies a failure into something an operator can act on, was
 * complete and unreachable.
 *
 * These exercise the route rather than the classifier — `tester.ts` has its own tests
 * for that. The probe target is 198.51.100.1 (TEST-NET-3, guaranteed unroutable), so
 * what is asserted is that a refused probe comes back as a *verdict* with a message in
 * both languages, and not as a 500. Whether it was refused for want of a route or for
 * want of smbclient does not change what the route must do with the answer.
 */

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let config: ConfigManager;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  installAuditGuards(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });

  const ctx: AppContext = {
    db,
    config,
    auth: new AuthManager({ db, config, authLog: new AuthLogWriter(`${tmpDir()}/auth.log`) }),
    locks: new LockManager({ db, config }),
    conflicts: new ConflictResolver(db),
    events: new EventBus(),
    versions: new VersionStore({ db, blobs: new BlobStore({ root: `${tmpDir()}/versions` }) }),
    schedules: new Scheduler({ db, jobs: new JobRegistry() }),
    metrics: createBridgeMetrics(),
    audit: new AuditLog(db),
    shareCacheRoot: createShareCacheRootResolver(db),
    certDir: tmpDir(),
    version: '0.1.0',
    startedAt: Date.now() - 1000,
    now: () => Date.now(),
  };
  app = createApp(ctx);
});

afterEach(() => {
  cleanupTmpDbs();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(): Promise<{ agent: Agent; csrf: string }> {
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

interface TestBody {
  data: {
    success: boolean;
    failure: string | null;
    message: { de: string; en: string };
  };
}

describe('GET /config/:section', () => {
  it('requires a session', async () => {
    expect((await request(app).get('/api/v1/config/network')).status).toBe(401);
  });

  it('returns a section', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/config/updates').expect(200);

    expect(res.body).toMatchObject({ ok: true, data: { channel: 'stable' } });
  });

  it('rejects a section that does not exist', async () => {
    const { agent } = await loginAgent();
    expect((await agent.get('/api/v1/config/nonsense')).status).toBe(400);
  });

  it('exposes the new osUpdates section', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/config/osUpdates').expect(200);

    expect(res.body).toMatchObject({ ok: true, data: { enabled: false, autoReboot: false } });
  });
});

describe('PUT /config/:section', () => {
  it('requires the CSRF header', async () => {
    const { agent } = await loginAgent();
    const current = (await agent.get('/api/v1/config/updates').expect(200)).body as {
      data: Record<string, unknown>;
    };

    const res = await agent.put('/api/v1/config/updates').send(current.data);
    expect(res.status).toBe(403);
  });

  it('stores a change', async () => {
    const { agent, csrf } = await loginAgent();
    const current = (await agent.get('/api/v1/config/updates').expect(200)).body as {
      data: Record<string, unknown>;
    };

    await agent
      .put('/api/v1/config/updates')
      .set('x-csrf-token', csrf)
      .send({ ...current.data, channel: 'beta' })
      .expect(200);

    expect(config.get('updates').channel).toBe('beta');
  });

  it('refuses a TNC side carrying DNS servers', async () => {
    // Enforced here and not only hidden in the form: a field the UI stops showing is
    // still a field the API accepts.
    const { agent, csrf } = await loginAgent();
    const current = (await agent.get('/api/v1/config/network').expect(200)).body as {
      data: { tnc: Record<string, unknown> };
    };

    const res = await agent
      .put('/api/v1/config/network')
      .set('x-csrf-token', csrf)
      .send({ ...current.data, tnc: { ...current.data.tnc, dns: ['8.8.8.8'] } });

    expect(res.status).toBe(400);
  });
});

describe('POST /config/test/smb', () => {
  it('requires a session', async () => {
    expect((await request(app).post('/api/v1/config/test/smb')).status).toBe(401);
  });

  it('requires the CSRF header', async () => {
    const { agent } = await loginAgent();
    const res = await agent.post('/api/v1/config/test/smb').send({ unc: '//server/share' });

    expect(res.status).toBe(403);
  });

  it('rejects something that is not a UNC path', async () => {
    const { agent, csrf } = await loginAgent();
    const res = await agent
      .post('/api/v1/config/test/smb')
      .set('x-csrf-token', csrf)
      .send({ unc: 'not a path' });

    expect(res.status).toBe(400);
  });

  it('answers 200 with a verdict when the probe fails', async () => {
    // The probe ran and reached an answer, which is a result. A 5xx would say the
    // appliance failed and send the operator looking in the wrong place.
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/config/test/smb')
      .set('x-csrf-token', csrf)
      .send({ unc: '//198.51.100.1/nothing' })
      .expect(200);

    const body = res.body as TestBody;
    expect(body.data.success).toBe(false);
    // German and English both, because the operator's UI is German and the log is not.
    expect(body.data.message.de.length).toBeGreaterThan(0);
    expect(body.data.message.en.length).toBeGreaterThan(0);
  }, 40_000);

  it('records the attempt in the audit log', async () => {
    const { agent, csrf } = await loginAgent();

    await agent
      .post('/api/v1/config/test/smb')
      .set('x-csrf-token', csrf)
      .send({ unc: '//198.51.100.1/nothing' })
      .expect(200);

    const recorded = db.pluck<number>(
      "SELECT COUNT(*) FROM audit_log WHERE action = 'config.testSmb'",
    );
    expect(recorded).toBe(1);
  }, 40_000);

  it('rejects a body with fields the contract does not allow', async () => {
    const { agent, csrf } = await loginAgent();
    const res = await agent
      .post('/api/v1/config/test/smb')
      .set('x-csrf-token', csrf)
      .send({ unc: '//server/share', probeWrite: true });

    // `probeWrite` is deliberately not part of the request: this runs against a live
    // production share from a form the operator may still be typing into.
    expect(res.status).toBe(400);
  });
});
