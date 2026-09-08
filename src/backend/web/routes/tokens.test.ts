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

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let auth: AuthManager;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  installAuditGuards(db);

  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });

  auth = new AuthManager({ db, config, authLog: new AuthLogWriter(`${tmpDir()}/auth.log`) });

  const ctx: AppContext = {
    db,
    config,
    auth,
    locks: new LockManager({ db, config }),
    conflicts: new ConflictResolver(db),
    events: new EventBus(),
    versions: new VersionStore({ db, blobs: new BlobStore({ root: `${tmpDir()}/versions` }) }),
    schedules: new Scheduler({ db, jobs: new JobRegistry() }),
    metrics: createBridgeMetrics(),
    audit: new AuditLog(db),
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

describe('GET /tokens', () => {
  it('requires a session', async () => {
    await request(app).get('/api/v1/tokens').expect(401);
  });

  it('returns a paginated empty list initially', async () => {
    const { agent } = await loginAgent();

    const res = await agent.get('/api/v1/tokens').expect(200);

    expect(res.body.data).toEqual({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
  });

  it('returns all created tokens', async () => {
    const { agent } = await loginAgent();
    auth.createToken('prtg', ['read']);
    auth.createToken('prometheus', ['read']);

    const res = await agent.get('/api/v1/tokens').expect(200);

    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.items[0].name).toBe('prometheus');
    expect(res.body.data.items[1].name).toBe('prtg');
  });

  it('respects pagination offset and limit', async () => {
    const { agent } = await loginAgent();
    auth.createToken('token1', ['read']);
    auth.createToken('token2', ['read']);
    auth.createToken('token3', ['read']);

    const res = await agent.get('/api/v1/tokens?offset=1&limit=1').expect(200);

    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].name).toBe('token2');
    expect(res.body.data.offset).toBe(1);
    expect(res.body.data.limit).toBe(1);
  });

  it('never returns the token value in the list', async () => {
    const { agent } = await loginAgent();
    auth.createToken('prtg', ['read']);

    const res = await agent.get('/api/v1/tokens').expect(200);

    expect(res.body.data.items[0].value).toBeUndefined();
  });

  it('includes lastUsedAt and revokedAt in the response', async () => {
    const { agent } = await loginAgent();
    const created = auth.createToken('prtg', ['read']);

    const res = await agent.get('/api/v1/tokens').expect(200);

    const token = res.body.data.items[0];
    expect(token.id).toBe(created.token.id);
    expect(token.lastUsedAt).toBeNull();
    expect(token.revokedAt).toBeNull();
  });
});

describe('POST /tokens', () => {
  it('requires a session', async () => {
    await request(app).post('/api/v1/tokens').send({ name: 'test' }).expect(401);
  });

  it('requires CSRF token', async () => {
    const { agent } = await loginAgent();
    await agent.post('/api/v1/tokens').send({ name: 'test' }).expect(403);
  });

  it('creates a token with the given name', async () => {
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/tokens')
      .set('x-csrf-token', csrf)
      .send({ name: 'prtg-monitor' })
      .expect(201);

    expect(res.body.data.token.name).toBe('prtg-monitor');
    expect(res.body.data.token.scopes).toEqual(['read']);
    expect(res.body.data.token.createdAt).toBeDefined();
    expect(res.body.data.token.lastUsedAt).toBeNull();
    expect(res.body.data.token.revokedAt).toBeNull();
  });

  it('returns the unhashed token value exactly once', async () => {
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/tokens')
      .set('x-csrf-token', csrf)
      .send({ name: 'prtg' })
      .expect(201);

    const token = res.body.data.value as string;
    expect(token).toBeDefined();
    expect(token.length).toBeGreaterThan(0);
    expect(token).toMatch(/^tnc_/);
  });

  it('uses custom scopes if provided', async () => {
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/tokens')
      .set('x-csrf-token', csrf)
      .send({ name: 'custom', scopes: ['read'] })
      .expect(201);

    expect(res.body.data.token.scopes).toEqual(['read']);
  });

  it('defaults to read scope', async () => {
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post('/api/v1/tokens')
      .set('x-csrf-token', csrf)
      .send({ name: 'default-scope' })
      .expect(201);

    expect(res.body.data.token.scopes).toEqual(['read']);
  });

  it('rejects invalid token names', async () => {
    const { agent, csrf } = await loginAgent();

    await agent.post('/api/v1/tokens').set('x-csrf-token', csrf).send({ name: '' }).expect(400);

    await agent
      .post('/api/v1/tokens')
      .set('x-csrf-token', csrf)
      .send({ name: 'a'.repeat(100) })
      .expect(400);
  });
});

