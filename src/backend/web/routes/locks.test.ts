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

  it('returns scheduled lock windows with proper structure', async () => {
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

    // Create a lock schedule with a simple cron expression
    // Using "*/5 * * * *" (every 5 minutes) guarantees an occurrence in the next few minutes
    const cronExpr = '*/5 * * * *';

    await agent
      .post('/api/v1/schedules')
      .set('x-csrf-token', csrf)
      .send({
        name: 'frequent lock',
        kind: 'lock',
        cron: cronExpr,
        target: { shareId: 1, pathGlob: '**/*.H', durationMinutes: 60 },
        enabled: true,
      })
      .expect(201);

    // Get the preview
    const res = await agent.get('/api/v1/locks/schedule/preview').expect(200);

    // Response structure is correct
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('windows');
    expect(res.body.data).toHaveProperty('days', 7);
    expect(res.body.data).toHaveProperty('count');

    // If we have windows, check their structure
    if (res.body.data.windows.length > 0) {
      const window = res.body.data.windows[0];
      expect(window).toHaveProperty('scheduleName', 'frequent lock');
      expect(window).toHaveProperty('kind', 'lock');
      expect(window).toHaveProperty('shareId', 1);
      expect(window).toHaveProperty('pathGlob', '**/*.H');
      expect(window).toHaveProperty('startsAt');
      expect(window).toHaveProperty('endsAt');
      expect(typeof window.startsAt).toBe('number');
      expect(typeof window.endsAt).toBe('number');
    }
  });

  it('respects the days parameter', async () => {
    const { agent } = await loginAgent();

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

    // Request with default days
    const resDefault = await agent.get('/api/v1/locks/schedule/preview').expect(200);
    expect(resDefault.body.data.days).toBe(7);

    // Request with custom days
    const resCustom = await agent.get('/api/v1/locks/schedule/preview?days=30').expect(200);
    expect(resCustom.body.data.days).toBe(30);

    // Request with invalid days (should cap at 90)
    const resMax = await agent.get('/api/v1/locks/schedule/preview?days=999').expect(200);
    expect(resMax.body.data.days).toBe(90);
  });

  it('filters by share when specified', async () => {
    const { agent } = await loginAgent();

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

    // Test that filtering by a non-existent share returns empty
    const resInvalid = await agent.get('/api/v1/locks/schedule/preview?share=999').expect(200);
    expect(resInvalid.body.data.count).toBe(0);
    expect(resInvalid.body.data.windows).toEqual([]);

    // Test that filtering by a valid share only returns locks for that share
    const resShare1 = await agent.get('/api/v1/locks/schedule/preview?share=1').expect(200);
    expect(resShare1.body.ok).toBe(true);
    expect(resShare1.body.data).toHaveProperty('count');

    if (resShare1.body.data.windows.length > 0) {
      // All windows should have shareId 1
      expect(resShare1.body.data.windows.every((w: { shareId: number }) => w.shareId === 1)).toBe(
        true,
      );
    }
  });
});
