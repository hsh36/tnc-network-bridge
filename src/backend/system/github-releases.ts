/**
 * Asking GitHub what the newest release is.
 *
 * Kept apart from {@link UpdateManager} so the comparison rules can be tested without a
 * network, and so the manager holds state rather than protocol knowledge.
 */

export interface ReleaseInfo {
  readonly version: string;
  readonly channel: 'stable' | 'beta';
  readonly publishedAt: number;
  readonly notes: string;
  readonly assetUrl: string;
  readonly assetSize: number;
  readonly sha256: string | null;
}

/** The subset of the GitHub Releases payload this needs. */
interface GithubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  tarball_url?: unknown;
  assets?: unknown;
}

export class UpdateCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateCheckError';
  }
}

/** `v0.2.0` and `0.2.0` are the same release; the tag convention is not ours to enforce. */
export function normaliseVersion(tag: string): string {
  return tag.trim().replace(/^v/i, '');
}

/**
 * Compares two dotted versions numerically, longest-wins on a tie.
 *
 * Deliberately not a full semver implementation. The only question asked of it is "is
 * the release newer than what is installed", and a pre-release suffix is answered by
 * the channel rather than by precedence rules — a beta is offered on the beta channel
 * and not on stable, whatever its number says.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    normaliseVersion(value)
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isNaN(part) ? 0 : part));

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0 ? 1 : -1;
    }
  }
  return 0;
}

/** True when `candidate` is strictly newer than `installed`. */
export function isNewer(candidate: string, installed: string): boolean {
  return compareVersions(candidate, installed) > 0;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Picks the release to offer.
 *
 * Drafts are never offered — they are not published. Pre-releases are offered on the
 * beta channel only, which is the whole meaning of the channel: an operator on stable
 * has said they do not want to be the one who finds the problem.
 */
export function pickRelease(
  releases: readonly GithubRelease[],
  channel: 'stable' | 'beta',
): ReleaseInfo | null {
  const candidates = releases
    .filter((release) => release.draft !== true)
    .filter((release) => channel === 'beta' || release.prerelease !== true)
    .map((release): ReleaseInfo | null => {
      const tag = asString(release.tag_name);
      if (tag === '') {
        return null;
      }
      const published = Date.parse(asString(release.published_at));
      return {
        version: normaliseVersion(tag),
        channel: release.prerelease === true ? 'beta' : 'stable',
        publishedAt: Number.isNaN(published) ? 0 : Math.floor(published / 1000),
        notes: asString(release.body),
        assetUrl: asString(release.tarball_url),
        assetSize: 0,
        // GitHub does not publish a digest for the source tarball. Null rather than
        // invented: a checksum nobody computed is worse than none, because the verify
        // step would then compare a value against itself and always pass.
        sha256: null,
      };
    })
    .filter((release): release is ReleaseInfo => release !== null);

  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((newest, release) =>
    compareVersions(release.version, newest.version) > 0 ? release : newest,
  );
}

export interface FetchReleasesOptions {
  readonly repo: string;
  readonly channel: 'stable' | 'beta';
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * The newest release GitHub offers for `repo`, or `null` when it publishes none.
 *
 * Unauthenticated: this is a public repository and the appliance holds no token. That
 * caps the rate at sixty requests an hour from one address, which a bridge checking on
 * a weekly schedule will never approach.
 */
export async function fetchLatestRelease(
  options: FetchReleasesOptions,
): Promise<ReleaseInfo | null> {
  if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(options.repo)) {
    throw new UpdateCheckError(`"${options.repo}" is not an owner/repo pair`);
  }

  const call = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const response = await call(
      `https://api.github.com/repos/${options.repo}/releases?per_page=30`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'tnc-network-bridge',
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new UpdateCheckError(
        `GitHub answered ${String(response.status)} for ${options.repo}. ` +
          (response.status === 404
            ? 'Check the repository name in Settings > Updates.'
            : 'Try again later.'),
      );
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new UpdateCheckError('GitHub returned something that is not a list of releases');
    }
    return pickRelease(payload as GithubRelease[], options.channel);
  } catch (error) {
    if (error instanceof UpdateCheckError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UpdateCheckError('GitHub did not answer in time');
    }
    throw new UpdateCheckError(
      `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
