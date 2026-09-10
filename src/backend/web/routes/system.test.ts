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
import { UpdateManager } from '../../system/update-manager';
import { BlobStore } from '../../versioning/blob-store';
import { VersionStore } from '../../versioning/version-store';
import { createApp } from '../app';
import { AuthManager } from '../auth';
import { type AppContext } from '../context';
import { EventBus } from '../event-bus';

/**
 * The reported defect, at the level the operator met it: they pressed "Updates
 * suchen", the request succeeded, and the page still read "Noch keine Überprüfungen
 * durchgeführt". The routes answered `/update/status` from a literal while `/update/check`
 * returned a timestamp in its own response and discarded it, and the UI polls status.
 *
 * So these assert across two requests — check, then a *fresh* status read — because a
 * single-request test passes against exactly the code that was broken.
 */

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let events: EventBus;

const release = (tag: string): unknown => ({
  tag_name: tag,
  body: 'what changed',
  draft: false,
  prerelease: false,
  published_at: '2026-09-01T10:00:00Z',
  tarball_url: `https://api.github.com/repos/o/r/tarball/${tag}`,
});

const respondWith = (body: unknown, status = 200): typeof fetch =>
  (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    })) as unknown as typeof fetch;

function buildContext(updates?: UpdateManager, config?: ConfigManager): AppContext {
  const cfg = config ?? ConfigManager.create({ db, secretKey: generateSecretKey() });
  installAuditGuards(db);

  return {
    db,
    config: cfg,
    auth: new AuthManager({ db, config: cfg, authLog: new AuthLogWriter(`${tmpDir()}/auth.log`) }),
    locks: new LockManager({ db, config: cfg }),
    conflicts: new ConflictResolver(db),
    events,
    versions: new VersionStore({ db, blobs: new BlobStore({ root: `${tmpDir()}/versions` }) }),
    schedules: new Scheduler({ db, jobs: new JobRegistry() }),
    metrics: createBridgeMetrics(),
    audit: new AuditLog(db),
    shareCacheRoot: createShareCacheRootResolver(db),
    certDir: tmpDir(),
    ...(updates === undefined ? {} : { updates }),
    version: '0.1.0',
    startedAt: Date.now() - 1000,
    now: () => Date.now(),
  };
}

/** An app whose updater sees exactly the releases given. */
function appWith(releases: unknown[], invoke?: () => never): Express {
  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  const updates = new UpdateManager({
    currentVersion: '0.1.0',
    publishEvent: (event) => {
      events.publish(event);
    },
    config,
    db,
    fetchImpl: respondWith(releases),
    statusFile: `${tmpDir()}/update-status.json`,
    invoke:
      invoke ??
      ((request_) => ({ ok: true, verb: request_.verb, commands: [], detail: {} }) as never),
  });
  return createApp(buildContext(updates, config));
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  events = new EventBus();
  app = appWith([]);
});

afterEach(() => {
  cleanupTmpDbs();
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(target: Express = app): Promise<{ agent: Agent; csrf: string }> {
  const agent = request.agent(target);
  await agent.post('/api/v1/setup/password').send({ password: PASSWORD }).expect(200);
  const login = await agent
    .post('/api/v1/auth/login')
    .send({ username: 'admin', password: PASSWORD })
    .expect(200);
  const csrf = (login.body as { data: { csrfToken: string } }).data.csrfToken;
  await agent.post('/api/v1/setup/complete').set('x-csrf-token', csrf).send({}).expect(200);
  return { agent, csrf };
}

interface StatusBody {
  data: {
    currentVersion: string;
    available: { version: string } | null;
    phase: string;
    lastCheckAt: number | null;
    lastError: string | null;
    rollbackVersion: string | null;
  };
}

describe('GET /system', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/system')).status).toBe(401);
  });

  it('reports the running version and host facts', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/system').expect(200);

    expect(res.body).toMatchObject({ ok: true, data: { version: '0.1.0' } });
    expect(
      (res.body as { data: { interfaces: unknown[] } }).data.interfaces.length,
    ).toBeGreaterThan(0);
  });
});

describe('GET /update/status', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/update/status')).status).toBe(401);
  });

  it('reports no check before one has been made', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/update/status').expect(200);

    expect((res.body as StatusBody).data).toMatchObject({
      currentVersion: '0.1.0',
      available: null,
      phase: 'idle',
      lastCheckAt: null,
    });
  });
});

describe('POST /update/check', () => {
  it('requires a session, not just a token', async () => {
    expect((await request(app).post('/api/v1/update/check')).status).toBe(401);
  });

  it('makes the result of the check visible to the next status poll', async () => {
    // This is the defect. `/update/check` always returned a timestamp; `/update/status`
    // always returned null. The page polls status, so the check appeared to do nothing.
    const { agent, csrf } = await loginAgent();

    await agent.post('/api/v1/update/check').set('x-csrf-token', csrf).send({}).expect(200);
    const res = await agent.get('/api/v1/update/status').expect(200);

    expect((res.body as StatusBody).data.lastCheckAt).not.toBeNull();
  });

  it('offers a newer release', async () => {
    const target = appWith([release('v0.2.0')]);
    const { agent, csrf } = await loginAgent(target);

    await agent.post('/api/v1/update/check').set('x-csrf-token', csrf).send({}).expect(200);
    const res = await agent.get('/api/v1/update/status').expect(200);

    expect((res.body as StatusBody).data.available).toMatchObject({ version: '0.2.0' });
  });

  it('does not offer the running version to itself', async () => {
    const target = appWith([release('v0.1.0')]);
    const { agent, csrf } = await loginAgent(target);

    await agent.post('/api/v1/update/check').set('x-csrf-token', csrf).send({}).expect(200);
    const res = await agent.get('/api/v1/update/status').expect(200);

    expect((res.body as StatusBody).data.available).toBeNull();
    expect((res.body as StatusBody).data.lastCheckAt).not.toBeNull();
  });

  it('answers 200 with the reason when GitHub refuses, rather than 500', async () => {
    // A repository that does not exist is a definite answer, and the operator needs to
    // read it. A 500 would only say "something went wrong" and lose the message.
    const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
    const updates = new UpdateManager({
      currentVersion: '0.1.0',
      publishEvent: (event) => {
        events.publish(event);
      },
      config,
      db,
      fetchImpl: respondWith({ message: 'Not Found' }, 404),
      statusFile: `${tmpDir()}/update-status.json`,
    });
    const target = createApp(buildContext(updates, config));
    const { agent, csrf } = await loginAgent(target);

    const res = await agent
      .post('/api/v1/update/check')
      .set('x-csrf-token', csrf)
      .send({})
      .expect(200);

    expect((res.body as StatusBody).data.lastError).toMatch(/Settings > Updates/);
    expect((res.body as StatusBody).data.lastCheckAt).not.toBeNull();
  });
});

