-- Schema v1 — IMPLEMENTATION_PLAN §2.
--
-- Wrapped in a transaction by the migration runner; this file must not open one.
-- Connection pragmas (WAL, foreign_keys, busy_timeout, synchronous) are applied by
-- the Db wrapper on every connection, not here — they are per-connection settings and
-- a migration is the wrong place to establish them.

-- ---------------------------------------------------------------------------
-- config — key/value with per-key secrecy
-- ---------------------------------------------------------------------------
CREATE TABLE config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                          -- JSON-encoded
  is_secret   INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0, 1)),
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

-- ---------------------------------------------------------------------------
-- shares
-- ---------------------------------------------------------------------------
CREATE TABLE shares (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE
                          CHECK (length(name) BETWEEN 1 AND 32
                                 AND name NOT GLOB '*[^A-Za-z0-9_-]*'),
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  server_unc            TEXT NOT NULL,                -- //fileserver/cnc$/programs
  mount_point           TEXT NOT NULL,                -- /mnt/tnc-server/<name>
  cache_path            TEXT NOT NULL,                -- /srv/tnc/<name>
  smb_domain            TEXT,
  smb_user              TEXT,
  smb_version           TEXT NOT NULL DEFAULT '3.1.1',
  smb_seal              INTEGER NOT NULL DEFAULT 1 CHECK (smb_seal IN (0, 1)),
  conflict_mode         TEXT NOT NULL DEFAULT 'last_write_wins'
                          CHECK (conflict_mode IN ('tnc_wins', 'server_wins', 'last_write_wins')),
  exclude_patterns      TEXT NOT NULL DEFAULT '[]',   -- JSON string[] (picomatch)
  scan_interval_ms      INTEGER NOT NULL DEFAULT 15000 CHECK (scan_interval_ms > 0),
  bandwidth_limit_kbps  INTEGER CHECK (bandwidth_limit_kbps IS NULL OR bandwidth_limit_kbps > 0),
  max_file_size_mb      INTEGER NOT NULL DEFAULT 512 CHECK (max_file_size_mb > 0),
  read_only             INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  failover_read_only    INTEGER NOT NULL DEFAULT 0 CHECK (failover_read_only IN (0, 1)),
  tnc_guest_ok          INTEGER NOT NULL DEFAULT 1 CHECK (tnc_guest_ok IN (0, 1)),
  status                TEXT NOT NULL DEFAULT 'idle'
                          CHECK (status IN ('idle', 'scanning', 'syncing',
                                            'paused', 'error', 'offline')),
  last_scan_at          INTEGER,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  -- The mount point and cache path are derived from the name and must stay distinct
  -- across shares; a collision would silently sync two shares into one directory.
  UNIQUE (mount_point),
  UNIQUE (cache_path)
);

