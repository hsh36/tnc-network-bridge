import { type z } from 'zod';
import {
  CONFIG_SECTION_NAMES,
  configSectionSchemas,
  SECRET_CONFIG_KEYS,
  SECRET_SENTINEL,
  type ConfigSection,
  type ConfigSectionName,
  type SecretConfigKey,
} from '../../shared';
import { type Db, type DbLogger } from './db';
import { decryptSecret, encryptSecret, isSecretEnvelope } from './secrets';

/**
 * Typed access to the `config` table.
 *
 * Two decisions shape everything here.
 *
 * First, the Zod section schemas are the single source of truth for defaults. The
 * database stores only what has been set; anything missing is filled by parsing
 * through the schema. A default therefore cannot drift between code and database,
 * because there is only one copy of it.
 *
 * Second, `get()` never returns a plaintext secret — not to the API, not to internal
 * callers. A caller that genuinely needs the AD password must ask for it by name via
 * {@link ConfigManager.getSecret}. That makes "secrets never appear in API responses"
 * a structural property rather than a rule someone has to remember at each call site.
 */

export interface ConfigIssue {
  /** Dotted path within the section, e.g. `lan.address`. */
  readonly path: string;
  readonly message: string;
}

export class ConfigValidationError extends Error {
  constructor(
    readonly section: string,
    readonly issues: readonly ConfigIssue[],
  ) {
    super(
      `Invalid configuration for section "${section}": ` +
        issues.map((i) => `${i.path === '' ? '(root)' : i.path}: ${i.message}`).join('; '),
    );
    this.name = 'ConfigValidationError';
  }
}

export class ConfigError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ConfigChange {
  readonly section: ConfigSectionName;
  /** Redacted, like everything else that leaves this class. */
  readonly current: Record<string, unknown>;
  readonly previous: Record<string, unknown>;
  /** Fully-qualified keys that actually changed, e.g. `sync.concurrency`. */
  readonly changedKeys: readonly string[];
  readonly actor: string;
}

export type ConfigChangeHandler = (change: ConfigChange) => void;
export type Unsubscribe = () => void;

export interface ConfigManagerOptions {
  readonly db: Db;
  /** 32 bytes. Obtained from `loadSecretKey()` at startup. */
  readonly secretKey: Buffer;
  readonly logger?: DbLogger;
}

interface ConfigRow {
  key: string;
  value: string;
  is_secret: number;
}

const SECRET_KEY_SET = new Set<string>(SECRET_CONFIG_KEYS);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Flattens to dotted leaf keys. Arrays are leaves — `sync.excludePatterns` is stored
 * as one JSON value, not as indexed keys, so replacing the list is a single atomic write.
 */
function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix === '' ? key : `${prefix}.${key}`, out);
    }
    return;
  }
  out.set(prefix, value);
}

function unflatten(entries: Iterable<readonly [string, unknown]>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const parts = key.split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (part === undefined) {
        continue;
      }
      const existing = node[part];
      if (!isPlainObject(existing)) {
        const created: Record<string, unknown> = {};
        node[part] = created;
        node = created;
      } else {
        node = existing;
      }
    }
    const leaf = parts[parts.length - 1];
    if (leaf !== undefined) {
      node[leaf] = value;
    }
  }
  return root;
}

export class ConfigManager {
  private readonly handlers = new Set<ConfigChangeHandler>();

  private constructor(
    private readonly db: Db,
    private readonly secretKey: Buffer,
    private readonly logger: DbLogger | undefined,
  ) {}

  /** Opens the manager and writes any default that is not yet persisted. */
  static create(options: ConfigManagerOptions): ConfigManager {
    const manager = new ConfigManager(options.db, options.secretKey, options.logger);
    manager.materialiseDefaults();
    return manager;
  }

