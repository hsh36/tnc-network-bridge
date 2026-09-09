import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';

import { cleanupTmpDbs, tmpDir } from '../../tests/support/tmp-db';

import { writeSecretKeyFile } from './config/secrets';
import {
  DEFAULT_HTTPS_PORT,
  PRODUCTION_PATHS,
  type RunningServer,
  STATIC_DIR,
  portFromEnv,
  readPackageVersion,
  startServer,
} from './server';

/**
 * The composition root, exercised the way the service exercises it: a real TLS listener
 * on a real (ephemeral) port, a real SQLite file, a real certificate.
 *
 * These are the failures that only appear once everything is wired together — a manager
 * constructed before the table it reads exists, a shutdown that leaves the port bound —
 * and none of them are visible to a unit test of any single piece.
 */

const INDEX_HTML = '<!doctype html><title>bridge</title><div id="root"></div>';

interface Fetched {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function fetchOverTls(port: number, path: string): Promise<Fetched> {
  return new Promise<Fetched>((resolve, reject) => {
    get({ host: '127.0.0.1', port, path, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).on('error', reject);
  });
}

/** A data root laid out the way the installer lays out the real one. */
function makeRoot(withBundle: boolean): { paths: Parameters<typeof startServer>[0]; root: string } {
  const root = tmpDir('tnc-server-');
  const secretKeyPath = join(root, 'secret.key');
  writeSecretKeyFile(secretKeyPath);

  const staticDir = join(root, 'frontend');
  if (withBundle) {
    mkdirSync(join(staticDir, 'assets'), { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), INDEX_HTML);
    writeFileSync(join(staticDir, 'assets', 'app-abc123.js'), 'console.log(1);\n');
  }

  return {
    root,
    paths: {
      // Port 0 lets the kernel pick; nothing here may depend on 443 being free.
      port: 0,
      host: '127.0.0.1',
      quiet: true,
      ...(withBundle ? { staticDir } : {}),
      paths: {
        dbPath: join(root, 'bridge.db'),
        logDir: join(root, 'log'),
        secretKeyPath,
        certDir: join(root, 'tls'),
        blobRoot: join(root, 'versions'),
        cacheRoot: join(root, 'cache'),
      },
    },
  };
}

let running: RunningServer | undefined;

function boundPort(server: RunningServer): number {
  const address = server.https.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a bound TCP address');
  }
  return address.port;
}

afterEach(async () => {
  await running?.shutdown('test');
  running = undefined;
  cleanupTmpDbs();
});

describe('startServer', () => {
  it('serves the API over TLS once started', async () => {
    const { paths } = makeRoot(false);
    running = await startServer(paths);

    const response = await fetchOverTls(boundPort(running), '/api/v1/status');

    // Unauthenticated, so 401 rather than 200 — what matters is that the route module is
    // mounted and answering, not that it lets us in.
    expect([200, 401]).toContain(response.status);
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it('answers an unknown API path with the JSON error envelope, not HTML', async () => {
    const { paths } = makeRoot(true);
    running = await startServer(paths);

    const response = await fetchOverTls(boundPort(running), '/api/v1/no-such-endpoint');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('serves the admin UI bundle and falls back to it for client-side routes', async () => {
    const { paths } = makeRoot(true);
    running = await startServer(paths);
    const port = boundPort(running);

    const root = await fetchOverTls(port, '/');
    expect(root.status).toBe(200);
    expect(root.body).toContain('<div id="root">');
    // The entry point must never be cached, or an update leaves operators on the old
    // bundle until they clear their browser.
    expect(root.headers['cache-control']).toBe('no-cache');

    // A deep link is the case that breaks without an SPA fallback.
    const deepLink = await fetchOverTls(port, '/config/network');
    expect(deepLink.status).toBe(200);
    expect(deepLink.body).toContain('<div id="root">');

    const asset = await fetchOverTls(port, '/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('generates a self-signed certificate on first start and reuses it after', async () => {
    const { paths } = makeRoot(false);

    running = await startServer(paths);
    const first = await fetchCertificateFingerprint(boundPort(running));
    await running.shutdown('restart');

    running = await startServer(paths);
    const second = await fetchCertificateFingerprint(boundPort(running));

    expect(second).toBe(first);
  });

  it('releases the port on shutdown so a restart can rebind it', async () => {
    const { paths } = makeRoot(false);
    running = await startServer(paths);
    const port = boundPort(running);

    await running.shutdown('test');
    running = undefined;

    // Rebinding the very same port is the assertion: a listener left open would make
    // this throw EADDRINUSE, which is exactly the restart loop this guards against.
    running = await startServer({ ...paths, port });
    expect(boundPort(running)).toBe(port);
  });

  it('is safe to shut down twice', async () => {
    const { paths } = makeRoot(false);
    const server = await startServer(paths);

    await server.shutdown('first');
    await expect(server.shutdown('second')).resolves.toBeUndefined();
  });

  it('refuses to start when the admin UI bundle is missing', async () => {
    const { paths, root } = makeRoot(false);

    await expect(startServer({ ...paths, staticDir: join(root, 'frontend') })).rejects.toThrow(
      /admin UI bundle is missing/,
    );
  });

  it('leaves nothing running when startup fails after the database is open', async () => {
    const { paths, root } = makeRoot(false);

    await expect(startServer({ ...paths, staticDir: join(root, 'frontend') })).rejects.toThrow();

    // The failed attempt must not keep the database file open, or systemd's restart hits
    // a locked database instead of the error the operator needs to see. Deleting the
    // whole data root is the portable way to assert no handle survived.
    expect(() => rmSync(root, { recursive: true })).not.toThrow();
    expect(existsSync(root)).toBe(false);
  });

  it('publishes lock changes onto the event stream', async () => {
    const { paths } = makeRoot(false);
    running = await startServer(paths);
    const { db, locks, events, now } = running.context;

    expect(now()).toBeGreaterThan(0);

    const shareId = Number(
      db.run(
        `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
         VALUES (@name, @unc, @mount, @cache, @ts, @ts)`,
        {
          name: 'programs',
          unc: '//fileserver/cnc$/programs',
          mount: '/mnt/programs',
          cache: '/srv/tnc/programs',
          ts: Math.floor(Date.now() / 1000),
        },
      ).lastInsertRowid,
    );

    const seen: string[] = [];
    const unsubscribe = events.subscribe((_id, event) => seen.push(event.type));

    locks.acquire({ shareId, relPath: 'part.h', origin: 'manual' });
    unsubscribe();

    // The subscription is what the dashboard's SSE stream is built on: a lock taken on a
    // TNC has to reach an open browser without it polling for it.
    expect(seen).toContain('lock');
  });

  it('emits a heartbeat on the interval it was given', async () => {
    const { paths } = makeRoot(false);
    running = await startServer({ ...paths, heartbeatIntervalMs: 20 });

    const beat = await new Promise<string>((resolve) => {
      const unsubscribe = running?.context.events.subscribe((_id, event) => {
        if (event.type === 'heartbeat') {
          unsubscribe?.();
          resolve(event.type);
        }
      });
    });

    expect(beat).toBe('heartbeat');
  });

  it('answers with an error rather than a truncated page if the bundle vanishes', async () => {
    const { paths, root } = makeRoot(true);
    running = await startServer(paths);
    const port = boundPort(running);

    rmSync(join(root, 'frontend', 'index.html'));
    const response = await fetchOverTls(port, '/config/network');

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('portFromEnv', () => {
  it('defaults to 443 when the variable is absent or empty', () => {
    expect(portFromEnv({})).toBe(DEFAULT_HTTPS_PORT);
    expect(portFromEnv({ TNC_HTTPS_PORT: '' })).toBe(DEFAULT_HTTPS_PORT);
    expect(portFromEnv({ TNC_HTTPS_PORT: '   ' })).toBe(DEFAULT_HTTPS_PORT);
  });

  it('accepts a valid port', () => {
    expect(portFromEnv({ TNC_HTTPS_PORT: '8443' })).toBe(8443);
    expect(portFromEnv({ TNC_HTTPS_PORT: '1' })).toBe(1);
    expect(portFromEnv({ TNC_HTTPS_PORT: '65535' })).toBe(65_535);
  });

  it.each(['0', '65536', '-1', 'https', '8443.5', '84 43'])(
    'refuses %p rather than silently falling back to 443',
    (value) => {
      // Falling back would report a healthy service on a port the operator deliberately
      // avoided — the one outcome worse than not starting at all.
      expect(() => portFromEnv({ TNC_HTTPS_PORT: value })).toThrow(/TNC_HTTPS_PORT/);
    },
  );
});

describe('STATIC_DIR', () => {
  it('resolves to the frontend bundle beside the compiled backend', () => {
    // At runtime this module lives in dist/backend, so its sibling is dist/frontend.
    // Under ts-jest it lives in src/backend and the same expression names src/frontend —
    // the relationship is what matters, and it holds in both trees.
    expect(STATIC_DIR).toBe(join(__dirname, '..', 'frontend'));
    expect(existsSync(STATIC_DIR)).toBe(true);
  });
});

function fetchCertificateFingerprint(port: number): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      socket.end();
      resolve(fingerprint);
    });
    socket.on('error', reject);
  });
}

describe('PRODUCTION_PATHS', () => {
  it('points at the directories the installer creates and the unit allows writing', () => {
    expect(PRODUCTION_PATHS.dbPath.startsWith('/var/lib/tnc-bridge/')).toBe(true);
    expect(PRODUCTION_PATHS.blobRoot.startsWith('/var/lib/tnc-bridge/')).toBe(true);
    expect(PRODUCTION_PATHS.logDir).toBe('/var/log/tnc-bridge');
    expect(PRODUCTION_PATHS.certDir.startsWith('/etc/tnc-bridge')).toBe(true);
    expect(PRODUCTION_PATHS.cacheRoot).toBe('/srv/tnc');
  });
});

describe('readPackageVersion', () => {
  const originalEnv = process.env.npm_package_version;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.npm_package_version;
    } else {
      process.env.npm_package_version = originalEnv;
    }
  });

  it('prefers the npm-provided version when there is one', () => {
    process.env.npm_package_version = '9.9.9';
    expect(readPackageVersion()).toBe('9.9.9');
  });

  it('reads package.json when npm is not the parent process', () => {
    delete process.env.npm_package_version;
    const dir = tmpDir('tnc-version-');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    expect(readPackageVersion(dir)).toBe('1.2.3');
  });

  it('falls back rather than throwing when package.json is unreadable', () => {
    delete process.env.npm_package_version;
    expect(readPackageVersion(tmpDir('tnc-version-'))).toBe('0.0.0-unknown');
  });
});
