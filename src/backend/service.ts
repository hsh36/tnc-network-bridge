import { PRODUCT_NAME } from '../shared/constants';

import { bootstrapLogger, installSignalHandlers } from './index';
import { STATIC_DIR, portFromEnv, startServer } from './server';

/**
 * The production entrypoint — what `ExecStart` in the systemd unit points at.
 *
 * `index.ts` stays the lifecycle core and the `--check` self-test, `server.ts` holds the
 * wiring, and this file is only the process wrapper around them: listen, install signal
 * handlers, and turn a startup failure into an exit code systemd can act on.
 */

/* c8 ignore start -- process bootstrap; exercised by running the service. */
async function main(): Promise<void> {
  const boot = bootstrapLogger(false);
  const running = await startServer({ port: portFromEnv(), staticDir: STATIC_DIR });

  boot.info(`${PRODUCT_NAME} listening`, { port: running.port });

  installSignalHandlers(
    { shutdown: (reason) => running.shutdown(reason) },
    { logger: boot, onComplete: () => process.exit(0) },
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${PRODUCT_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
