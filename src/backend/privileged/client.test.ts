import { spawnSync } from 'node:child_process';

import {
  HELPER_PATH,
  invokePrivileged,
  PrivilegedCallError,
  SUDO_PATH,
} from './client';

jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));

const spawnSyncMock = spawnSync as unknown as jest.Mock;

/**
 * The client is the only place in the service that reaches for root. These tests pin
 * how it invokes sudo — argv array, `-n`, stripped environment — and how it behaves
 * when the helper refuses, because "the helper said no" must surface as a typed error
 * rather than a silent no-op that leaves the caller believing a mount happened.
 */

function reply(stdout: string, status = 0, stderr = ''): void {
  spawnSyncMock.mockReturnValue({ stdout, stderr, status, error: undefined });
}

const REQUEST = { verb: 'reload-samba', mode: 'reload' } as const;

describe('invokePrivileged', () => {
  it('invokes sudo with the helper as an argv array and no shell', () => {
    reply('{"ok":true,"verb":"reload-samba"}\n');
    invokePrivileged(REQUEST);

    const [command, args, options] = spawnSyncMock.mock.calls[0]!;
    expect(command).toBe(SUDO_PATH);
    expect(args).toEqual(['-n', HELPER_PATH]);
    expect(options.shell).toBe(false);
  });

  /** Without `-n`, a broken sudoers rule hangs the caller on a prompt nothing will answer. */
  it('passes -n so sudo never waits for a password', () => {
    reply('{"ok":true}');
    invokePrivileged(REQUEST);
    expect(spawnSyncMock.mock.calls[0]![1]).toContain('-n');
  });

  it('sends the request as JSON on stdin, not as arguments', () => {
    reply('{"ok":true}');
    invokePrivileged(REQUEST);
    const options = spawnSyncMock.mock.calls[0]![2];
    expect(JSON.parse(options.input)).toMatchObject({ verb: 'reload-samba' });
    expect(spawnSyncMock.mock.calls[0]![1]).toHaveLength(2);
  });

  it('does not forward the caller environment to a root process', () => {
    reply('{"ok":true}');
    invokePrivileged(REQUEST);
    const options = spawnSyncMock.mock.calls[0]![2];
    expect(Object.keys(options.env).sort()).toEqual(['LC_ALL', 'PATH']);
  });

  it('returns the parsed success envelope', () => {
    reply('{"ok":true,"verb":"reload-samba","detail":{"mode":"reload"}}\n');
    expect(invokePrivileged(REQUEST)).toMatchObject({ ok: true, detail: { mode: 'reload' } });
  });

  /** Validating locally saves a sudo round-trip and gives the caller a usable message. */
  it('rejects a malformed request before spawning anything', () => {
    reply('{"ok":true}');
    expect(() =>
      invokePrivileged({ verb: 'service-restart', service: 'sshd' } as never),
    ).toThrow(/is not an allowed unit/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('raises a typed error when the helper denies the request', () => {
    reply('{"ok":false,"error":"unmount-share: shareName: bad","code":"denied"}', 2);
    try {
      invokePrivileged(REQUEST);
      throw new Error('expected a PrivilegedCallError');
    } catch (error) {
      expect(error).toBeInstanceOf(PrivilegedCallError);
      expect((error as PrivilegedCallError).code).toBe('denied');
      expect((error as PrivilegedCallError).exitCode).toBe(2);
    }
  });

  it('defaults the error code when the helper omits one', () => {
    reply('{"ok":false}', 3);
    expect(() => invokePrivileged(REQUEST)).toThrow(/unspecified failure/);
  });

  it('reports an unavailable helper when sudo cannot be started', () => {
    spawnSyncMock.mockReturnValue({ error: new Error('ENOENT'), stdout: '', stderr: '', status: null });
    expect(() => invokePrivileged(REQUEST)).toThrow(/could not invoke the privileged helper/);
  });

  /** A sudoers misconfiguration produces sudo's own text on stderr and nothing on stdout. */
  it('reports unparseable output with the helper stderr attached', () => {
    reply('', 1, 'sudo: a password is required');
    try {
      invokePrivileged(REQUEST);
      throw new Error('expected a PrivilegedCallError');
    } catch (error) {
      expect((error as PrivilegedCallError).code).toBe('unavailable');
      expect((error as Error).message).toMatch(/a password is required/);
    }
  });

  it('says so explicitly when there is no stderr either', () => {
    reply('not json', 1, '');
    expect(() => invokePrivileged(REQUEST)).toThrow(/<no stderr>/);
  });

  it('honours overridden paths, so an installer can verify a staged helper', () => {
    reply('{"ok":true}');
    invokePrivileged(REQUEST, { sudoPath: '/opt/sudo', helperPath: '/opt/helper', timeoutMs: 5 });
    expect(spawnSyncMock.mock.calls[0]![0]).toBe('/opt/sudo');
    expect(spawnSyncMock.mock.calls[0]![1]).toEqual(['-n', '/opt/helper']);
    expect(spawnSyncMock.mock.calls[0]![2].timeout).toBe(5);
  });
});
