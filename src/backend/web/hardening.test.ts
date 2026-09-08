import { type Express } from 'express';
import request from 'supertest';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { createShareCacheRootResolver } from '../config/share-paths';
import { ConflictResolver } from '../locking/conflict-resolver';
import { LockManager } from '../locking/lock-manager';
import { AuthLogWriter } from '../logging/auth-log';
import { createBridgeMetrics } from '../monitoring/registry';
import { JobRegistry } from '../scheduling/jobs';
import { Scheduler } from '../scheduling/scheduler';
import { AuditLog, installAuditGuards } from '../security/audit-log';
import { BlobStore } from '../versioning/blob-store';
import { VersionStore } from '../versioning/version-store';
import { createApp } from './app';
import { AuthManager } from './auth';
import { type AppContext } from './context';
import { EventBus } from './event-bus';

/** T43's hardening acceptance criteria, exercised over real HTTP. */

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let audit: AuditLog;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  installAuditGuards(db);

  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  audit = new AuditLog(db);

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
    audit,
    shareCacheRoot: createShareCacheRootResolver(db),
    certDir: tmpDir(),
    version: '0.0.0-test',
    startedAt: Date.now(),
    now: () => Date.now(),
  };
  app = createApp(ctx);
});

afterEach(() => {
  cleanupTmpDbs();
});

async function loginAgent(): Promise<{
  agent: ReturnType<typeof request.agent>;
  csrf: string;
}> {
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

describe('security headers', () => {
  it('sets HSTS with a long max-age and subdomains', async () => {
    const res = await request(app).get('/api/v1/setup/status').expect(200);

    expect(res.headers['strict-transport-security']).toContain('max-age=15552000');
    expect(res.headers['strict-transport-security']).toContain('includeSubDomains');
  });

  it('does not request HSTS preloading for an internal appliance', async () => {
    const res = await request(app).get('/api/v1/setup/status').expect(200);
    // A preload entry is effectively irreversible and wrong for a private hostname.
    expect(res.headers['strict-transport-security']).not.toContain('preload');
  });

  it('sets a content security policy that denies framing and objects', async () => {
    const res = await request(app).get('/api/v1/setup/status').expect(200);
    const csp = res.headers['content-security-policy'] ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it('never grants unsafe-inline to script', async () => {
    const res = await request(app).get('/api/v1/setup/status').expect(200);
    const csp = res.headers['content-security-policy'] ?? '';

    // This is the directive that actually stops an injected payload executing.
    const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('sets nosniff, referrer and frame policies', async () => {
    const res = await request(app).get('/api/v1/setup/status').expect(200);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('does not advertise the server technology', async () => {
    const res = await request(app).get('/api/v1/setup/status').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('config API rate limiting', () => {
  it('allows writes up to the limit', async () => {
    const { agent, csrf } = await loginAgent();

    for (let i = 0; i < 10; i += 1) {
      await agent
        .put('/api/v1/config/sync')
        .set('x-csrf-token', csrf)
        .send({ conflictMode: 'server_wins' })
        .expect(200);
    }
  });

  it('refuses the eleventh write in a minute', async () => {
    const { agent, csrf } = await loginAgent();

    for (let i = 0; i < 10; i += 1) {
      await agent
        .put('/api/v1/config/sync')
        .set('x-csrf-token', csrf)
        .send({ conflictMode: 'server_wins' })
        .expect(200);
    }

    const res = await agent
      .put('/api/v1/config/sync')
      .set('x-csrf-token', csrf)
      .send({ conflictMode: 'tnc_wins' });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('tells the client when to retry', async () => {
    const { agent, csrf } = await loginAgent();
    for (let i = 0; i < 11; i += 1) {
      await agent
        .put('/api/v1/config/sync')
        .set('x-csrf-token', csrf)
        .send({ conflictMode: 'server_wins' });
    }

    const res = await agent
      .put('/api/v1/config/sync')
      .set('x-csrf-token', csrf)
      .send({ conflictMode: 'server_wins' });

    // A client told to back off can; one told only "429" retries immediately.
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('reports the remaining allowance', async () => {
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .put('/api/v1/config/sync')
      .set('x-csrf-token', csrf)
      .send({ conflictMode: 'server_wins' })
      .expect(200);

    expect(res.headers['ratelimit-limit']).toBe('10');
    expect(res.headers['ratelimit-remaining']).toBe('9');
  });

  it('records a refused write in the audit log', async () => {
    const { agent, csrf } = await loginAgent();
    for (let i = 0; i < 11; i += 1) {
      await agent
        .put('/api/v1/config/sync')
        .set('x-csrf-token', csrf)
        .send({ conflictMode: 'server_wins' });
    }

    const denied = audit
      .query({ action: 'config.update' })
      .items.filter((e) => e.result === 'denied');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]?.detail).toBe('rate limit exceeded');
  });

  it('does not rate limit reads', async () => {
    const { agent } = await loginAgent();

    for (let i = 0; i < 30; i += 1) {
      await agent.get('/api/v1/config/sync').expect(200);
    }
  });
});

describe('config auditing', () => {
  it('records a successful update, naming the section', async () => {
    const { agent, csrf } = await loginAgent();

    await agent
      .put('/api/v1/config/sync')
      .set('x-csrf-token', csrf)
      .send({ conflictMode: 'server_wins' })
      .expect(200);

    const entries = audit.query({ action: 'config.update' });
    expect(entries.total).toBe(1);
    expect(entries.items[0]?.target).toBe('sync');
    expect(entries.items[0]?.result).toBe('ok');
  });

  it('does not record the values, which can include a service-account password', async () => {
    const { agent, csrf } = await loginAgent();

    await agent
      .put('/api/v1/config/smb')
      .set('x-csrf-token', csrf)
      .send({ server: { credentials: { password: 'hunter2-the-real-one' } } });

    const serialised = JSON.stringify(audit.query().items);
    expect(serialised).not.toContain('hunter2-the-real-one');
  });
});
