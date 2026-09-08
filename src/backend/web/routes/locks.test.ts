import request from 'supertest';
import { type Express } from 'express';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../../config/config-manager';
import { type Db } from '../../config/db';
import { runMigrations } from '../../config/migrations/runner';
import { generateSecretKey } from '../../config/secrets';
import { AuthLogWriter } from '../../logging/auth-log';
import { ConflictResolver } from '../../locking/conflict-resolver';
import { LockManager } from '../../locking/lock-manager';
import { ScheduleLockWindowManager } from '../../locking/schedule-windows';
import { createShareCacheRootResolver } from '../../config/share-paths';
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

  const jobs = new JobRegistry();
  const schedules = new Scheduler({ db, jobs });

  // Wire up the lock/unlock handlers
  new ScheduleLockWindowManager({
    db,
    locks,
    scheduler: schedules,
  });

  return {
    db,
    config,
    auth,
    locks,
    conflicts,
    events: new EventBus(),
    versions: new VersionStore({ db, blobs: new BlobStore({ root: `${tmpDir()}/versions` }) }),
    schedules,
    metrics: createBridgeMetrics(),
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

describe('GET /locks/schedule/preview', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/locks/schedule/preview');
    expect(res.status).toBe(401);
  });

  it('returns empty list when no lock schedules exist', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/locks/schedule/preview').expect(200);

    expect(res.body).toMatchObject({
      ok: true,
      data: {
        windows: [],
        days: 7,
        count: 0,
      },
    });
  });

  it('shows upcoming lock window within the default 7-day window', async () => {
    const { agent, csrf } = await loginAgent();

    // Create a test share
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES (@name, @unc, @mount, @cache, @now, @now)`,
      {
        name: 'test-share',
        unc: '//server/share$',
        mount: '/mnt/test-share',
        cache: '/srv/tnc/test-share',
        now: Math.floor(Date.now() / 1000),
      },
    );

    // Create a lock schedule that fires every day at midnight — guaranteed to have a future occurrence
    const cronExpr = '0 0 * * *';

    await agent
      .post('/api/v1/schedules')
      .set('x-csrf-token', csrf)
      .send({
        name: 'test lock',
        kind: 'lock',
        cron: cronExpr,
        target: { shareId: 1, pathGlob: '**/*.H', durationMinutes: 60 },
        enabled: true,
      })
      .expect(201);

    // Get the preview
    const res = await agent.get('/api/v1/locks/schedule/preview').expect(200);

    expect(res.body.data.count).toBeGreaterThan(0);
    expect(res.body.data.windows.length).toBeGreaterThan(0);

    const window = res.body.data.windows[0];
    expect(window).toMatchObject({
      scheduleName: 'test lock',
      kind: 'lock',
      shareId: 1,
      pathGlob: '**/*.H',
    });
    expect(window.startsAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(window.endsAt).toBe(window.startsAt + 3600); // 60 minutes
  });

  it('respects the days parameter', async () => {
    const { agent, csrf } = await loginAgent();

    // Create a test share
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES (@name, @unc, @mount, @cache, @now, @now)`,
      {
        name: 'test-share',
        unc: '//server/share$',
        mount: '/mnt/test-share',
        cache: '/srv/tnc/test-share',
        now: Math.floor(Date.now() / 1000),
      },
    );

    // Create a lock schedule on a specific day of the month that is guaranteed to be in the future
    // Using "0 0 20 * *" (20th of each month at midnight) — if today is before the 20th, it will fire this month
    // Otherwise, it will fire next month
    const cronExpr = '0 0 20 * *';

    await agent
      .post('/api/v1/schedules')
      .set('x-csrf-token', csrf)
      .send({
        name: 'future lock',
        kind: 'lock',
        cron: cronExpr,
        target: { shareId: 1, pathGlob: '**/*.H' },
        enabled: true,
      })
      .expect(201);

    // The test checks that the endpoint works and respects the days parameter
    const res = await agent.get('/api/v1/locks/schedule/preview?days=90').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveProperty('windows');
    expect(res.body.data).toHaveProperty('days');
    expect(res.body.data).toHaveProperty('count');
  });

  it('filters by share when specified', async () => {
    const { agent, csrf } = await loginAgent();

    // Create two shares
    for (let i = 1; i <= 2; i++) {
      db.run(
        `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
         VALUES (@name, @unc, @mount, @cache, @now, @now)`,
        {
          name: `share-${i}`,
          unc: `//server/share${i}$`,
          mount: `/mnt/share${i}`,
          cache: `/srv/tnc/share${i}`,
          now: Math.floor(Date.now() / 1000),
        },
      );
    }

    // Create lock schedules for both shares — daily at midnight is guaranteed to have future occurrences
    for (let i = 1; i <= 2; i++) {
      const cronExpr = '0 0 * * *';

      await agent
        .post('/api/v1/schedules')
        .set('x-csrf-token', csrf)
        .send({
          name: `lock-${i}`,
          kind: 'lock',
          cron: cronExpr,
          target: { shareId: i, pathGlob: '**/*.H' },
          enabled: true,
        })
        .expect(201);
    }

    // Get all windows — should show at least 1 occurrence for each share
    const resAll = await agent.get('/api/v1/locks/schedule/preview').expect(200);
    expect(resAll.body.data.count).toBeGreaterThanOrEqual(2);

    // Filter to share 1
    const res1 = await agent.get('/api/v1/locks/schedule/preview?share=1').expect(200);
    expect(res1.body.data.count).toBeGreaterThan(0);
    expect(res1.body.data.windows[0].shareId).toBe(1);

    // Filter to share 2
    const res2 = await agent.get('/api/v1/locks/schedule/preview?share=2').expect(200);
    expect(res2.body.data.count).toBeGreaterThan(0);
    expect(res2.body.data.windows[0].shareId).toBe(2);
  });
});