  /**
   * Persists every default that has no row yet.
   *
   * `INSERT OR IGNORE` rather than upsert: an operator's setting must survive a
   * restart and an upgrade. This only ever fills gaps — which is also what makes a
   * newly added config key appear with its default after an update, without a
   * bespoke migration.
   */
  private materialiseDefaults(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.transaction(() => {
      for (const section of CONFIG_SECTION_NAMES) {
        const defaults = configSectionSchemas[section].parse({}) as unknown;
        const leaves = new Map<string, unknown>();
        flatten(defaults, section, leaves);

        for (const [key, value] of leaves) {
          const secret = SECRET_KEY_SET.has(key);
          this.db.run(
            `INSERT OR IGNORE INTO config (key, value, is_secret, updated_at, updated_by)
             VALUES (@key, @value, @isSecret, @updatedAt, 'system')`,
            {
              key,
              value: secret
                ? encryptSecret(typeof value === 'string' ? value : '', this.secretKey, key)
                : JSON.stringify(value ?? null),
              isSecret: secret ? 1 : 0,
              updatedAt: now,
            },
          );
        }
      }
    });
  }

  private readSection(section: ConfigSectionName): Map<string, unknown> {
    const rows = this.db.all<ConfigRow>(
      'SELECT key, value, is_secret FROM config WHERE key LIKE @prefix',
      { prefix: `${section}.%` },
    );
    const entries = new Map<string, unknown>();
    for (const row of rows) {
      // The path is relative to the section, so it can be unflattened directly into
      // the shape the section schema expects.
      const relative = row.key.slice(section.length + 1);
      if (row.is_secret === 1) {
        entries.set(relative, SECRET_SENTINEL);
      } else {
        entries.set(relative, safeJsonParse(row.value));
      }
    }
    return entries;
  }

  /**
   * Returns a section, filling any unset field from its schema default.
   *
   * Secret fields always read back as {@link SECRET_SENTINEL}.
   */
  get<K extends ConfigSectionName>(section: K): ConfigSection<K> {
    const stored = unflatten(this.readSection(section));
    const parsed = configSectionSchemas[section].safeParse(stored);
    if (!parsed.success) {
      // A stored value that no longer satisfies the schema — normally the result of a
      // hand-edited database or a tightened constraint. Fall back to defaults for the
      // whole section rather than refusing to boot, and say so loudly.
      this.logger?.error(
        { section, issues: toIssues(parsed.error) },
        'stored configuration is invalid; falling back to defaults for this section',
      );
      return configSectionSchemas[section].parse({});
    }
    return parsed.data;
  }

  /** Every section at once, secrets redacted. */
  getAll(): Record<ConfigSectionName, unknown> {
    const result: Partial<Record<ConfigSectionName, unknown>> = {};
    for (const section of CONFIG_SECTION_NAMES) {
      result[section] = this.get(section);
    }
    return result as Record<ConfigSectionName, unknown>;
  }

  /**
   * The only path to a plaintext secret.
   *
   * Deliberately keyed by the literal secret key rather than a free-form string, so
   * every call site that handles a credential is greppable and type-checked.
   */
  getSecret(key: SecretConfigKey): string {
    const row = this.db.get<ConfigRow>(
      'SELECT key, value, is_secret FROM config WHERE key = @key',
      { key },
    );
    if (row === undefined) {
      return '';
    }
    if (row.is_secret !== 1 || !isSecretEnvelope(row.value)) {
      throw new ConfigError(`Config key "${key}" is not stored as an encrypted secret`);
    }
    return decryptSecret(row.value, this.secretKey, key);
  }

