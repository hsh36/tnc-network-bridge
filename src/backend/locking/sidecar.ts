import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';

/**
 * Advisory sidecar lock files (T24).
 *
 * When a TNC opens a program, the bridge cannot take a real byte-range lock on the
 * *server's* share — it only has a normal SMB session there, like any other client.
 * What it can do is drop a zero-byte marker next to the file, in the style
 * LibreOffice/OpenOffice have used for decades: `.~lock.<name>#`. Any tool that
 * respects the convention (and a human glancing at the directory) sees that the file
 * is in use, without the bridge needing write access to server-side lock state.
 *
 * This is deliberately advisory only. `server_lock_ok` on the lock row records whether
 * the marker was actually written — a failure here (read-only mount, permissions,
 * server unreachable) is surfaced as a warning, never grounds to refuse the lock
 * itself. The lock is real the moment it is a row in `locks`; the sidecar is a courtesy
 * to everyone *outside* the bridge.
 *
 * Paths are handled with `path.posix` throughout: the bridge only ever runs on
 * Raspberry Pi OS, and treating a mount point as a POSIX path avoids the sidecar
 * filename being mangled by a host running this code path in a Windows dev shell.
 */

export class SidecarError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

/** `programs/PART1.H` → `programs/.~lock.PART1.H#`. */
export function sidecarRelPath(relPath: string): string {
  const dir = posix.dirname(relPath);
  const base = posix.basename(relPath);
  const marker = `.~lock.${base}#`;
  return dir === '.' ? marker : posix.join(dir, marker);
}

/** Absolute path of the sidecar under a share's server mount point. */
export function sidecarAbsolutePath(mountPoint: string, relPath: string): string {
  return posix.join(mountPoint, sidecarRelPath(relPath));
}

export interface SidecarWriteResult {
  readonly ok: boolean;
  readonly path: string;
  readonly error?: string;
}

/**
 * Writes the marker, containing a human-readable line rather than nothing — an
 * operator who finds one open in a text viewer should not have to guess what wrote it.
 *
 * The parent directory is not created: it is expected to already exist as part of the
 * mounted share, and creating directories on someone else's file server on a locking
 * failure path is exactly the kind of surprise this module exists to avoid.
 */
export function writeSidecar(
  mountPoint: string,
  relPath: string,
  content: string,
): SidecarWriteResult {
  const target = sidecarAbsolutePath(mountPoint, relPath);
  try {
    writeFileSync(target, content, { flag: 'w' });
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, path: target, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Removes the marker. Missing is success — the lock is gone either way. */
export function removeSidecar(mountPoint: string, relPath: string): SidecarWriteResult {
  const target = sidecarAbsolutePath(mountPoint, relPath);
  try {
    if (existsSync(target)) {
      rmSync(target, { force: true });
    }
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, path: target, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Test/dev helper: ensures a mount point directory tree exists before writing into it. */
export function ensureDirForTest(path: string): void {
  mkdirSync(path, { recursive: true });
}