describe('POST /update/apply', () => {
  it('requires a session', async () => {
    expect((await request(app).post('/api/v1/update/apply')).status).toBe(401);
  });

  it('refuses when no release has been found', async () => {
    const { agent, csrf } = await loginAgent();
    const res = await agent.post('/api/v1/update/apply').set('x-csrf-token', csrf).send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('accepts the request and reports progress separately', async () => {
    // Applying ends in a restart, so the response cannot carry the outcome — it says
    // the work was accepted, and the UI follows the status from there.
    const target = appWith([release('v0.2.0')]);
    const { agent, csrf } = await loginAgent(target);

    await agent.post('/api/v1/update/check').set('x-csrf-token', csrf).send({}).expect(200);
    const res = await agent
      .post('/api/v1/update/apply')
      .set('x-csrf-token', csrf)
      .send({})
      .expect(200);

    expect(res.body).toMatchObject({ ok: true, data: { accepted: true } });
  });

  it('rejects a body the contract does not allow', async () => {
    const { agent, csrf } = await loginAgent();
    const res = await agent
      .post('/api/v1/update/apply')
      .set('x-csrf-token', csrf)
      .send({ version: '0.2.0', andAlso: 'something' });

    expect(res.status).toBe(400);
  });
});

describe('POST /update/rollback', () => {
  it('requires a session', async () => {
    expect((await request(app).post('/api/v1/update/rollback')).status).toBe(401);
  });

  it('fails when there is no previous release to return to', async () => {
    const { agent, csrf } = await loginAgent();
    const res = await agent.post('/api/v1/update/rollback').set('x-csrf-token', csrf).send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /update/history', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/update/history')).status).toBe(401);
  });

  it('is empty on an installation that has never updated', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/update/history').expect(200);

    expect(res.body).toMatchObject({ ok: true, data: { items: [], total: 0 } });
  });

  it('lists an attempt that failed at the privilege boundary', async () => {
    const target = appWith([release('v0.2.0')], () => {
      throw new Error('sudo: a password is required');
    });
    const { agent, csrf } = await loginAgent(target);

    await agent.post('/api/v1/update/check').set('x-csrf-token', csrf).send({}).expect(200);
    await agent.post('/api/v1/update/apply').set('x-csrf-token', csrf).send({});

    const res = await agent.get('/api/v1/update/history').expect(200);
    const body = res.body as { data: { items: { result: string }[]; total: number } };
    expect(body.data.total).toBe(1);
    expect(body.data.items[0]?.result).toBe('failed');
  });

  it('honours limit and offset', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/update/history?limit=5&offset=2').expect(200);

    expect(res.body).toMatchObject({ ok: true, data: { limit: 5, offset: 2 } });
  });
});

describe('an instance built without an updater', () => {
  it('reports an idle system rather than inventing one', async () => {
    // A context with no UpdateManager is a real state — a route test builds one. The
    // routes describe what is there instead of failing.
    const target = createApp(buildContext());
    const { agent } = await loginAgent(target);

    const res = await agent.get('/api/v1/update/status').expect(200);
    expect((res.body as StatusBody).data).toMatchObject({ phase: 'idle', lastCheckAt: null });
  });

  it('answers a check with an idle status instead of pretending to look', async () => {
    const target = createApp(buildContext());
    const { agent, csrf } = await loginAgent(target);

    const res = await agent
      .post('/api/v1/update/check')
      .set('x-csrf-token', csrf)
      .send({})
      .expect(200);

    expect((res.body as StatusBody).data).toMatchObject({ phase: 'idle', lastCheckAt: null });
  });

  it('refuses to roll back, for the same reason', async () => {
    const target = createApp(buildContext());
    const { agent, csrf } = await loginAgent(target);

    const res = await agent
      .post('/api/v1/update/rollback')
      .set('x-csrf-token', csrf)
      .send({})
      .expect(500);

    expect(res.body).toMatchObject({ ok: false });
  });

  it('reports an empty history rather than failing the page', async () => {
    const target = createApp(buildContext());
    const { agent } = await loginAgent(target);

    const res = await agent.get('/api/v1/update/history').expect(200);
    expect(res.body).toMatchObject({ ok: true, data: { items: [], total: 0 } });
  });

  it('refuses to apply, because there is nothing that could', async () => {
    const target = createApp(buildContext());
    const { agent, csrf } = await loginAgent(target);

    const applied = await agent
      .post('/api/v1/update/apply')
      .set('x-csrf-token', csrf)
      .send({})
      .expect(500);

    expect(applied.body).toMatchObject({ ok: false });
  });
});
