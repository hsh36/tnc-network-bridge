-- Schema v6 — the `os-update` schedule kind
--
-- Wrapped in a transaction by the migration runner; this file must not open one.
--
-- Raspberry Pi OS package updates run on their own schedule, separate from the
-- appliance's own updates: the two fail in unrelated ways, and they want different
-- cadences. The kind is in SCHEDULE_KINDS, but the table's CHECK constraint predates
-- it, so inserting the row silently failed the constraint and the scheduler had
-- nothing to fire.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Copy-then-swap
-- rather than drop-then-create: an interrupted migration must not be able to leave the
-- appliance with no schedules at all. The runner's transaction makes this atomic, and
-- `PRAGMA foreign_keys` is off during migrations, so nothing references the old rowids
-- while they move.

CREATE TABLE schedules_new (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL
                CHECK (kind IN ('lock', 'unlock', 'update', 'os-update',
                                'restart', 'prune', 'scan', 'backup')),
  cron        TEXT NOT NULL,                          -- 5-field, TZ from config
  target      TEXT,                                   -- JSON: {shareId, pathGlob, ...}
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at INTEGER, next_run_at INTEGER,
  last_result TEXT, last_error TEXT
);

INSERT INTO schedules_new (id, name, kind, cron, target, enabled,
                           last_run_at, next_run_at, last_result, last_error)
  SELECT id, name, kind, cron, target, enabled,
         last_run_at, next_run_at, last_result, last_error
    FROM schedules;

DROP TABLE schedules;
ALTER TABLE schedules_new RENAME TO schedules;

-- Recreated because the index went with the old table.
CREATE INDEX idx_schedules_next ON schedules(next_run_at) WHERE enabled = 1;
