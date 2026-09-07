import { spawnSync } from 'node:child_process';

import { type HelperResponse } from './main';
import { type PrivilegedRequest, validateRequest } from './verbs';

/**
 * The unprivileged side of the boundary.
 *
 * Everything in the service that needs root goes through `invokePrivileged`. There is
 * deliberately no other path — the ESLint `no-restricted-syntax` rule bans
 * `child_process.exec`, and this is the only module that spawns `sudo`.
 *
 * Note the client validates the request before sending it. That check is a convenience
 * so callers get a clear error in-process rather than an opaque exit code; it is **not**
 * a control. The helper validates again on the far side, and that is the check that
 * counts, because an attacker who has RCE in this process simply does not call this
 * function.
 */

export const SUDO_PATH = '/usr/bin/sudo';
export const HELPER_PATH = '/usr/local/lib/tnc-bridge/helper';

export class PrivilegedCallError extends Error {
  constructor(
    message: string,
    readonly code: 'denied' | 'failed' | 'usage' | 'unavailable',
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'PrivilegedCallError';
  }
}

export interface InvokeOptions {
  readonly timeoutMs?: number;
  readonly sudoPath?: string;
  readonly helperPath?: string;
}

export type HelperInvoker = (request: PrivilegedRequest, options?: InvokeOptions) => HelperResponse;

const DEFAULT_TIMEOUT_MS = 120_000;

export const invokePrivileged: HelperInvoker = (request, options = {}) => {
  // Throws locally on a malformed request rather than burning a sudo call on it.
  validateRequest(request);

  const sudo = options.sudoPath ?? SUDO_PATH;
  const helper = options.helperPath ?? HELPER_PATH;

  const spawned = spawnSync(sudo, ['-n', helper], {
    shell: false,
    encoding: 'utf8',
    input: JSON.stringify(request),
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    // `-n` means sudo never prompts. Without it a misconfigured sudoers rule would hang
    // the caller on a password prompt reading from a pipe that will never answer.
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
  });

  if (spawned.error !== undefined) {
    throw new PrivilegedCallError(
      `could not invoke the privileged helper: ${spawned.error.message}`,
      'unavailable',
      -1,
    );
  }

  const stdout = spawned.stdout ?? '';
  let parsed: HelperResponse | undefined;
  try {
    parsed = JSON.parse(stdout.trim()) as HelperResponse;
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined) {
    throw new PrivilegedCallError(
      `the privileged helper returned no parseable response (exit ${spawned.status ?? -1}): ` +
        `${(spawned.stderr ?? '').trim() || '<no stderr>'}`,
      'unavailable',
      spawned.status ?? -1,
    );
  }

  if (!parsed.ok) {
    throw new PrivilegedCallError(
      parsed.error ?? 'the privileged helper reported an unspecified failure',
      parsed.code ?? 'failed',
      spawned.status ?? -1,
    );
  }

  return parsed;
};