  /**
   * Replaces a section.
   *
   * A secret arriving as {@link SECRET_SENTINEL} means "unchanged" — which is what
   * lets the UI round-trip a section it fetched without ever holding the plaintext.
   */
  set<K extends ConfigSectionName>(section: K, input: unknown, actor = 'admin'): ConfigSection<K> {
    const parsed = configSectionSchemas[section].safeParse(input);
    if (!parsed.success) {
      throw new ConfigValidationError(section, toIssues(parsed.error));
    }

    const previous = this.get(section);
    const leaves = new Map<string, unknown>();
    flatten(parsed.data, section, leaves);

    const changedKeys: string[] = [];
    const now = Math.floor(Date.now() / 1000);

    this.db.transaction(() => {
      for (const [key, value] of leaves) {
        const secret = SECRET_KEY_SET.has(key);

        if (secret) {
          // Unchanged: leave the existing envelope alone. Re-encrypting would be
          // harmless but would also make every save look like a credential rotation
          // in the audit log.
          if (value === SECRET_SENTINEL) {
            continue;
          }
          this.db.run(
            `INSERT INTO config (key, value, is_secret, updated_at, updated_by)
             VALUES (@key, @value, 1, @updatedAt, @actor)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value, is_secret = 1,
               updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
            {
              key,
              value: encryptSecret(typeof value === 'string' ? value : '', this.secretKey, key),
              updatedAt: now,
              actor,
            },
          );
          changedKeys.push(key);
          continue;
        }

        const encoded = JSON.stringify(value ?? null);
        const existing = this.db.get<{ value: string }>(
          'SELECT value FROM config WHERE key = @key',
          { key },
        );
        if (existing?.value === encoded) {
          continue;
        }
        this.db.run(
          `INSERT INTO config (key, value, is_secret, updated_at, updated_by)
           VALUES (@key, @value, 0, @updatedAt, @actor)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value, is_secret = 0,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          { key, value: encoded, updatedAt: now, actor },
        );
        changedKeys.push(key);
      }
    });

    const current = this.get(section);
    if (changedKeys.length > 0) {
      this.emit({
        section,
        current: current,
        previous: previous,
        changedKeys,
        actor,
      });
    }
    return current;
  }

  /**
   * Reads an install-scoped key such as `setup.completed`, which belongs to no
   * section and therefore has no schema.
   */
  getFlag<T = unknown>(key: string, fallback: T): T {
    const row = this.db.get<ConfigRow>(
      'SELECT key, value, is_secret FROM config WHERE key = @key',
      {
        key,
      },
    );
    if (row === undefined || row.is_secret === 1) {
      return fallback;
    }
    const parsedValue = safeJsonParse(row.value);
    return parsedValue === undefined ? fallback : (parsedValue as T);
  }

  setFlag(key: string, value: unknown, actor = 'system'): void {
    this.db.run(
      `INSERT INTO config (key, value, is_secret, updated_at, updated_by)
       VALUES (@key, @value, 0, @updatedAt, @actor)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      {
        key,
        value: JSON.stringify(value ?? null),
        updatedAt: Math.floor(Date.now() / 1000),
        actor,
      },
    );
  }

  /**
   * Subscribes to every section change. Returns an unsubscribe function rather than
   * requiring the caller to keep the handler around to remove it later.
   */
  onChange(handler: ConfigChangeHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Subscribes to one section — the common case for a subsystem reacting to its own config. */
  onSectionChange(section: ConfigSectionName, handler: ConfigChangeHandler): Unsubscribe {
    return this.onChange((change) => {
      if (change.section === section) {
        handler(change);
      }
    });
  }

  private emit(change: ConfigChange): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(change);
      } catch (err) {
        // A subsystem that mishandles a config change must not roll back the change
        // or take down the request that made it.
        this.logger?.error(
          { err, section: change.section },
          'a configuration change subscriber threw',
        );
      }
    }
  }
}

function toIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // A non-JSON value predates this code or was hand-edited; treat it as a string
    // rather than discarding it.
    return value;
  }
}

/**
 * Replaces every known secret in an arbitrary object tree with the sentinel.
 * Used by the log redactor (T6) and by error serialisation, where the object shape
 * is not known statically.
 */
export function redactSecrets<T>(value: T, prefix = ''): T {
  if (Array.isArray(value)) {
    // Array.isArray narrows a generic to any[], so re-widen explicitly rather than
    // letting `any` propagate out of the recursion.
    const items = value as unknown[];
    return items.map((item) => redactSecrets(item, prefix)) as unknown as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const looksSecret =
      SECRET_KEY_SET.has(path) || /^(password|passwd|secret|token|apiKey|credentials)$/i.test(key);
    output[key] =
      looksSecret && typeof child !== 'object' ? SECRET_SENTINEL : redactSecrets(child, path);
  }
  return output as T;
}
