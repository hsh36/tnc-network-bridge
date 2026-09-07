import { PRODUCT_NAME } from '../shared/constants';

/**
 * Service entrypoint.
 *
 * This is a placeholder that proves the backend project builds and can reach `src/shared`.
 * The DI container, ordered subsystem startup/shutdown, SIGTERM drain and systemd watchdog
 * land in T8.
 */
export function describeService(): string {
  return `${PRODUCT_NAME} backend`;
}

if (require.main === module) {
  process.stdout.write(`${describeService()} — not yet implemented (see T8)\n`);
}
