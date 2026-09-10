import {
  compareVersions,
  fetchLatestRelease,
  isNewer,
  normaliseVersion,
  pickRelease,
  UpdateCheckError,
} from './github-releases';

describe('normaliseVersion', () => {
  it('drops a leading v so v0.2.0 and 0.2.0 are one release', () => {
    expect(normaliseVersion('v0.2.0')).toBe('0.2.0');
    expect(normaliseVersion('V0.2.0')).toBe('0.2.0');
    expect(normaliseVersion('  0.2.0 ')).toBe('0.2.0');
  });
});

describe('compareVersions', () => {
  it('orders by numeric component, not by string', () => {
    // The bug this guards: '0.10.0' < '0.9.0' under a lexicographic compare, which
    // would hide every release after the ninth.
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
  });

  it('treats a missing component as zero', () => {
    expect(compareVersions('0.2', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.1', '0.2')).toBe(1);
  });
});

describe('isNewer', () => {
  it('is false for the running version', () => {
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
  });

  it('is false for an older release', () => {
    expect(isNewer('0.0.9', '0.1.0')).toBe(false);
  });

  it('is true for a newer release regardless of the v prefix', () => {
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
  });
});

const release = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v0.2.0',
  body: 'notes',
  draft: false,
  prerelease: false,
  published_at: '2026-09-01T10:00:00Z',
  tarball_url: 'https://api.github.com/repos/o/r/tarball/v0.2.0',
  ...overrides,
});

describe('pickRelease', () => {
  it('returns the highest version, not the first in the list', () => {
    const picked = pickRelease(
      [release({ tag_name: 'v0.1.0' }), release({ tag_name: 'v0.3.0' }), release()],
      'stable',
    );
    expect(picked?.version).toBe('0.3.0');
  });

  it('never offers a draft, on either channel', () => {
    expect(pickRelease([release({ draft: true })], 'stable')).toBeNull();
    expect(pickRelease([release({ draft: true })], 'beta')).toBeNull();
  });

  it('hides a pre-release from stable and shows it on beta', () => {
    const releases = [release({ tag_name: 'v0.3.0', prerelease: true }), release()];
    expect(pickRelease(releases, 'stable')?.version).toBe('0.2.0');
    expect(pickRelease(releases, 'beta')?.version).toBe('0.3.0');
  });

  it('skips a release with no tag rather than inventing a version', () => {
    expect(pickRelease([release({ tag_name: undefined })], 'stable')).toBeNull();
  });

  it('reports a null digest, because GitHub publishes none for a source tarball', () => {
    expect(pickRelease([release()], 'stable')?.sha256).toBeNull();
  });

  it('returns null when the repository has published nothing', () => {
    expect(pickRelease([], 'stable')).toBeNull();
  });
});

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as Response;

describe('fetchLatestRelease', () => {
  it('asks GitHub for the configured repository', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse([release()]));
    const result = await fetchLatestRelease({
      repo: 'hsh36/tnc-network-bridge',
      channel: 'stable',
      fetchImpl: fetchImpl,
    });

    expect(result?.version).toBe('0.2.0');
    expect(fetchImpl.mock.calls[0]?.[0]).toContain(
      'https://api.github.com/repos/hsh36/tnc-network-bridge/releases',
    );
  });

  it('rejects a repository that is not an owner/repo pair before making a request', async () => {
    const fetchImpl = jest.fn();
    await expect(
      fetchLatestRelease({
        repo: 'not a repo',
        channel: 'stable',
        fetchImpl: fetchImpl,
      }),
    ).rejects.toThrow(UpdateCheckError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names the repository setting when GitHub answers 404', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404));
    // The operator's most likely mistake is a typo in the repo name, so the message
    // has to point at the field rather than say "request failed".
    await expect(
      fetchLatestRelease({
        repo: 'hsh36/nope',
        channel: 'stable',
        fetchImpl: fetchImpl,
      }),
    ).rejects.toThrow(/Settings > Updates/);
  });

  it('wraps a transport failure in an UpdateCheckError the UI can display', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(
      fetchLatestRelease({
        repo: 'hsh36/tnc-network-bridge',
        channel: 'stable',
        fetchImpl: fetchImpl,
      }),
    ).rejects.toThrow(/Could not reach GitHub: getaddrinfo ENOTFOUND/);
  });

  it('rejects a body that is not a list of releases', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ message: 'rate limited' }));
    await expect(
      fetchLatestRelease({
        repo: 'hsh36/tnc-network-bridge',
        channel: 'stable',
        fetchImpl: fetchImpl,
      }),
    ).rejects.toThrow(UpdateCheckError);
  });

  it('gives up rather than hanging when GitHub does not answer', async () => {
    // A check that never returns leaves the UI spinning forever, and the phase stuck at
    // `checking` blocks every later check.
    const never = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as unknown as typeof fetch;

    await expect(
      fetchLatestRelease({
        repo: 'hsh36/tnc-network-bridge',
        channel: 'stable',
        fetchImpl: never,
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/did not answer in time/);
  });

  it('returns null, not an error, when the repository has no releases yet', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse([]));
    await expect(
      fetchLatestRelease({
        repo: 'hsh36/tnc-network-bridge',
        channel: 'stable',
        fetchImpl: fetchImpl,
      }),
    ).resolves.toBeNull();
  });
});
