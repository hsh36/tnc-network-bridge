import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Express } from 'express';
import request from 'supertest';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../../config/config-manager';
import { type Db } from '../../config/db';
import { runMigrations } from '../../config/migrations/runner';
import { generateSecretKey } from '../../config/secrets';
import { createShareCacheRootResolver } from '../../config/share-paths';
import { JobRegistry } from '../../scheduling/jobs';
import { Scheduler } from '../../scheduling/scheduler';
import { ConflictResolver } from '../../locking/conflict-resolver';
import { LockManager } from '../../locking/lock-manager';
import { AuthLogWriter } from '../../logging/auth-log';
import { AuditLog, installAuditGuards } from '../../security/audit-log';
import { BlobStore } from '../../versioning/blob-store';
import { VersionStore } from '../../versioning/version-store';
import { createApp } from '../app';
import { AuthManager } from '../auth';
import { type AppContext } from '../context';
import { EventBus } from '../event-bus';

/** Exercises `/versions` against real storage — no mocks below the HTTP boundary. */

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let app: Express;
let ctx: AppContext;
let versions: VersionStore;
let cacheRoot: string;
let shareId: number;

async function seedShare(): Promise<void> {
  cacheRoot = join(tmpDir('tnc-route-'), 'cache');
  await mkdir(cacheRoot, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  shareId = Number(
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES ('programs', '//fs/cnc$', '/mnt/tnc-server/programs', @cache, @now, @now)`,
      { now, cache: cacheRoot },
    ).lastInsertRowid,
  );
}

async function captureFile(relPath: string, content: string): Promise<number> {
  const absolute = join(cacheRoot, relPath);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
  const { version } = await versions.capture({
    shareId,
    relPath,
    sourcePath: absolute,
    origin: 'server',
  });
  return version.id;
}

beforeEach(async () => {
  db = tmpDb();
  runMigrations(db);
  installAuditGuards(db);

  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  versions = new VersionStore({ db, blobs: new BlobStore({ root: `${tmpDir()}/versions` }) });

  ctx = {
    db,
    config,
    auth: new AuthManager({ db, config, authLog: new AuthLogWriter(`${tmpDir()}/auth.log`) }),
    locks: new LockManager({ db, config }),
    conflicts: new ConflictResolver(db),
    events: new EventBus(),
    versions,
    schedules: new Scheduler({ db, jobs: new JobRegistry() }),
    audit: new AuditLog(db),
    shareCacheRoot: createShareCacheRootResolver(db),
    certDir: tmpDir(),
    version: '0.0.0-test',
    startedAt: Date.now(),
    now: () => Date.now(),
  };
  app = createApp(ctx);
  await seedShare();
});

afterEach(() => {
  cleanupTmpDbs();
});

interface AuthedAgent {
  readonly agent: ReturnType<typeof request.agent>;
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

describe('GET /versions', () => {
  it('requires credentials', async () => {
    await request(app).get('/api/v1/versions').expect(401);
  });

  it('lists history newest first', async () => {
    await captureFile('P.H', 'V1');
    await captureFile('P.H', 'V2');
    const { agent } = await loginAgent();

    const res = await agent.get(`/api/v1/versions?share=${String(shareId)}&path=P.H`).expect(200);

    expect(res.body.data.total).toBe(2);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.limit).toBeGreaterThan(0);
  });

  it('rejects a malformed pagination parameter', async () => {
    const { agent } = await loginAgent();
    const res = await agent.get('/api/v1/versions?limit=-4').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /versions/:id/download', () => {
  it('returns the stored bytes as an attachment', async () => {
    const id = await captureFile('P.H', 'BEGIN PGM P MM');
    const { agent } = await loginAgent();

    // The response is octet-stream, so superagent needs an explicit binary parser —
    // without one the body is neither `text` nor a parsed object.
    const res = await agent
      .get(`/api/v1/versions/${String(id)}/download`)
      .buffer(true)
      .parse((stream, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('P.H');
    expect((res.body as Buffer).toString('utf8')).toBe('BEGIN PGM P MM');
  });

  it('404s for an unknown version', async () => {
    const { agent } = await loginAgent();
    await agent.get('/api/v1/versions/9999/download').expect(404);
  });

  it('rejects a non-numeric id', async () => {
    const { agent } = await loginAgent();
    await agent.get('/api/v1/versions/abc/download').expect(400);
  });
});

describe('POST /versions/:id/restore', () => {
  it('restores the content and records an audit entry', async () => {
    const id = await captureFile('P.H', 'ORIGINAL');
    await writeFile(join(cacheRoot, 'P.H'), 'EDITED');
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post(`/api/v1/versions/${String(id)}/restore`)
      .set('x-csrf-token', csrf)
      .send({})
      .expect(200);

    expect(res.body.data.restoredTo).toBe('P.H');
    await expect(readFile(join(cacheRoot, 'P.H'), 'utf8')).resolves.toBe('ORIGINAL');

    const audit = ctx.audit?.query({ action: 'version.restore' });
    expect(audit?.total).toBe(1);
  });

  it('refuses without a CSRF token', async () => {
    const id = await captureFile('P.H', 'X');
    const { agent } = await loginAgent();

    await agent
      .post(`/api/v1/versions/${String(id)}/restore`)
      .send({})
      .expect(403);
  });

  it('refuses a target path that escapes the share root', async () => {
    const id = await captureFile('P.H', 'X');
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .post(`/api/v1/versions/${String(id)}/restore`)
      .set('x-csrf-token', csrf)
      .send({ targetPath: '../../etc/cron.d/evil' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /versions/:id/pin', () => {
  it('pins and unpins', async () => {
    const id = await captureFile('P.H', 'X');
    const { agent, csrf } = await loginAgent();

    const pinned = await agent
      .post(`/api/v1/versions/${String(id)}/pin`)
      .set('x-csrf-token', csrf)
      .send({ pinned: true })
      .expect(200);
    expect(pinned.body.data.pinned).toBe(true);

    const unpinned = await agent
      .post(`/api/v1/versions/${String(id)}/pin`)
      .set('x-csrf-token', csrf)
      .send({ pinned: false })
      .expect(200);
    expect(unpinned.body.data.pinned).toBe(false);
  });
});

describe('DELETE /versions/:id', () => {
  it('deletes an unpinned version', async () => {
    const id = await captureFile('P.H', 'DELETE ME');
    const { agent, csrf } = await loginAgent();

    await agent
      .delete(`/api/v1/versions/${String(id)}`)
      .set('x-csrf-token', csrf)
      .expect(200);
    expect(versions.get(id)).toBeUndefined();
  });

  it('refuses to delete a pinned version', async () => {
    const id = await captureFile('P.H', 'PINNED');
    versions.setPinned(id, true);
    const { agent, csrf } = await loginAgent();

    const res = await agent
      .delete(`/api/v1/versions/${String(id)}`)
      .set('x-csrf-token', csrf)
      .expect(409);

    expect(res.body.error.message).toMatch(/Unpin/);
    expect(versions.get(id)).toBeDefined();
  });
});
