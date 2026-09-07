import { existsSync } from 'node:fs';

import {
  BINARIES,
  BinaryNotFoundError,
  CommandError,
  resolveBinary,
  runCommand,
  SAFE_ENV,
} from './exec';

/**
 * `runCommand` is the only place in the product that starts a process. Its contract is
 * short — argv array, absolute path, no shell, fixed environment — and every clause of
 * it is load-bearing, so each is asserted here rather than assumed from the fact that
 * `shell: false` appears in the source.
 */

const onPosix = process.platform !== 'win32';
const describePosix = onPosix ? describe : describe.skip;

/** Picks whichever of the candidate paths this host actually has. */
function firstExisting(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

describe('resolveBinary', () => {
  it('returns the first candidate path that exists', () => {
    const exists = (path: string): boolean => path === '/bin/mount';
    expect(resolveBinary('mount', exists)).toBe('/bin/mount');
  });

  it('prefers the earlier candidate when several exist', () => {
    expect(resolveBinary('mount', () => true)).toBe(BINARIES.mount[0]);
  });

  it('throws BinaryNotFoundError when no candidate exists', () => {
    expect(() => resolveBinary('nft', () => false)).toThrow(BinaryNotFoundError);
    expect(() => resolveBinary('nft', () => false)).toThrow(/nft/);
  });

  it('only ever resolves to absolute paths', () => {
    // A relative candidate would be resolved against PATH by execve, which is the
    // escalation privilege separation exists to prevent.
    for (const candidates of Object.values(BINARIES)) {
      for (const candidate of candidates) {
        expect(candidate.startsWith('/')).toBe(true);
      }
    }
  });
});

describe('runCommand argument guards', () => {
  it('rejects an empty argv', () => {
    expect(() => runCommand([])).toThrow(/at least a command/);
  });

  it('refuses a relative command path', () => {
    expect(() => runCommand(['mount', '-t', 'cifs'])).toThrow(/absolute paths/);
  });

  it('refuses a bare command name that PATH would otherwise resolve', () => {
    expect(() => runCommand(['sh', '-c', 'id'])).toThrow(/absolute paths/);
  });
});

describe('SAFE_ENV', () => {
  it('pins PATH to system directories only', () => {
    expect(SAFE_ENV.PATH).toBe('/usr/sbin:/usr/bin:/sbin:/bin');
  });

  it('forces the C locale so tool output stays parseable', () => {
    expect(SAFE_ENV.LC_ALL).toBe('C');
    expect(SAFE_ENV.LANG).toBe('C');
  });

  it('is frozen, so no caller can widen it at runtime', () => {
    expect(Object.isFrozen(SAFE_ENV)).toBe(true);
  });

  it('carries nothing that could redirect dynamic linking', () => {
    expect(Object.keys(SAFE_ENV)).toEqual(
      expect.not.arrayContaining(['LD_PRELOAD', 'LD_LIBRARY_PATH']),
    );
  });
});

describePosix('runCommand execution', () => {
  const echo = firstExisting(['/bin/echo', '/usr/bin/echo']);
  const env = firstExisting(['/usr/bin/env', '/bin/env']);
  const falseBin = firstExisting(['/bin/false', '/usr/bin/false']);
  const sleep = firstExisting(['/bin/sleep', '/usr/bin/sleep']);

  it('captures stdout and a zero status', () => {
    const result = runCommand([echo!, 'hello']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timedOut).toBe(false);
  });

  /**
   * The central claim of this module. Each payload is passed as one argv element; if
   * any shell were involved the metacharacters would be interpreted instead of echoed.
   */
  it.each([
    ['semicolon chain', '; rm -rf /'],
    ['command substitution', '$(whoami)'],
    ['backtick substitution', '`id`'],
    ['pipe to a shell', '| sh'],
    ['boolean chain', '&& cat /etc/shadow'],
    ['background and chain', '& touch /tmp/pwned'],
    ['redirect', '> /etc/passwd'],
    ['newline injection', 'a\nrm -rf /'],
    ['glob', '/etc/*'],
    ['variable expansion', '$HOME'],
    ['brace expansion', '{a,b}'],
  ])('passes %s through as one literal argument', (_label, payload) => {
    const result = runCommand([echo!, payload]);
    // Echoed verbatim: nothing expanded, substituted, split or executed.
    expect(result.stdout).toBe(`${payload}\n`);
  });

  it('does not split an argument containing spaces, whatever IFS says', () => {
    const result = runCommand([echo!, 'one two three']);
    expect(result.stdout).toBe('one two three\n');
  });

  it('passes only the safe environment to the child', () => {
    const result = runCommand([env!]);
    const names = result.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.slice(0, line.indexOf('=')))
      .sort();
    expect(names).toEqual(['IFS', 'LANG', 'LC_ALL', 'PATH']);
  });

  it('throws CommandError on a non-zero exit by default', () => {
    expect(() => runCommand([falseBin!])).toThrow(CommandError);
  });

  it('exposes the failing result on the thrown error', () => {
    try {
      runCommand([falseBin!]);
      throw new Error('expected a CommandError');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).result.status).toBe(1);
      expect((error as CommandError).result.argv).toEqual([falseBin]);
    }
  });

  it('returns the result instead of throwing when allowFailure is set', () => {
    const result = runCommand([falseBin!], { allowFailure: true });
    expect(result.status).toBe(1);
  });

  it('reports a timeout rather than hanging', () => {
    const result = runCommand([sleep!, '5'], { timeoutMs: 150, allowFailure: true });
    expect(result.timedOut).toBe(true);
  });

  it('feeds stdin when input is supplied', () => {
    const cat = firstExisting(['/bin/cat', '/usr/bin/cat']);
    const result = runCommand([cat!], { input: 'piped payload' });
    expect(result.stdout).toBe('piped payload');
  });
});

describe('no shell is reachable from this module', () => {
  it('lists no shell among the executable binaries', () => {
    const paths = Object.values(BINARIES).flat();
    for (const path of paths) {
      expect(path).not.toMatch(/\/(?:ba|da|z|k)?sh$/);
    }
  });
});