-- ---------------------------------------------------------------------------
-- file_index — the (base, local, remote) triple the diff engine reasons over
-- ---------------------------------------------------------------------------
CREATE TABLE file_index (
  id            INTEGER PRIMARY KEY,
  share_id      INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path      TEXT NOT NULL,
  rel_path_ci   TEXT NOT NULL,                        -- lowercased: SMB is case-insensitive, ext4 is not
  is_dir        INTEGER NOT NULL DEFAULT 0 CHECK (is_dir IN (0, 1)),
  loc_size      INTEGER, loc_mtime INTEGER, loc_hash TEXT,
  srv_size      INTEGER, srv_mtime INTEGER, srv_hash TEXT,
  base_size     INTEGER, base_mtime INTEGER, base_hash TEXT,
  state         TEXT NOT NULL DEFAULT 'new'
                  CHECK (state IN ('new', 'synced', 'pending_push', 'pending_pull',
                                   'conflict', 'deferred_locked', 'error', 'excluded')),
  last_sync_at  INTEGER,
  last_error    TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at INTEGER,
  -- Case-insensitive uniqueness is what makes a case-collision detectable rather
  -- than a silent overwrite when an SMB client renames PART1.H to part1.h.
  UNIQUE (share_id, rel_path_ci)
);
CREATE INDEX idx_fi_state ON file_index(share_id, state);
CREATE INDEX idx_fi_retry ON file_index(next_retry_at) WHERE next_retry_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- locks
-- ---------------------------------------------------------------------------
CREATE TABLE locks (
  id                INTEGER PRIMARY KEY,
  share_id          INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path          TEXT NOT NULL,
  origin            TEXT NOT NULL CHECK (origin IN ('tnc', 'manual', 'schedule', 'sync')),
  owner_label       TEXT,                             -- "TNC-640-Halle2"
  tnc_ip            TEXT,
  smb_pid           INTEGER,
  smb_session_id    TEXT,
  server_lock_kind  TEXT NOT NULL DEFAULT 'sidecar'
                      CHECK (server_lock_kind IN ('none', 'sidecar', 'byte_range')),
  server_lock_ok    INTEGER NOT NULL DEFAULT 0 CHECK (server_lock_ok IN (0, 1)),
  server_lock_error TEXT,
  acquired_at       INTEGER NOT NULL,
  expires_at        INTEGER,                          -- TTL; NULL = until released
  released_at       INTEGER,
  note              TEXT
);
-- The partial unique index is the entire concurrency control for locking: it makes
-- "one active lock per (share, path)" a database invariant, so two simultaneous
-- acquires cannot both win no matter how the application is scheduled (R15).
CREATE UNIQUE INDEX idx_locks_active ON locks(share_id, rel_path) WHERE released_at IS NULL;
CREATE INDEX idx_locks_expiry ON locks(expires_at) WHERE released_at IS NULL AND expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- file_versions — content-addressed history
-- ---------------------------------------------------------------------------
CREATE TABLE file_versions (
  id          INTEGER PRIMARY KEY,
  share_id    INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path    TEXT NOT NULL,
  hash        TEXT NOT NULL,                          -- sha256, also the blob address
  size        INTEGER NOT NULL CHECK (size >= 0),
  mtime       INTEGER NOT NULL,
  origin      TEXT NOT NULL
                CHECK (origin IN ('server', 'tnc', 'restore', 'initial', 'conflict_loser')),
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
);
CREATE INDEX idx_ver_path ON file_versions(share_id, rel_path, created_at DESC);
CREATE INDEX idx_ver_hash ON file_versions(hash);

-- ---------------------------------------------------------------------------
-- sync_events
-- ---------------------------------------------------------------------------
CREATE TABLE sync_events (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  share_id    INTEGER,
  rel_path    TEXT,
  direction   TEXT CHECK (direction IN ('pull', 'push', 'none')),
  action      TEXT NOT NULL
                CHECK (action IN ('copy', 'delete', 'mkdir', 'rename', 'skip', 'defer', 'verify')),
  bytes       INTEGER,
  duration_ms INTEGER,
  result      TEXT NOT NULL CHECK (result IN ('ok', 'error', 'skipped', 'deferred')),
  message     TEXT
);
CREATE INDEX idx_ev_ts ON sync_events(ts DESC);
CREATE INDEX idx_ev_share ON sync_events(share_id, ts DESC);

-- ---------------------------------------------------------------------------
-- conflicts
-- ---------------------------------------------------------------------------
CREATE TABLE conflicts (
  id                 INTEGER PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  share_id           INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path           TEXT NOT NULL,
  mode_applied       TEXT NOT NULL
                       CHECK (mode_applied IN ('tnc_wins', 'server_wins', 'last_write_wins')),
  winner             TEXT NOT NULL CHECK (winner IN ('local', 'remote')),
  -- The losing content is captured before it is overwritten. ON DELETE SET NULL so
  -- retention pruning a version can never cascade away the conflict record itself.
  loser_version_id   INTEGER REFERENCES file_versions(id) ON DELETE SET NULL,
  winner_hash        TEXT, loser_hash TEXT,
  local_mtime        INTEGER, remote_mtime INTEGER,
  acknowledged       INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
  detail             TEXT
);
CREATE INDEX idx_conflicts_ts ON conflicts(ts DESC);
CREATE INDEX idx_conflicts_open ON conflicts(share_id, acknowledged) WHERE acknowledged = 0;

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                      -- sha256 of the cookie value
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT, user_agent TEXT,
  csrf_token   TEXT NOT NULL
);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- api_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,                  -- sha256
  scopes       TEXT NOT NULL DEFAULT '["read"]',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

