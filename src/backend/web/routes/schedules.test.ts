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
import { ManagedSchedules, MANAGED_SCHEDULE_NAMES } from '../../system/managed-schedules';
import { BlobStore } from '../../versioning/blob-store';
import { VersionStore } from '../../versioning/version-store';
import { createApp } from '../app';
import { AuthManager } from '../auth';
import { type AppContext } from '../context';
import { EventBus } from '../event-bus';

/**
 * The managed schedules are projections of the update config sections. Editing one here
 * would change a value the next reconcile overwrites — silently, and probably minutes
 * later — so the API refuses and names where the setting actually lives.
 */

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let scheduler: Scheduler;
let config: ConfigManager;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  installAuditGuards(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  scheduler = new Scheduler({ db, jobs: new JobRegistry() });
  new ManagedSchedules({ config, scheduler }).reconcile();

  const ctx: AppContext = {
    db,
    config,
    auth: new AuthManager({
      db,
      config,
      authLog: new AuthLogWriter(`${tmpDir()}/auth.log`),
    }),
    locks: new LockManager({ db, config }),
    conflicts: new ConflictResolver(db),
    events: new EventBus(),
    versions: new VersionStore({ db, blobs: new BlobStore({ root: `${tmpDir()}/versions` }) }),
    schedules: scheduler,
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

function managedId(name: string): number {
  const row = scheduler.list({ limit: 100 }).items.find((schedule) => schedule.name === name);
  if (row === undefined) {
    throw new Error(`no managed schedule named ${name}`);
  }
  return row.id;
}

describe('GET /schedules', () => {
  it('lists the managed schedules alongside everything else', async () => {
    // They are visible, not hidden: an operator looking at "what runs on this
    // appliance" should see the update jobs and when they next fire.
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/schedules').expect(200);

    const names = (res.body as { data: { items: { name: string }[] } }).data.items.map(
      (item) => item.name,
    );
    expect(names).toContain(MANAGED_SCHEDULE_NAMES.update);
    expect(names).toContain(MANAGED_SCHEDULE_NAMES.osUpdate);
  });
});

describe('PATCH /schedules/:id', () => {
  it('refuses to edit a managed schedule, and says where the setting lives', async () => {
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .patch(`/api/v1/schedules/${String(managedId(MANAGED_SCHEDULE_NAMES.update))}`)
      .set('x-csrf-token', csrf)
      .send({ cron: '0 0 * * *' });

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/Settings > Updates/);
  });

  it('leaves the schedule as the config defines it', async () => {
    const { agent, csrf } = await loginAgent();
    const before = scheduler.require(managedId(MANAGED_SCHEDULE_NAMES.osUpdate)).cron;

    await agent
      .patch(`/api/v1/schedules/${String(managedId(MANAGED_SCHEDULE_NAMES.osUpdate))}`)
      .set('x-csrf-token', csrf)
      .send({ cron: '0 0 * * *' });

    expect(scheduler.require(managedId(MANAGED_SCHEDULE_NAMES.osUpdate)).cron).toBe(before);
  });

  it('still edits a schedule the operator created', async () => {
    const { agent, csrf } = await loginAgent();
    const mine = scheduler.create({
      name: 'Nightly prune',
      kind: 'prune',
      cron: '0 2 * * *',
      target: null,
      enabled: true,
    });

    await agent
      .patch(`/api/v1/schedules/${String(mine.id)}`)
      .set('x-csrf-token', csrf)
      .send({ cron: '0 3 * * *' })
      .expect(200);

    expect(scheduler.require(mine.id).cron).toBe('0 3 * * *');
  });
});

describe('DELETE /schedules/:id', () => {
  it('refuses to delete a managed schedule', async () => {
    // Deleting it would work exactly once: the next reconcile puts it back, so the
    // operator would learn that the page does nothing.
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .delete(`/api/v1/schedules/${String(managedId(MANAGED_SCHEDULE_NAMES.update))}`)
      .set('x-csrf-token', csrf);

    expect(res.status).toBe(409);
    expect(scheduler.get(managedId(MANAGED_SCHEDULE_NAMES.update))).toBeDefined();
  });
});

describe('POST /schedules/:id/run', () => {
  it('runs a managed schedule on demand, which is the point of the button', async () => {
    // Not guarded: changing *when* it runs is what belongs elsewhere. Running it now
    // is exactly what an operator should be able to do from here.
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post(`/api/v1/schedules/${String(managedId(MANAGED_SCHEDULE_NAMES.osUpdate))}/run`)
      .set('x-csrf-token', csrf)
      .send({});

    expect(res.status).toBe(200);
  });
});
