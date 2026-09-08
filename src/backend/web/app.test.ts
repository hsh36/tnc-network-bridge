import request from 'supertest';
import { type Express } from 'express';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { AuthLogWriter } from '../logging/auth-log';
import { ConflictResolver } from '../locking/conflict-resolver';
import { LockManager } from '../locking/lock-manager';
import { createShareCacheRootResolver } from '../config/share-paths';
import { AuditLog, installAuditGuards } from '../security/audit-log';
import { BlobStore } from '../versioning/blob-store';
import { VersionStore } from '../versioning/version-store';
import { createApp } from './app';
import { AuthManager } from './auth';
import { type AppContext } from './context';
import { EventBus } from './event-bus';

/**
 * Exercises the real route wiring end to end against a temp SQLite database — success,
 * validation-failure and authz-failure per route, in the spirit of the eventual full
 * API test suite `docs/TASKS.md` describes as T59.
 */

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let ctx: AppContext;

function buildContext(): AppContext {
  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  const auth = new AuthManager({
    db,
    config,
    authLog: new AuthLogWriter(`${tmpDir()}/auth.log`),
  });
  const locks = new LockManager({ db, config });
  const conflicts = new ConflictResolver(db);
  installAuditGuards(db);
  return {
    db,
    config,
    auth,
    locks,
    conflicts,
    events: new EventBus(),
    versions: new VersionStore({ db, blobs: new BlobStore({ root: `${tmpDir()}/versions` }) }),
    audit: new AuditLog(db),
    shareCacheRoot: createShareCacheRootResolver(db),
    certDir: tmpDir(),
    version: '0.0.0-test',
    startedAt: Date.now() - 1000,
    now: () => Date.now(),
  };
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  ctx = buildContext();
  app = createApp(ctx);
});

afterEach(() => {
  cleanupTmpDbs();
});

type Agent = ReturnType<typeof request.agent>;

interface AuthedAgent {
  readonly agent: Agent;
  readonly csrf: string;
}

/** Completes the two-step setup flow and returns an authenticated agent plus its CSRF token. */
async function loginAgent(): Promise<AuthedAgent> {
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

describe('unauthenticated access', () => {
  it('rejects /status without a session or token', async () => {
    const res = await request(app).get('/api/v1/status');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
  });

  it('rejects /locks without credentials', async () => {
    const res = await request(app).get('/api/v1/locks');
    expect(res.status).toBe(401);
  });

  it('serves /health without auth from localhost', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.checks.database).toBe(true);
  });

  it('serves /setup/status without auth', async () => {
    const res = await request(app).get('/api/v1/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.data.completed).toBe(false);
  });
});

describe('setup and login', () => {
  it('sets the initial password and then allows login', async () => {
    const agent = request.agent(app);
    await agent.post('/api/v1/setup/password').send({ password: PASSWORD }).expect(200);

    const res = await agent
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    expect(res.body.data.username).toBe('admin');
    expect(typeof res.body.data.csrfToken).toBe('string');
    expect(res.headers['set-cookie']?.[0]).toMatch(/HttpOnly/);
  });

  it('rejects a second setup/password call once setup is complete', async () => {
    await loginAgent();

    const res = await request(app).post('/api/v1/setup/password').send({ password: PASSWORD });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('SETUP_ALREADY_COMPLETED');
  });

  it('rejects an invalid login body with field-level detail', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ username: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });
});

describe('status and system', () => {
  it('returns a zeroed status aggregate on a fresh install', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/status').expect(200);
    expect(res.body.data.totals.activeLocks).toBe(0);
    expect(res.body.data.serverLink.reachable).toBe(false);
    expect(res.body.data.setupRequired).toBe(false); // loginAgent() completes the wizard
  });

  it('returns host facts from /system', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/system').expect(200);
    expect(typeof res.body.data.hostname).toBe('string');
    expect(res.body.data.memory.totalBytes).toBeGreaterThan(0);
  });
});

describe('config', () => {
  it('round-trips a section and redacts its secret', async () => {
    const { agent, csrf } = await loginAgent();
    const before = await agent.get('/api/v1/config/smb').expect(200);
    expect(before.body.data.server.credentials.password).toBe('********');

    const res = await agent
      .put('/api/v1/config/sync')
      .set('x-csrf-token', csrf)
      .send({ conflictMode: 'server_wins' })
      .expect(200);
    expect(res.body.data.conflictMode).toBe('server_wins');
  });

  it('rejects a mutation without the CSRF header', async () => {
    const { agent } = await loginAgent();
    const res = await agent.put('/api/v1/config/sync').send({ conflictMode: 'server_wins' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects an invalid section name', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/config/not-a-real-section');
    expect(res.status).toBe(400);
  });
});

describe('locks', () => {
  it('creates, lists and releases a manual lock', async () => {
    const { agent, csrf } = await loginAgent();
    db.run(
      `INSERT INTO shares (id, name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES (1, 'main', '//srv/share', '/mnt/main', '/srv/main', unixepoch(), unixepoch())`,
    );

    const created = await agent
      .post('/api/v1/locks')
      .set('x-csrf-token', csrf)
      .send({ shareId: 1, relPath: 'programs/part1.h' })
      .expect(201);
    expect(created.body.data.origin).toBe('manual');

    const list = await agent.get('/api/v1/locks').expect(200);
    expect(list.body.data.total).toBe(1);

    const released = await agent
      .delete(`/api/v1/locks/${created.body.data.id as number}`)
      .set('x-csrf-token', csrf)
      .expect(200);
    expect(released.body.data.acknowledged).toBe(true);
  });
});

describe('logs', () => {
  it('lists log entries, empty on a fresh install', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/logs').expect(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });
});