-- ---------------------------------------------------------------------------
-- schedules
-- ---------------------------------------------------------------------------
CREATE TABLE schedules (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL
                CHECK (kind IN ('lock', 'unlock', 'update', 'restart', 'prune', 'scan', 'backup')),
  cron        TEXT NOT NULL,                          -- 5-field, TZ from config
  target      TEXT,                                   -- JSON: {shareId, pathGlob, ...}
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at INTEGER, next_run_at INTEGER,
  last_result TEXT, last_error TEXT
);
CREATE INDEX idx_schedules_next ON schedules(next_run_at) WHERE enabled = 1;

-- ---------------------------------------------------------------------------
-- metrics_samples
-- ---------------------------------------------------------------------------
-- Deviation from §2, deliberate: the plan declares `share_id INTEGER` (nullable) as
-- part of the PRIMARY KEY of a WITHOUT ROWID table. SQLite implicitly makes every
-- WITHOUT ROWID primary-key column NOT NULL, so a host-wide sample with a NULL
-- share_id would be rejected at insert time. Sentinel 0 means "not share-scoped",
-- which keeps the compact WITHOUT ROWID layout the plan intends.
CREATE TABLE metrics_samples (
  ts       INTEGER NOT NULL,
  metric   TEXT NOT NULL,                             -- sync.bytes_in, queue.depth, disk.used_pct, cpu.temp …
  share_id INTEGER NOT NULL DEFAULT 0,                -- 0 = host-wide
  value    REAL NOT NULL,
  PRIMARY KEY (ts, metric, share_id)
) WITHOUT ROWID;
CREATE INDEX idx_metrics_metric ON metrics_samples(metric, ts);

-- ---------------------------------------------------------------------------
-- tnc_clients
-- ---------------------------------------------------------------------------
CREATE TABLE tnc_clients (
  id            INTEGER PRIMARY KEY,
  name          TEXT, mac TEXT UNIQUE, ip TEXT,
  model         TEXT CHECK (model IS NULL
                            OR model IN ('iTNC530', 'TNC620', 'TNC640', 'other')),
  dhcp_static   INTEGER NOT NULL DEFAULT 0 CHECK (dhcp_static IN (0, 1)),
  first_seen_at INTEGER, last_seen_at INTEGER,
  notes         TEXT
);

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY,
  ts     INTEGER NOT NULL,
  actor  TEXT NOT NULL,                               -- admin | token:<name> | system
  action TEXT NOT NULL,
  target TEXT, ip TEXT, result TEXT, detail TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX idx_audit_action ON audit_log(action, ts DESC);

-- ---------------------------------------------------------------------------
-- update_history
-- ---------------------------------------------------------------------------
CREATE TABLE update_history (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  from_version TEXT, to_version TEXT, channel TEXT,
  result       TEXT NOT NULL CHECK (result IN ('ok', 'failed', 'rolled_back')),
  log          TEXT
);
CREATE INDEX idx_update_ts ON update_history(ts DESC);

-- ---------------------------------------------------------------------------
-- log_entries — the SQLite sink behind the UI log viewer (T6)
-- ---------------------------------------------------------------------------
CREATE TABLE log_entries (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,                        -- milliseconds
  level      TEXT NOT NULL
               CHECK (level IN ('trace', 'debug', 'info', 'warn', 'error', 'fatal')),
  source     TEXT NOT NULL
               CHECK (source IN ('app', 'sync', 'smb', 'lock', 'auth', 'audit', 'update', 'system')),
  message    TEXT NOT NULL,
  request_id TEXT,
  share_id   INTEGER,
  context    TEXT                                     -- JSON, secrets already redacted
);
CREATE INDEX idx_logs_ts ON log_entries(ts DESC);
CREATE INDEX idx_logs_source ON log_entries(source, level, ts DESC);

-- ---------------------------------------------------------------------------
-- Seed rows
-- ---------------------------------------------------------------------------
-- Only install-scoped facts are seeded here. The ~55 configuration defaults from §6
-- live in the Zod section schemas and are materialised on first start by the Config
-- Manager (T5): duplicating them in SQL would guarantee the two copies drift, and the
-- schemas are already pinned to §6 by test.
INSERT INTO config (key, value, is_secret, updated_at, updated_by) VALUES
  ('setup.completed', 'false', 0, unixepoch(), 'system'),
  ('setup.step',      '"password"', 0, unixepoch(), 'system'),
  ('install.created_at', CAST(unixepoch() AS TEXT), 0, unixepoch(), 'system');
