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
import { createBridgeMetrics, type BridgeMetrics } from '../../monitoring/registry';
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
let metrics: BridgeMetrics;
let auth: AuthManager;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  installAuditGuards(db);

  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  metrics = createBridgeMetrics();

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
    metrics,
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

/**
 * Creates a read-only API token -- the credential a monitoring system actually holds.
 *
 * Minted through AuthManager rather than over HTTP because `/tokens` is not yet mounted;
 * what these tests are proving is that the metrics endpoints accept a token at all, not
 * how one is issued.
 */
function createToken(): string {
  return auth.createToken('prtg', ['read']).value;
}

describe('GET /metrics', () => {
  it('requires credentials', async () => {
    await request(app).get('/api/v1/metrics').expect(401);
  });

  it('returns series grouped by metric and share', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO metrics_samples (ts, metric, share_id, value) VALUES (@ts, 'cpu.load', 0, 1.5)`,
      { ts: now - 10 },
    );
    db.run(
      `INSERT INTO metrics_samples (ts, metric, share_id, value) VALUES (@ts, 'cpu.load', 0, 2.5)`,
      { ts: now - 5 },
    );
    const { agent } = await loginAgent();

    const res = await agent.get('/api/v1/metrics?metric=cpu.load').expect(200);

    expect(res.body.data.series).toHaveLength(1);
    expect(res.body.data.series[0].metric).toBe('cpu.load');
    expect(res.body.data.series[0].shareId).toBeNull();
    expect(res.body.data.series[0].samples).toHaveLength(2);
  });

  it('rejects an unknown metric name', async () => {
    const { agent } = await loginAgent();
    await agent.get('/api/v1/metrics?metric=not.a.metric').expect(400);
  });

  it('defaults to the last hour rather than the whole table', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO metrics_samples (ts, metric, share_id, value) VALUES (@ts, 'cpu.load', 0, 9)`,
      { ts: now - 86_400 },
    );
    const { agent } = await loginAgent();

    const res = await agent.get('/api/v1/metrics').expect(200);

    expect(res.body.data.series).toHaveLength(0);
  });
});

describe('GET /metrics/prometheus', () => {
  it('serves the text exposition with the version-tagged content type', async () => {
    metrics.syncFiles.inc(7, { direction: 'pull' });
    const { agent } = await loginAgent();

    const res = await agent.get('/api/v1/metrics/prometheus').expect(200);

    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');
    expect(res.text).toContain('# TYPE tnc_sync_files_total counter');
    expect(res.text).toContain('tnc_sync_files_total{direction="pull"} 7');
  });

  it('is not wrapped in the API envelope', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/metrics/prometheus').expect(200);
    // A scraper parses the body directly; an envelope would make every line invalid.
    expect(res.text.startsWith('{')).toBe(false);
  });

  it('is reachable with a read-only API token', async () => {
    const token = createToken();

    const res = await request(app)
      .get('/api/v1/metrics/prometheus')
      .set('x-api-key', token)
      .expect(200);

    expect(res.text).toContain('# HELP');
  });
});

describe('GET /metrics/prtg', () => {
  it('serves the sensor payload unwrapped', async () => {
    metrics.locks.set(3);
    const { agent } = await loginAgent();

    const res = await agent.get('/api/v1/metrics/prtg').expect(200);

    // PRTG parses the top-level object and fails on anything else.
    expect(res.body.prtg).toBeDefined();
    expect(res.body.ok).toBeUndefined();
    const locks = res.body.prtg.result.find(
      (c: { channel: string }) => c.channel === 'Active locks',
    );
    expect(locks.value).toBe(3);
  });

  it('is reachable with a read-only API token', async () => {
    const token = createToken();
    const res = await request(app).get('/api/v1/metrics/prtg').set('x-api-key', token).expect(200);
    expect(res.body.prtg.result.length).toBeGreaterThan(0);
  });
});
