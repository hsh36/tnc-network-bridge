'use strict';

/**
 * The scan walk (T15) — the half of the server scanner that must not run on the main thread.
 *
 * ## Why this file is CommonJS and not TypeScript
 *
 * A `worker_threads` Worker loads a *runtime* module. It gets no ts-jest transform, no
 * tsx loader and no build step of its own, so a `.ts` entry point would work in
 * production and fail in the test suite — which is precisely the wrong way round for the
 * one mechanism whose acceptance criterion is "worker thread isolation proven". Plain
 * CommonJS loads identically from `src/` under Jest, under `tsx watch`, and from
 * `dist/` in production (`scripts/copy-assets.mjs` copies it), so the thing the tests
 * exercise is the thing that ships.
 *
 * It is kept deliberately small for the same reason: only the recursive `readdir`+`stat`
 * walk lives here. Diffing, generation accounting, case-collision detection and interval
 * adaptation are all in `server-scanner.ts`, in TypeScript, where they can be typed and
 * tested as pure logic. The shapes crossing the thread boundary are declared once, in
 * `server-scanner.ts`, and referenced from the JSDoc here.
 *
 * ## Why the walk is worth isolating at all (risk R3)
 *
 * The directory being walked is a CIFS mount. When the server behind it goes away
 * mid-walk, `readdir` and `stat` do not fail promptly — they block in uninterruptible
 * kernel I/O for as long as the mount's timeout allows. On the main thread that stalls
 * every HTTP request, every watchdog ping and every other share. On a worker it stalls
 * one thread that the parent can simply terminate.
 */

const { readdir, stat } = require('node:fs/promises');
const { isMainThread, parentPort, threadId, workerData } = require('node:worker_threads');
const picomatch = require('picomatch');

/** Entries per posted chunk. Bounded so neither side ever holds the whole tree. */
const DEFAULT_CHUNK_SIZE = 1000;

/**
 * Errors that mean "this entry is not walkable", never "the walk is broken".
 *
 * A file deleted between `readdir` and `stat` is entirely normal on a live share, and a
 * directory the service account cannot read is a configuration matter, not a scan
 * failure. Both are counted and skipped. Anything else propagates, because a walk that
 * quietly swallows an unknown error reports a short tree — and a short tree, to the
 * generation-based deletion detector upstream, is indistinguishable from mass deletion.
 */
const SKIPPABLE = new Set(['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'EBUSY']);

/** @param {unknown} error @returns {string} */
function codeOf(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(/** @type {{ code?: unknown }} */ (error).code)
    : '';
}

/**
 * Walks `root` breadth-first, emitting entries in bounded chunks.
 *
 * @param {import('./server-scanner').WalkRequest} request
 * @param {(chunk: import('./server-scanner').ScanEntry[]) => void} onChunk
 * @returns {Promise<import('./server-scanner').WalkStats>}
 */
async function walk(request, onChunk) {
  const startedAt = Date.now();
  const chunkSize = request.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const excludes = request.excludes ?? [];
  const maxEntries = request.maxEntries ?? Number.POSITIVE_INFINITY;

  // One matcher for the whole walk. `dot: true` because a pattern list that silently
  // ignored dotfiles would leave `.tnc-tmp-*` transfer temporaries in the index.
  const isExcluded =
    excludes.length > 0 ? picomatch(excludes, { dot: true, nocase: true }) : () => false;

  /** @type {import('./server-scanner').ScanEntry[]} */
  let chunk = [];
  let files = 0;
  let directories = 0;
  let skipped = 0;
  let excluded = 0;
  let truncated = false;

  /** @param {import('./server-scanner').ScanEntry} entry */
  const emit = (entry) => {
    chunk.push(entry);
    if (chunk.length >= chunkSize) {
      onChunk(chunk);
      chunk = [];
    }
  };

  // An explicit queue rather than recursion: a deeply nested tree from an untrusted
  // share must not be able to exhaust the call stack.
  /** @type {Array<{ absolute: string, relative: string }>} */
  const queue = [{ absolute: request.root, relative: '' }];

  // The root itself must be readable. Failing here throws — see SKIPPABLE.
  await stat(request.root);

  while (queue.length > 0) {
    const dir = /** @type {{ absolute: string, relative: string }} */ (queue.shift());

    /** @type {import('node:fs').Dirent[]} */
    let dirents;
    try {
      dirents = await readdir(dir.absolute, { withFileTypes: true });
    } catch (error) {
      if (dir.relative === '' || !SKIPPABLE.has(codeOf(error))) {
        throw error;
      }
      skipped += 1;
      continue;
    }

    for (const dirent of dirents) {
      // Relative paths are POSIX-shaped on every platform: they are the key of the
      // file index and travel to SQLite, the API and the frontend, so they cannot
      // change spelling with the host OS.
      const relative = dir.relative === '' ? dirent.name : `${dir.relative}/${dirent.name}`;
      const absolute = `${dir.absolute}/${dirent.name}`;

      if (isExcluded(relative)) {
        excluded += 1;
        // Not descending is the point: excluding a directory must cost nothing, or a
        // large excluded tree still pays for the walk it was excluded to avoid.
        continue;
      }

      // Symlinks are reported by `readdir` but never followed: a link on the server
      // share pointing at `/` would otherwise turn one scan into an unbounded one.
      if (dirent.isSymbolicLink()) {
        skipped += 1;
        continue;
      }

      if (dirent.isDirectory()) {
        directories += 1;
        emit({ relPath: relative, isDir: true, size: 0, mtimeMs: 0 });
        queue.push({ absolute, relative });
        continue;
      }

      if (!dirent.isFile()) {
        // Sockets, FIFOs and devices are not programs and have no meaningful contents
        // to sync; a Samba share should not contain them at all.
        skipped += 1;
        continue;
      }

      let stats;
      try {
        stats = await stat(absolute);
      } catch (error) {
        if (!SKIPPABLE.has(codeOf(error))) {
          throw error;
        }
        skipped += 1;
        continue;
      }

      files += 1;
      emit({
        relPath: relative,
        isDir: false,
        size: stats.size,
        // Milliseconds, floored: SMB and ext4 disagree about sub-millisecond
        // resolution, and a fractional mtime makes two consecutive scans of an
        // untouched file compare unequal.
        mtimeMs: Math.floor(stats.mtimeMs),
      });

      if (files + directories >= maxEntries) {
        truncated = true;
        queue.length = 0;
        break;
      }
    }
  }

  if (chunk.length > 0) {
    onChunk(chunk);
  }

  return {
    files,
    directories,
    skipped,
    excluded,
    truncated,
    durationMs: Date.now() - startedAt,
    threadId,
  };
}

module.exports = { walk, DEFAULT_CHUNK_SIZE };

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------
//
// Guarded twice. `isMainThread` keeps a plain `require()` of this module from trying to
// post messages, and the `workerData` shape keeps it inert if some other part of the
// process ever loads it inside an unrelated worker.
if (!isMainThread && parentPort !== null && workerData !== null && workerData !== undefined) {
  const port = parentPort;
  walk(workerData, (chunk) => {
    port.postMessage({ type: 'chunk', entries: chunk });
  }).then(
    (stats) => {
      port.postMessage({ type: 'done', stats });
    },
    (error) => {
      port.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        code: codeOf(error),
      });
    },
  );
}