describe('DELETE /tokens/:id', () => {
  it('requires a session', async () => {
    await request(app).delete('/api/v1/tokens/1').expect(401);
  });

  it('requires CSRF token', async () => {
    const { agent } = await loginAgent();
    const created = auth.createToken('test', ['read']);
    await agent.delete(`/api/v1/tokens/${created.token.id}`).expect(403);
  });

  it('revokes an existing token', async () => {
    const { agent, csrf } = await loginAgent();
    const created = auth.createToken('to-revoke', ['read']);

    await agent.delete(`/api/v1/tokens/${created.token.id}`).set('x-csrf-token', csrf).expect(200);

    const res = await agent.get('/api/v1/tokens').expect(200);
    const token = res.body.data.items.find((t: { id: number }) => t.id === created.token.id);
    expect(token?.revokedAt).not.toBeNull();
  });

  it('returns 404 for a non-existent token', async () => {
    const { agent, csrf } = await loginAgent();

    await agent.delete('/api/v1/tokens/99999').set('x-csrf-token', csrf).expect(404);
  });

  it('rejects requests with invalid id format', async () => {
    const { agent, csrf } = await loginAgent();

    await agent.delete('/api/v1/tokens/not-a-number').set('x-csrf-token', csrf).expect(400);
  });

  it('can revoke multiple tokens independently', async () => {
    const { agent, csrf } = await loginAgent();
    const token1 = auth.createToken('token1', ['read']);
    const token2 = auth.createToken('token2', ['read']);

    await agent.delete(`/api/v1/tokens/${token1.token.id}`).set('x-csrf-token', csrf).expect(200);

    const res = await agent.get('/api/v1/tokens').expect(200);
    const t1 = res.body.data.items.find((t: { id: number }) => t.id === token1.token.id);
    const t2 = res.body.data.items.find((t: { id: number }) => t.id === token2.token.id);
    expect(t1?.revokedAt).not.toBeNull();
    expect(t2?.revokedAt).toBeNull();
  });
});

describe('Token authentication in metrics endpoints', () => {
  it('rejects an invalid token', async () => {
    await request(app).get('/api/v1/metrics/prtg').set('x-api-key', 'tnc_invalid').expect(401);
  });

  it('rejects a revoked token', async () => {
    const created = auth.createToken('test', ['read']);
    auth.revokeToken(created.token.id);

    await request(app).get('/api/v1/metrics/prtg').set('x-api-key', created.value).expect(401);
  });

  it('grants access with a valid token to /metrics/prtg', async () => {
    const created = auth.createToken('prtg', ['read']);

    const res = await request(app)
      .get('/api/v1/metrics/prtg')
      .set('x-api-key', created.value)
      .expect(200);

    expect(res.body.prtg).toBeDefined();
  });

  it('grants access with a valid token to /metrics/prometheus', async () => {
    const created = auth.createToken('prometheus', ['read']);

    const res = await request(app)
      .get('/api/v1/metrics/prometheus')
      .set('x-api-key', created.value)
      .expect(200);

    expect(res.text).toContain('# HELP');
  });

  it('grants access with a valid token to /metrics', async () => {
    const created = auth.createToken('api', ['read']);

    const res = await request(app)
      .get('/api/v1/metrics')
      .set('x-api-key', created.value)
      .expect(200);

    expect(res.body.data.series).toBeDefined();
  });

  it('updates last_used_at on successful token validation', async () => {
    const created = auth.createToken('tracker', ['read']);

    // Use the token
    await request(app).get('/api/v1/metrics').set('x-api-key', created.value).expect(200);

    // Fetch updated token info
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/tokens').expect(200);
    const token = res.body.data.items.find((t: { id: number }) => t.id === created.token.id);
    expect(token.lastUsedAt).not.toBeNull();
  });
});

describe('Tokens are read-only by design', () => {
  it('tokens can access GET endpoints', async () => {
    const created = auth.createToken('readonly', ['read']);

    // GET /metrics is allowed
    await request(app).get('/api/v1/metrics').set('x-api-key', created.value).expect(200);

    // GET /metrics/prometheus is allowed
    await request(app)
      .get('/api/v1/metrics/prometheus')
      .set('x-api-key', created.value)
      .expect(200);

    // GET /metrics/prtg is allowed
    await request(app).get('/api/v1/metrics/prtg').set('x-api-key', created.value).expect(200);
  });

  it('tokens are rejected on session-only endpoints', async () => {
    const created = auth.createToken('readonly', ['read']);

    // POST /tokens requires session, not token
    await request(app)
      .post('/api/v1/tokens')
      .set('x-api-key', created.value)
      .send({ name: 'test' })
      .expect(401);

    // DELETE /tokens/:id requires session, not token
    await request(app).delete('/api/v1/tokens/1').set('x-api-key', created.value).expect(401);
  });
});
