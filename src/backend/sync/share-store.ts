import { posix } from 'node:path';

import {
  SECRET_SENTINEL,
  type CreateShareRequest,
  type Share,
  type ShareRuntime,
  type UpdateShareRequest,
} from '../../shared';
import { type ConfigManager } from '../config/config-manager';
import { type Db, type SqlValue } from '../config/db';

/**
 * Reading and writing the `shares` table.
 *
 * Kept out of the route module because two of the rules here are about the filesystem
 * and the credential store rather than about HTTP, and both are the kind of thing that
 * has to hold no matter which caller reaches them.
 */

/** Where a share's server export is mounted. Derived, never accepted from a client. */
export const MOUNT_ROOT = '/mnt/tnc-server';
/** Local cache the TNC side serves from. Matches `PRODUCTION_PATHS.cacheRoot`. */
export const CACHE_ROOT = '/srv/tnc';

export class ShareError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'conflict',
  ) {
    super(message);
    this.name = 'ShareError';
  }
}

interface ShareRow {
  id: number;
  name: string;
  enabled: number;
  server_unc: string;
  mount_point: string;
  cache_path: string;
  smb_domain: string | null;
  smb_user: string | null;
  smb_password: string | null;
  smb_version: string;
  smb_seal: number;
  conflict_mode: string;
  exclude_patterns: string;
  scan_interval_ms: number;
  bandwidth_limit_kbps: number | null;
  max_file_size_mb: number;
  read_only: number;
  failover_read_only: number;
  tnc_guest_ok: number;
  tnc_user: string | null;
  tnc_password: string | null;
  status: string;
  last_scan_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** Binds a password envelope to the row it belongs to; see `ConfigManager.encryptFor`. */
function passwordAad(shareId: number): string {
  return `shares.${String(shareId)}.smbPassword`;
}

/**
 * The TNC-side password's own label.
 *
 * Deliberately different from {@link passwordAad}. The two credentials point in
 * opposite directions — one reaches the corporate server, one lets a shop-floor control
 * in — and a distinct AAD means an envelope lifted from one column cannot be pasted
 * into the other even with database access.
 */
function tncPasswordAad(shareId: number): string {
  return `shares.${String(shareId)}.tncPassword`;
}

/**
 * The Unix and Samba account name for a share.
 *
 * Derived rather than stored: it is a function of the share name, so it cannot drift
 * out of step with it, and the `tnc-` prefix keeps every account this creates in a
 * namespace that cannot collide with a real operator login. The helper validates the
 * same shape independently.
 */
export function sambaAccountFor(shareName: string): string {
  return `tnc-${shareName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
}

function toShare(row: ShareRow): Share {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    serverUnc: row.server_unc,
    mountPoint: row.mount_point,
    cachePath: row.cache_path,
    smbDomain: row.smb_domain,
    smbUser: row.smb_user,
    smbVersion: row.smb_version as Share['smbVersion'],
    smbSeal: row.smb_seal === 1,
    conflictMode: row.conflict_mode as Share['conflictMode'],
    excludePatterns: JSON.parse(row.exclude_patterns) as string[],
    scanIntervalMs: row.scan_interval_ms,
    bandwidthLimitKbps: row.bandwidth_limit_kbps,
    maxFileSizeMb: row.max_file_size_mb,
    readOnly: row.read_only === 1,
    failoverReadOnly: row.failover_read_only === 1,
    tncGuestOk: row.tnc_guest_ok === 1,
    tncUser: row.tnc_user,
    status: row.status as Share['status'],
    lastScanAt: row.last_scan_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ShareStoreOptions {
  readonly db: Db;
  readonly config: ConfigManager;
  readonly now?: () => number;
}

export class ShareStore {
  private readonly db: Db;
  private readonly config: ConfigManager;
  private readonly now: () => number;

  constructor(options: ShareStoreOptions) {
    this.db = options.db;
    this.config = options.config;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  list(limit: number, offset: number): { items: ShareRuntime[]; total: number } {
    const total = this.db.pluck<number>('SELECT COUNT(*) FROM shares') ?? 0;
    const rows = this.db.all<ShareRow>(
      'SELECT * FROM shares ORDER BY name LIMIT @limit OFFSET @offset',
      { limit, offset },
    );
    return { items: rows.map((row) => this.withRuntime(toShare(row))), total };
  }

  get(id: number): ShareRuntime {
    return this.withRuntime(toShare(this.requireRow(id)));
  }

  create(input: CreateShareRequest): Share {
    const now = this.now();
    // The name decides the mount point, the cache path and the Samba section, which is
    // why it is the one field a client may not choose a path for.
    //
    // `posix.join`, not `join`: these are paths on the appliance, which is Linux. Using
    // the platform-aware version would emit backslashes when the tests (or a developer's
    // build) run on Windows, and `absolutePathSchema` would then reject the share the
    // backend had just written.
    const mountPoint = posix.join(MOUNT_ROOT, input.name);
    const cachePath = posix.join(CACHE_ROOT, input.name);

    if (this.db.pluck<number>('SELECT 1 FROM shares WHERE name = @name', { name: input.name })) {
      throw new ShareError(`A share named "${input.name}" already exists`, 'conflict');
    }

    const result = this.db.run(
      `INSERT INTO shares (
         name, enabled, server_unc, mount_point, cache_path,
         smb_domain, smb_user, smb_version, smb_seal, conflict_mode,
         exclude_patterns, scan_interval_ms, bandwidth_limit_kbps, max_file_size_mb,
         tnc_guest_ok, tnc_user, created_at, updated_at
       ) VALUES (
         @name, @enabled, @serverUnc, @mountPoint, @cachePath,
         @smbDomain, @smbUser, @smbVersion, @smbSeal, @conflictMode,
         @excludePatterns, @scanIntervalMs, @bandwidthLimitKbps, @maxFileSizeMb,
         @tncGuestOk, @tncUser, @now, @now
       )`,
      {
        name: input.name,
        enabled: input.enabled ? 1 : 0,
        serverUnc: input.serverUnc,
        mountPoint,
        cachePath,
        smbDomain: input.smbDomain,
        smbUser: input.smbUser,
        smbVersion: input.smbVersion,
        smbSeal: input.smbSeal ? 1 : 0,
        conflictMode: input.conflictMode,
        excludePatterns: JSON.stringify(input.excludePatterns),
        scanIntervalMs: input.scanIntervalMs,
        bandwidthLimitKbps: input.bandwidthLimitKbps,
        maxFileSizeMb: input.maxFileSizeMb,
        tncGuestOk: input.tncGuestOk ? 1 : 0,
        tncUser: input.tncUser,
        now,
      },
    );

    const id = Number(result.lastInsertRowid);
    // Written after the insert because the envelope is bound to the row id, which only
    // exists once the row does.
    this.writePassword(id, input.smbPassword);
    this.writeTncPassword(id, input.tncPassword);
    return toShare(this.requireRow(id));
  }

  update(id: number, patch: UpdateShareRequest): Share {
    const existing = this.requireRow(id);
    const assignments: string[] = [];
    const params: Record<string, SqlValue> = { id, now: this.now() };

    const set = (column: string, key: string, value: SqlValue): void => {
      assignments.push(`${column} = @${key}`);
      params[key] = value;
    };

    if (patch.enabled !== undefined) set('enabled', 'enabled', patch.enabled ? 1 : 0);
    if (patch.serverUnc !== undefined) set('server_unc', 'serverUnc', patch.serverUnc);
    if (patch.smbDomain !== undefined) set('smb_domain', 'smbDomain', patch.smbDomain);
    if (patch.smbUser !== undefined) set('smb_user', 'smbUser', patch.smbUser);
    if (patch.smbVersion !== undefined) set('smb_version', 'smbVersion', patch.smbVersion);
    if (patch.smbSeal !== undefined) set('smb_seal', 'smbSeal', patch.smbSeal ? 1 : 0);
    if (patch.conflictMode !== undefined) set('conflict_mode', 'conflictMode', patch.conflictMode);
    if (patch.excludePatterns !== undefined) {
      set('exclude_patterns', 'excludePatterns', JSON.stringify(patch.excludePatterns));
    }
    if (patch.scanIntervalMs !== undefined) {
      set('scan_interval_ms', 'scanIntervalMs', patch.scanIntervalMs);
    }
    if (patch.bandwidthLimitKbps !== undefined) {
      set('bandwidth_limit_kbps', 'bandwidthLimitKbps', patch.bandwidthLimitKbps);
    }
    if (patch.maxFileSizeMb !== undefined) {
      set('max_file_size_mb', 'maxFileSizeMb', patch.maxFileSizeMb);
    }
    if (patch.tncGuestOk !== undefined) set('tnc_guest_ok', 'tncGuestOk', patch.tncGuestOk ? 1 : 0);
    if (patch.readOnly !== undefined) set('read_only', 'readOnly', patch.readOnly ? 1 : 0);

    if (assignments.length > 0) {
      this.db.run(
        `UPDATE shares SET ${assignments.join(', ')}, updated_at = @now WHERE id = @id`,
        params,
      );
    }

    this.writePassword(existing.id, patch.smbPassword);
    this.writeTncPassword(existing.id, patch.tncPassword);
    return toShare(this.requireRow(id));
  }

  delete(id: number): void {
    this.requireRow(id);
    // file_index and locks reference the share; the schema cascades, so one statement
    // is enough and a half-deleted share cannot be left behind.
    this.db.run('DELETE FROM shares WHERE id = @id', { id });
  }

  /** The stored password, or `undefined` when this share uses the global account. */
  password(id: number): string | undefined {
    const row = this.requireRow(id);
    if (row.smb_password === null || row.smb_password === '') {
      return undefined;
    }
    return this.config.decryptFor(passwordAad(id), row.smb_password);
  }

  /**
   * `undefined` leaves the stored password alone, and so does the redaction sentinel —
   * which is what lets a client PATCH back a share it fetched without ever holding the
   * plaintext. An empty string is the explicit "clear it and use the global account".
   */
  private writePassword(id: number, value: string | undefined): void {
    if (value === undefined || value === SECRET_SENTINEL) {
      return;
    }
    this.db.run('UPDATE shares SET smb_password = @password WHERE id = @id', {
      id,
      password: value === '' ? null : this.config.encryptFor(passwordAad(id), value),
    });
  }

  /** The password a machine authenticates with, or `undefined` when none is set. */
  tncPassword(id: number): string | undefined {
    const row = this.requireRow(id);
    if (row.tnc_password === null || row.tnc_password === '') {
      return undefined;
    }
    return this.config.decryptFor(tncPasswordAad(id), row.tnc_password);
  }

  /** Same three-way rule as {@link writePassword}: undefined and the sentinel leave it. */
  private writeTncPassword(id: number, value: string | undefined): void {
    if (value === undefined || value === SECRET_SENTINEL) {
      return;
    }
    this.db.run('UPDATE shares SET tnc_password = @password WHERE id = @id', {
      id,
      password: value === '' ? null : this.config.encryptFor(tncPasswordAad(id), value),
    });
  }

  private requireRow(id: number): ShareRow {
    const row = this.db.get<ShareRow>('SELECT * FROM shares WHERE id = @id', { id });
    if (row === undefined) {
      throw new ShareError(`No share with id ${String(id)}`, 'not_found');
    }
    return row;
  }

  /**
   * Layers live counts onto a stored row.
   *
   * The transfer-related figures are reported as zero rather than invented: the sync
   * orchestrator is not yet wired into the service, and a dashboard showing a plausible
   * throughput for a bridge that is not syncing would be worse than one showing none.
   * The counts that *are* real come straight from the tables that hold them.
   */
  private withRuntime(share: Share): ShareRuntime {
    const count = (sql: string): number => this.db.pluck<number>(sql, { shareId: share.id }) ?? 0;

    return {
      ...share,
      mounted: false,
      serverReachable: share.status !== 'offline',
      effectiveReadOnly: share.readOnly || share.failoverReadOnly,
      queueDepth: 0,
      filesIndexed: count('SELECT COUNT(*) FROM file_index WHERE share_id = @shareId'),
      filesPending: count(
        `SELECT COUNT(*) FROM file_index
         WHERE share_id = @shareId AND state IN ('pending_push', 'pending_pull')`,
      ),
      filesConflicted: count(
        "SELECT COUNT(*) FROM file_index WHERE share_id = @shareId AND state = 'conflict'",
      ),
      activeLocks: count(
        'SELECT COUNT(*) FROM locks WHERE share_id = @shareId AND released_at IS NULL',
      ),
      bytesInPerSec: 0,
      bytesOutPerSec: 0,
    };
  }
}
