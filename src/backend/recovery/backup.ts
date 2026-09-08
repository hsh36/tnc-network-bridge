import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { CONFIG_SECTION_NAMES, configSectionSchemas, type ConfigSectionName } from '../../shared';
import { type ConfigManager } from '../config/config-manager';
import { type Db, type DbLogger } from '../config/db';
import { type AuditLog } from '../security/audit-log';

/**
 * Configuration and database backup (T44).
 *
 * Two different jobs that are often conflated, kept apart here because they are restored
 * in different situations:
 *
 * - **Config export** is a portable document: the settings an operator would otherwise
 *   re-enter by hand after replacing an SD card. It is JSON, it is human-readable, and
 *   it deliberately does **not** contain secrets.
 * - **Database backup** is a byte-exact copy of `bridge.db` including the file index and
 *   history, taken with SQLite's online backup API so it is consistent without stopping
 *   the service.
 *
 * ## Secrets are never exported
 *
 * The config manager already redacts secrets to a sentinel on read, and the export keeps
 * them redacted. A backup file that an operator emails to themselves, drops on a share,
 * or attaches to a support ticket must not carry the AD service-account password. The
 * cost is that a restore prompts for credentials again, which is the correct trade — and
 * the import reports exactly which secrets need re-entering rather than leaving the
 * operator to discover it when sync fails.
 */

export const BACKUP_FORMAT_VERSION = 1;

/**
 * The export envelope.
 *
 * `checksum` covers the `sections` object only, so the envelope can gain fields without
 * invalidating existing backups.
 */
export const configBackupSchema = z.object({
  formatVersion: z.number().int().positive(),
  /** Product version that wrote the file, for diagnosing an import that misbehaves. */
  appVersion: z.string(),
  createdAt: z.number().int().nonnegative(),
  hostname: z.string().optional(),
  /** sha256 of the canonicalised `sections`. */
  checksum: z.string(),
  sections: z.record(z.unknown()),
  /** Secret keys that were redacted and must be re-entered after an import. */
  redactedSecrets: z.array(z.string()),
});

export type ConfigBackup = z.infer<typeof configBackupSchema>;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * Serialises an object with its keys sorted, at every depth.
 *
 * The checksum must not depend on property insertion order — two exports of identical
 * settings would otherwise disagree, and a checksum that reports false mismatches gets
 * ignored, which makes it worse than no checksum.
 */
export function canonicalise(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(walk);
    }
    if (input !== null && typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      return Object.fromEntries(entries.map(([key, val]) => [key, walk(val)]));
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

export function checksumOf(sections: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalise(sections)).digest('hex');
}

/** The sentinel the config manager substitutes for a secret on read. */
const SECRET_SENTINEL = '********';

/** Walks a section, collecting the dotted paths whose value is the redaction sentinel. */
function findRedacted(section: string, value: unknown, prefix = ''): string[] {
  if (value === SECRET_SENTINEL) {
    return [`${section}.${prefix}`];
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      findRedacted(section, child, prefix.length > 0 ? `${prefix}.${key}` : key),
    );
  }
  return [];
}

export interface ConfigBackupOptions {
  readonly config: ConfigManager;
  readonly appVersion: string;
  readonly hostname?: string;
  readonly audit?: AuditLog;
  readonly logger?: DbLogger;
  readonly now?: () => number;
}

export interface ImportResult {
  readonly applied: readonly ConfigSectionName[];
  readonly skipped: readonly { section: string; reason: string }[];
  /** Secrets the operator must re-enter, because a backup never carries them. */
  readonly secretsToReenter: readonly string[];
}

export class ConfigBackupService {
  private readonly config: ConfigManager;
  private readonly appVersion: string;
  private readonly hostname: string | undefined;
  private readonly audit: AuditLog | undefined;
  private readonly logger: DbLogger | undefined;
  private readonly now: () => number;

