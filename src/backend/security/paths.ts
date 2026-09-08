import { isAbsolute, normalize, resolve, sep } from 'node:path';

/**
 * Path containment (T43).
 *
 * Every place the API turns operator-supplied text into a filesystem path goes through
 * here. That is the point: path traversal is not prevented by being careful at each call
 * site, it is prevented by there being exactly one call site's worth of logic and every
 * caller using it.
 *
 * ## Why the check is on the resolved path
 *
 * Rejecting strings that *contain* `..` is the common implementation and it is both too
 * strict and too weak. Too strict, because `..keep.H` is a perfectly ordinary filename
 * on a TNC. Too weak, because containment is a property of where a path *lands*, and
 * there are several ways to land outside a root without a leading `..`:
 *
 * - `a/../../b` normalises to an escape while starting with a normal segment.
 * - An absolute path ignores the root entirely.
 * - On Windows, `C:foo` is drive-relative and resolves against that drive's cwd.
 * - A NUL byte truncates the path at the syscall boundary, so `safe.h\0../../etc/passwd`
 *   can pass a string check and open something else entirely.
 *
 * Resolving first and then asserting the result is under the root handles all of them,
 * because it asks the question that actually matters.
 *
 * ## What this does not do
 *
 * It does not follow symlinks. A symlink inside the root pointing outside it still
 * resolves to an in-root path here, and defending against that requires `realpath` on a
 * file that may not exist yet. The bridge's cache directories are created and owned by
 * the service and are not writable by the TNC share as a general filesystem, so a
 * hostile symlink would have to be placed by something that already has more access than
 * this check could take away.
 */

export class PathTraversalError extends Error {
  constructor(
    readonly attempted: string,
    readonly root: string,
  ) {
    super(`Path escapes its root: ${JSON.stringify(attempted)}`);
    this.name = 'PathTraversalError';
  }
}

/** True when `candidate` is `root` itself or lies beneath it. */
export function isWithin(root: string, candidate: string): boolean {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(absoluteRoot + sep);
}

/**
 * Resolves a relative path inside `root`, throwing if it would escape.
 *
 * Returns an absolute path, so callers cannot accidentally re-join it against something
 * else and undo the check.
 */
export function safeResolve(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new PathTraversalError(String(relPath), root);
  }
  // A NUL truncates at the syscall boundary: the string checked and the path opened
  // would be different things.
  if (relPath.includes('\0')) {
    throw new PathTraversalError(relPath, root);
  }
  if (isAbsolute(relPath)) {
    throw new PathTraversalError(relPath, root);
  }
  // Windows drive-relative form (`C:foo`) resolves against that drive's current
  // directory rather than the root, so it is refused outright.
  if (/^[A-Za-z]:/.test(relPath)) {
    throw new PathTraversalError(relPath, root);
  }

  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, normalize(relPath));

  if (!isWithin(absoluteRoot, candidate)) {
    throw new PathTraversalError(relPath, root);
  }
  return candidate;
}

/**
 * Like {@link safeResolve} but returns `null` instead of throwing.
 *
 * For paths that arrive in bulk — a scan result, a batch of watcher events — where one
 * bad entry should be skipped and counted, not turned into an exception per file.
 */
export function trySafeResolve(root: string, relPath: string): string | null {
  try {
    return safeResolve(root, relPath);
  } catch {
    return null;
  }
}

/**
 * Rejects a share-relative path that no SMB client could legitimately produce.
 *
 * Applied to names before they reach the index, so a crafted filename cannot become a
 * surprise later. Windows reserved device names are included: a file called `CON` or
 * `LPT1` on the Linux side is legal, but writing it to a Windows client can hang the
 * client on open, which is a denial of service delivered by filename.
 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

export function isSuspiciousName(name: string): boolean {
  return (
    name.length === 0 ||
    name.includes('\0') ||
    name === '.' ||
    name === '..' ||
    WINDOWS_RESERVED.test(name) ||
    // Trailing dots and spaces are silently stripped by Windows, so two distinct Linux
    // filenames can collide into one on the TNC side.
    /[. ]$/.test(name)
  );
}
