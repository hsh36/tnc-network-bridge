import { type NetworkInterfaceInfo } from 'node:os';

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
import { createBridgeMetrics } from '../monitoring/registry';
import { JobRegistry } from '../scheduling/jobs';
import { Scheduler } from '../scheduling/scheduler';
import { AuditLog, installAuditGuards } from '../security/audit-log';
import { BlobStore } from '../versioning/blob-store';
import { VersionStore } from '../versioning/version-store';
import { AuthLogWriter } from '../logging/auth-log';
import { AuthManager } from './auth';
import { type AppContext } from './context';
import { EventBus } from './event-bus';
import { addressesOf, managementGuard } from './management-guard';
import { errorHandler } from './middleware';

/**
 * The appliance is configured from the LAN. nftables is what enforces that; this guard
 * is the backstop for a host where the ruleset is not loaded, so the thing under test
 * is: does a request that *did* arrive on the TNC side get refused, and does a LAN one
 * still get through.
 */

let db: Db;
let ctx: AppContext;

function fakeInterfaces(map: Record<string, string[]>): () => NodeJS.Dict<NetworkInterfaceInfo[]> {
  return () =>
    Object.fromEntries(
      Object.entries(map).map(([name, addresses]) => [
        name,
        addresses.map<NetworkInterfaceInfo>((address) => ({
          address,
          family: 'IPv4',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: '255.255.255.0',
          cidr: `${address}/24`,
        })),
      ]),
    );
}

function buildContext(): AppContext {
  const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  installAuditGuards(db);
  return {
    db,
    config,
    // Without an explicit writer this reaches for /var/log/tnc-bridge, which the
    // constructor creates eagerly — fine as root, EACCES on a CI runner.
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
    version: '0.0.0-test',
    startedAt: Date.now(),
    now: () => Date.now(),
  };
}

/**
 * A minimal app whose only middleware is the guard, with the socket's local address
 * forced — supertest connects over loopback, so the address a real TNC request would
 * arrive on has to be simulated.
 */
async function appWithLocalAddress(local: string, read: ReturnType<typeof fakeInterfaces>) {
  const express = (await import('express')).default;
  const app: Express = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'localAddress', { value: local, configurable: true });
    next();
  });
  app.use(managementGuard(ctx, { read }));
  app.get('/probe', (_req, res) => {
    res.json({ reached: true });
  });
  // The real handler, so the refusal is checked as the envelope a caller actually gets
  // rather than as whatever a stand-in happened to emit.
  app.use(errorHandler(ctx));
  return app;
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  ctx = buildContext();
  // The defaults: LAN on eth0, TNC on eth1.
  ctx.config.set('network', {
    lan: { interface: 'eth0', method: 'dhcp' },
    tnc: { interface: 'eth1', method: 'static', address: '192.168.42.1/24' },
  });
});

afterEach(() => {
  cleanupTmpDbs();
});

const INTERFACES = fakeInterfaces({ eth0: ['10.0.0.5'], eth1: ['192.168.42.1'] });

describe('managementGuard', () => {
  it('refuses a request accepted on the TNC address', async () => {
    const app = await appWithLocalAddress('192.168.42.1', INTERFACES);

    const res = await request(app).get('/probe');

    expect(res.status).toBe(403);
  });

  it('lets a request accepted on the LAN address through', async () => {
    const app = await appWithLocalAddress('10.0.0.5', INTERFACES);

    const res = await request(app).get('/probe');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it('sees through the IPv4-mapped form Node reports on a dual-stack listener', async () => {
    const app = await appWithLocalAddress('::ffff:192.168.42.1', INTERFACES);

    // Without normalisation this compares '::ffff:192.168.42.1' against '192.168.42.1'
    // and lets the machine segment straight into the admin interface.
    expect((await request(app).get('/probe')).status).toBe(403);
  });

  it('follows the TNC interface when the configuration moves it', async () => {
    ctx.config.set('network', {
      lan: { interface: 'eth0', method: 'dhcp' },
      tnc: { interface: 'eth2', method: 'static', address: '192.168.42.1/24' },
    });
    const read = fakeInterfaces({ eth0: ['10.0.0.5'], eth2: ['172.20.0.1'] });

    expect(
      (await request(await appWithLocalAddress('172.20.0.1', read)).get('/probe')).status,
    ).toBe(403);
    expect((await request(await appWithLocalAddress('10.0.0.5', read)).get('/probe')).status).toBe(
      200,
    );
  });

  it('records the refusal, because reaching it means the firewall did not', async () => {
    await request(await appWithLocalAddress('192.168.42.1', INTERFACES)).get('/probe');

    const entries = ctx.audit?.query({ action: 'management.access' });
    expect(entries?.items).toHaveLength(1);
    expect(entries?.items[0]?.result).toBe('denied');
  });

  it('allows a request with no local address at all', async () => {
    // A handler invoked directly by a unit test has no socket to judge; refusing there
    // would block every such test and protect nothing.
    const app = await appWithLocalAddress('', INTERFACES);
    expect((await request(app).get('/probe')).status).toBe(200);
  });
});

describe('addressesOf', () => {
  it('collects every address on the interface', () => {
    const read = fakeInterfaces({ eth1: ['192.168.42.1', '192.168.43.1'] });
    expect(addressesOf('eth1', read)).toEqual(new Set(['192.168.42.1', '192.168.43.1']));
  });

  it('is empty for an interface that does not exist', () => {
    expect(addressesOf('eth9', INTERFACES).size).toBe(0);
  });
});
