/**
 * Constants shared by the backend and the browser bundle.
 * This module must stay free of Node and backend imports — it is compiled into the frontend.
 */

export const PRODUCT_NAME = 'TNC Network Bridge';

/** Every REST route is mounted below this prefix (IMPLEMENTATION_PLAN §5). */
export const API_BASE_PATH = '/api/v1';

/** Share names are used as filesystem paths and Samba section names, so they are tightly bounded. */
export const SHARE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/** Conflict resolution strategies (IMPLEMENTATION_PLAN §3.1). */
export const CONFLICT_MODES = ['tnc_wins', 'server_wins', 'last_write_wins'] as const;

/** Per-share lifecycle states driven by the sync orchestrator (T22). */
export const SHARE_STATUSES = [
  'idle',
  'scanning',
  'syncing',
  'paused',
  'error',
  'offline',
] as const;

/** Reconciliation state of a single indexed file (T15/T18). */
export const FILE_STATES = [
  'new',
  'synced',
  'pending_push',
  'pending_pull',
  'conflict',
  'deferred_locked',
  'error',
  'excluded',
] as const;

/** What caused a lock to be taken (T24). */
export const LOCK_ORIGINS = ['tnc', 'manual', 'schedule', 'sync'] as const;

/** How a lock is projected onto the server share (T26). */
export const SERVER_LOCK_KINDS = ['none', 'sidecar', 'byte_range'] as const;

/** Prefix for in-flight transfer temp files. Vetoed in smb.conf and excluded from sync. */
export const TEMP_FILE_PREFIX = '.tnc-tmp-';

/**
 * Returned in place of any secret value by the API, and accepted on write to mean
 * "leave this secret unchanged" (T5).
 */
export const SECRET_SENTINEL = '********';
