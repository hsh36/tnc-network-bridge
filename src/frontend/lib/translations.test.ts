import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import de from '../translations/de.json';
import en from '../translations/en.json';

/**
 * Guards the translation files against the two ways they rot silently.
 *
 * Neither failure mode shows up in a unit test of a component: `translate()` answers a
 * missing key with `[namespace:key]` rather than throwing, so a broken key renders as
 * visible-but-plausible text and only an operator looking at the screen notices. That
 * is exactly how a whole page shipped with every label reading `[dashboard:...]`.
 *
 * The scan is deliberately source-level rather than render-level: rendering every page
 * would need each one's data, hooks and router context, and would still only cover the
 * branches a particular fixture happens to reach.
 */

const FRONTEND_ROOT = join(__dirname, '..');
type Bundle = Record<string, Record<string, string>>;
const bundles: Record<'en' | 'de', Bundle> = { en, de };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'translations' ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [full] : [];
  });
}

/**
 * Removes comments so that JSDoc examples (`t('welcome', …)`) are not mistaken for real
 * call sites. The line-comment pattern keeps the character before `//` so that a URL
 * inside a string literal survives.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface CallSite {
  readonly file: string;
  readonly namespaces: readonly string[];
  readonly key: string;
}

function callSites(): CallSite[] {
  const found: CallSite[] = [];
  for (const file of sourceFiles(FRONTEND_ROOT)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const namespaces = [
      ...new Set([...source.matchAll(/useTranslation\('([^']+)'\)/g)].map((m) => m[1] ?? '')),
    ];
    if (namespaces.length === 0) {
      continue;
    }
    for (const match of source.matchAll(/\bt[A-Za-z]*\('([^']+)'/g)) {
      found.push({
        file: relative(FRONTEND_ROOT, file).split(sep).join('/'),
        namespaces,
        key: match[1] ?? '',
      });
    }
  }
  return found;
}

function flatten(bundle: Bundle): string[] {
  return Object.entries(bundle).flatMap(([namespace, entries]) =>
    Object.keys(entries).map((key) => `${namespace}.${key}`),
  );
}

describe('translation call sites', () => {
  const sites = callSites();

  it('finds the call sites at all, so a passing suite means something', () => {
    // Without this, a regex that silently stops matching would turn every assertion
    // below into a vacuous pass over an empty list.
    expect(sites.length).toBeGreaterThan(100);
  });

  it.each(['en', 'de'] as const)('resolves every key used in the UI (%s)', (language) => {
    const bundle = bundles[language];
    const unresolved = sites
      .filter((site) => !site.namespaces.some((ns) => bundle[ns]?.[site.key] !== undefined))
      .map((site) => `${site.file}: t('${site.key}') in [${site.namespaces.join(', ')}]`);

    expect([...new Set(unresolved)]).toEqual([]);
  });

  it('has no key that repeats its own namespace', () => {
    // `useTranslation('dashboard')` followed by `t('dashboard:title')` looks right and
    // resolves to nothing: the lookup is scoped to the namespace already, and the colon
    // is not a separator this implementation understands.
    const prefixed = sites
      .filter((site) => site.key.includes(':'))
      .map((site) => `${site.file}: t('${site.key}')`);

    expect([...new Set(prefixed)]).toEqual([]);
  });
});

describe('translation bundles', () => {
  it('offers the same keys in every language', () => {
    const enKeys = flatten(bundles.en).sort();
    const deKeys = flatten(bundles.de).sort();

    expect(deKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !deKeys.includes(k))).toEqual([]);
  });

  it('has no empty string standing in for a translation', () => {
    const empty: string[] = [];
    for (const [language, bundle] of Object.entries(bundles)) {
      for (const [namespace, entries] of Object.entries(bundle)) {
        for (const [key, value] of Object.entries(entries)) {
          if (typeof value !== 'string' || value.trim() === '') {
            empty.push(`${language}.${namespace}.${key}`);
          }
        }
      }
    }
    expect(empty).toEqual([]);
  });
});