  constructor(options: ConfigBackupOptions) {
    this.config = options.config;
    this.appVersion = options.appVersion;
    this.hostname = options.hostname;
    this.audit = options.audit;
    this.logger = options.logger;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Builds the export document. Secrets stay redacted. */
  export(): ConfigBackup {
    const sections: Record<string, unknown> = {};
    const redactedSecrets: string[] = [];

    for (const name of CONFIG_SECTION_NAMES) {
      const value = this.config.get(name);
      sections[name] = value;
      redactedSecrets.push(...findRedacted(name, value));
    }

    this.audit?.record({ actor: 'admin', action: 'backup.export', target: 'config' });

    return {
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: this.appVersion,
      createdAt: this.now(),
      ...(this.hostname !== undefined ? { hostname: this.hostname } : {}),
      checksum: checksumOf(sections),
      sections,
      redactedSecrets,
    };
  }

  /**
   * Applies an exported document.
   *
   * Validated in three stages, in this order, because each is cheaper than the next and
   * a failure in an earlier one makes the later ones meaningless:
   *
   * 1. The envelope parses and the format version is one we understand.
   * 2. The checksum matches — the file was not truncated or edited by hand.
   * 3. Each section validates against its own schema.
   *
   * A section that fails stage 3 is *skipped*, not fatal. A backup from a slightly older
   * release may carry a section this build no longer accepts, and refusing the whole
   * import over one stale section would make backups useless exactly when they are
   * needed. What is skipped is reported.
   */
  import(raw: unknown, actor = 'admin'): ImportResult {
    const parsed = configBackupSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BackupError('This does not look like a configuration backup');
    }
    const backup = parsed.data;

    if (backup.formatVersion > BACKUP_FORMAT_VERSION) {
      throw new BackupError(
        `This backup was written by a newer version (format ${String(backup.formatVersion)})`,
      );
    }

    if (checksumOf(backup.sections) !== backup.checksum) {
      throw new BackupError('The backup checksum does not match — the file is damaged');
    }

    const applied: ConfigSectionName[] = [];
    const skipped: { section: string; reason: string }[] = [];

    for (const [name, value] of Object.entries(backup.sections)) {
      if (!(CONFIG_SECTION_NAMES as readonly string[]).includes(name)) {
        skipped.push({ section: name, reason: 'unknown section' });
        continue;
      }
      const section = name as ConfigSectionName;
      const result = configSectionSchemas[section].safeParse(value);
      if (!result.success) {
        skipped.push({ section, reason: result.error.issues[0]?.message ?? 'invalid' });
        continue;
      }
      try {
        // The sentinel means "unchanged" to the config manager, so redacted secrets are
        // left as they are rather than being overwritten with asterisks.
        this.config.set(section, result.data, actor);
        applied.push(section);
      } catch (err) {
        skipped.push({
          section,
          reason: err instanceof Error ? err.message : 'could not apply',
        });
      }
    }

    this.audit?.record({
      actor,
      action: 'backup.import',
      target: 'config',
      result: skipped.length > 0 ? 'error' : 'ok',
      detail: `${String(applied.length)} sections applied, ${String(skipped.length)} skipped`,
    });
    this.logger?.info({ applied, skipped }, 'configuration backup imported');

    return { applied, skipped, secretsToReenter: backup.redactedSecrets };
  }

  /** Writes the export to a file, atomically. */
  async writeToFile(path: string): Promise<void> {
    const document = JSON.stringify(this.export(), null, 2);
    const temp = `${path}.tmp`;
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(temp, document, 'utf8');
    await rename(temp, path);
  }

  async readFromFile(path: string, actor = 'admin'): Promise<ImportResult> {
    const text = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BackupError('The backup file is not valid JSON');
    }
    return this.import(parsed, actor);
  }
}

// ---------------------------------------------------------------------------
// Database backup
// ---------------------------------------------------------------------------

