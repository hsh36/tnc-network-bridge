import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PRODUCT_NAME } from '../shared/constants';

import { writeSecretKeyFile } from './config/secrets';
import { bootstrapLogger, installSignalHandlers } from './index';
import { startServer } from './server';

/**
 * Development entrypoint.
 *
 * The wiring itself lives in `server.ts` and is shared with the systemd service, so that
 * what `npm run dev` exercises is the same composition root that ships. This file only
 * substitutes the two things that legitimately differ in development: a data directory
 * under the working tree instead of `/var/lib` and friends, and an unprivileged port.
 *
 * The frontend is deliberately not served from here — Vite serves it and proxies the API
 * to `https://127.0.0.1:8443` (`vite.config.ts`), which is what makes hot reload work.
 */

const DEV_ROOT = join(process.cwd(), '.dev-data');
const DEV_HTTPS_PORT = Number(process.env.TNC_DEV_PORT ?? 8443);

async function main(): Promise<void> {
  const boot = bootstrapLogger(false);
  const secretKeyPath = join(DEV_ROOT, 'secret.key');

  // Generated on demand here and nowhere else. In production the installer creates the
  // key once; a service that quietly minted a new one on a failed read would not recover
  // from a missing mount, it would turn every stored credential into undecryptable bytes.
  if (!existsSync(secretKeyPath)) {
    writeSecretKeyFile(secretKeyPath);
    boot.info('generated a development secret key', { path: secretKeyPath });
  }

  const running = await startServer({
    port: DEV_HTTPS_PORT,
    paths: {
      dbPath: join(DEV_ROOT, 'tnc-bridge.db'),
      logDir: join(DEV_ROOT, 'log'),
      secretKeyPath,
      certDir: join(DEV_ROOT, 'tls'),
      blobRoot: join(DEV_ROOT, 'versions'),
      cacheRoot: join(DEV_ROOT, 'cache'),
    },
  });

  boot.info(`${PRODUCT_NAME} dev server listening`, {
    url: `https://127.0.0.1:${running.port}`,
    dataDir: DEV_ROOT,
  });

  installSignalHandlers(
    { shutdown: (reason) => running.shutdown(reason) },
    { logger: boot, onComplete: () => process.exit(0) },
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${PRODUCT_NAME} dev server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
