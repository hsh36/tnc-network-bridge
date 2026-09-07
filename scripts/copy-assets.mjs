#!/usr/bin/env node
/**
 * Copies non-TypeScript backend assets into `dist/backend`.
 *
 * `tsc` emits only what it compiles, so migration SQL, Samba/dnsmasq templates and
 * the Fail2Ban fragments would otherwise be missing from a release tarball — and the
 * failure would surface on the Pi at first boot rather than in CI. Keeping them as
 * real files (instead of inlining them into TypeScript string literals) means they
 * stay readable, diffable and testable with the tools that understand their formats.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(projectRoot, 'src', 'backend');
const targetRoot = join(projectRoot, 'dist', 'backend');

// `.cjs` is here because the scan worker (T15) is a runtime module loaded by
// `worker_threads`, not something `tsc` compiles — without this it would be missing from
// `dist` and every server scan would fail at first boot on the Pi.
const ASSET_EXTENSIONS = ['.sql', '.hbs', '.conf', '.local', '.service', '.template', '.cjs'];

/** @param {string} dir @returns {string[]} */
function collect(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collect(full));
    } else if (ASSET_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      found.push(full);
    }
  }
  return found;
}

if (!existsSync(sourceRoot)) {
  console.error(`copy-assets: ${sourceRoot} does not exist`);
  process.exit(1);
}

const assets = collect(sourceRoot);
for (const asset of assets) {
  const target = join(targetRoot, relative(sourceRoot, asset));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(asset, target);
}

console.log(`copy-assets: copied ${assets.length} asset(s) into dist/backend`);