export interface DatabaseBackupOptions {
  readonly db: Db;
  readonly backupDir: string;
  /** How many backups to keep. Older ones are removed after a successful new one. */
  readonly keep?: number;
  readonly audit?: AuditLog;
  readonly logger?: DbLogger;
  readonly now?: () => number;
}

export interface BackupFile {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly createdAt: number;
}

export class DatabaseBackup {
  private readonly db: Db;
  private readonly backupDir: string;
  private readonly keep: number;
  private readonly audit: AuditLog | undefined;
  private readonly logger: DbLogger | undefined;
  private readonly now: () => number;

  constructor(options: DatabaseBackupOptions) {
    this.db = options.db;
    this.backupDir = options.backupDir;
    this.keep = options.keep ?? 7;
    this.audit = options.audit;
    this.logger = options.logger;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Takes a consistent copy while the service keeps running.
   *
   * Uses SQLite's online backup API rather than copying the file. Copying a live WAL
   * database with `cp` can capture a main file and a WAL that disagree, producing a
   * backup that opens fine and is subtly corrupt — the worst kind, because it is only
   * discovered when it is restored. A checkpoint runs first so the WAL's contents are in
   * the main file before the copy begins.
   */
  async create(label = 'auto'): Promise<BackupFile> {
    await mkdir(this.backupDir, { recursive: true });

    const timestamp = new Date(this.now() * 1000).toISOString().replace(/[:.]/g, '-');
    const name = `bridge-${label}-${timestamp}.db`;
    const path = join(this.backupDir, name);

    this.db.checkpoint('TRUNCATE');
    await this.db.connection.backup(path);

    const info = await stat(path);
    const file: BackupFile = {
      path,
      name,
      sizeBytes: info.size,
      createdAt: this.now(),
    };

    this.audit?.record({
      actor: 'system',
      action: 'backup.database',
      target: name,
      detail: `${String(info.size)} bytes`,
    });
    this.logger?.info({ path, sizeBytes: info.size }, 'database backup written');

    await this.prune();
    return file;
  }

  /** Existing backups, newest first. */
  async list(): Promise<BackupFile[]> {
    let names: string[];
    try {
      names = await readdir(this.backupDir);
    } catch {
      return [];
    }

    const files: BackupFile[] = [];
    for (const name of names) {
      if (!name.startsWith('bridge-') || !name.endsWith('.db')) {
        continue;
      }
      const path = join(this.backupDir, name);
      try {
        const info = await stat(path);
        files.push({
          path,
          name,
          sizeBytes: info.size,
          createdAt: Math.floor(info.mtimeMs / 1000),
        });
      } catch {
        // Vanished between readdir and stat; nothing to report.
      }
    }
    return files.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Removes the oldest backups past `keep`. */
  async prune(): Promise<number> {
    const files = await this.list();
    const doomed = files.slice(this.keep);
    let removed = 0;
    for (const file of doomed) {
      try {
        await unlink(file.path);
        removed += 1;
      } catch {
        // A backup we cannot delete is not worth failing the pass over.
      }
    }
    return removed;
  }

  /**
   * Verifies a backup by opening it and running an integrity check.
   *
   * Worth doing, and worth doing on the copy rather than the original: a backup nobody
   * has ever opened is a hope, not a backup.
   */
  async verify(path: string): Promise<{ ok: boolean; problems: readonly string[] }> {
    const { Db: DbClass } = await import('../config/db');
    const handle = DbClass.open({ path, readonly: true });
    try {
      const result = handle.integrityCheck();
      return { ok: result.ok, problems: result.problems };
    } finally {
      handle.close();
    }
  }

  /** Deletes one backup by name. Refuses a name that is not a plain filename. */
  async remove(name: string): Promise<boolean> {
    if (basename(name) !== name) {
      throw new BackupError('A backup name must not contain a path');
    }
    try {
      await rm(join(this.backupDir, name));
      return true;
    } catch {
      return false;
    }
  }
}
