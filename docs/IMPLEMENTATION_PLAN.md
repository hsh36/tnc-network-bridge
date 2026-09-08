# TNC Network Bridge — Implementation Plan

**Companion to** [`ARCHITECTURE.md`](./ARCHITECTURE.md) · **Task list:** [`TASKS.md`](./TASKS.md)
**Version:** 1.0 · **Date:** 2026-09-07

---

## 1. Technology decisions — the record

Each decision below was contested; the rejected option and the reason are recorded so they are not
re-litigated mid-implementation.

### D1 — SMB client: `mount.cifs`, not `node-smb2`

**Decision:** kernel CIFS mount. **Rejected:** `node-smb2` / `@marsaud/smb2`, `smbclient` CLI.

`node-smb2` last saw a meaningful release years ago, implements SMB2.0.2 only (no 3.1.1, no `seal`
encryption, no Kerberos), and has open corruption reports on large transfers. Shipping it would mean the
LAN side of a *security product* speaks an obsolete, unencrypted dialect — defeating the product's premise.
`smbclient` works but costs a fork+auth per operation and gives no stream API.

`mount.cifs` turns the share into a POSIX path. That single fact makes `fs.createReadStream`, hashing,
throttling, atomic rename, and `fcntl` locking all work with standard tooling. **Consequence to accept:**
mount failures surface as `EIO`/`ESTALE` rather than typed protocol errors, so every server-side `fs` call
is wrapped in a timeout + error classifier (`isTransient`). And `soft` is mandatory (see ARCHITECTURE §4.1).

### D2 — SMB1 server: Samba, configured by us

**Decision:** manage `smbd`/`nmbd` through a generated `smb.conf`. **Rejected:** implementing SMB1 in Node.

No credible Node SMB1 *server* exists. Samba is what HEIDENHAIN controls are field-tested against.
Our code owns the config file and the service lifecycle, nothing below that.

### D3 — Sync: custom three-way reconciler over SQLite

**Rejected:** rsync (needs rsyncd/SSH — a Windows+AD fileserver offers neither), Syncthing (own protocol on
both ends; can't talk SMB), unison (OCaml runtime, no ARM64 packaging story, no lock/version hooks).

The `base` value in the `(base, local, remote)` triple is what makes conflict detection correct. A
two-value comparison cannot distinguish "one side changed" from "both changed" and silently loses edits.

### D4 — Change detection: inotify locally, polling remotely

Not a preference — a hard constraint. `cifs.ko` does not deliver inotify events for changes made by other
SMB clients. Watching a CIFS mount with chokidar *appears* to work in a single-machine test and fails in
production. The server side polls. Always.

### D5 — Server-side lock projection: sidecar first, byte-range as opt-in

Locking a file on a remote Windows share from Linux has two real options:

1. **Advisory sidecar file** — write `.~lock.<name>#` next to the file (the LibreOffice convention),
   containing owner, TNC IP, machine, timestamp, bridge ID. Works everywhere, zero native deps, human-readable,
   and visible to other bridge instances. **Does not stop** a Windows user who ignores it.
2. **Real byte-range lock** — hold an open fd on the CIFS mount and `fcntl(F_SETLK)`. `cifs.ko` translates
   this into a genuine SMB2 LOCK the server enforces. Node's `fs` has no `fcntl` range-lock binding, so this
   needs a small helper process (`fs-ext` or a ~60-line C shim) holding fds for the lifetime of the lock.

**Plan:** Phase 1 ships sidecar (mode `sidecar`, the default) — it satisfies "Sperre auf Server" in the
advisory sense every Office-class application uses. Phase 2 adds mode `byte_range` behind a config flag,
with sidecar retained as the fallback when the fd helper is unavailable. The limitation is documented in the
admin guide rather than papered over: **a sidecar lock is advisory and a third-party editor may ignore it.**

### D5b — Sidecar-lock hygiene

Sidecar files carry a `bridge_id` and TTL. On startup the bridge sweeps the server share for its *own*
stale sidecars (crash recovery) and removes them; sidecars from other bridge IDs are respected and never
deleted. Sidecars are `veto files` on the Samba side so a TNC never sees them.

### D6 — Frontend: Tailwind + Radix, not Material-UI

MUI ships ~300 KB gzipped with runtime CSS-in-JS. This UI is served from a Pi over a factory LAN and shows
tables, forms, and three charts. Tailwind emits only used classes (~12 KB typical); Radix supplies
accessible dialog/select/tabs behaviour with no visual weight. Target: **initial bundle < 200 KB gzipped.**

### D7 — Database: better-sqlite3 + hand-rolled migrations, no ORM

Synchronous API eliminates a class of interleaving bugs in the sync hot path and is *faster* than async
bindings for SQLite. Prisma/TypeORM would add tens of MB and a codegen step to an appliance running ~15
tables of simple SQL. Migration runner is ~80 lines: `PRAGMA user_version`, numbered `.sql` files, one
transaction each, forward-only.

### D8 — Realtime: SSE, not WebSocket

Traffic is server→client only (status, sync events, log tail). `EventSource` reconnects automatically,
traverses proxies as plain HTTP, and needs no extra dependency or heartbeat protocol.

### D9 — Node 22 LTS

Spec says "Node 18+". Node 18 reached EOL in April 2025; shipping a new appliance on an unsupported runtime
is indefensible. Node 22 LTS satisfies "18+" and is supported into 2027. `install.sh` pins the NodeSource 22.x repo.

---

## 2. Database schema (SQLite, WAL)

`PRAGMA journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON; busy_timeout=5000;`

```sql
-- 001_init.sql

CREATE TABLE config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,              -- JSON-encoded
  is_secret   INTEGER NOT NULL DEFAULT 0, -- 1 => value is AES-256-GCM envelope
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

CREATE TABLE shares (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,          -- ^[a-zA-Z0-9_-]{1,32}$
  enabled               INTEGER NOT NULL DEFAULT 1,
  server_unc            TEXT NOT NULL,                 -- //fileserver/cnc$/programs
  mount_point           TEXT NOT NULL,                 -- /mnt/tnc-server/<name>
  cache_path            TEXT NOT NULL,                 -- /srv/tnc/<name>
  smb_domain            TEXT,
  smb_user              TEXT,
  smb_version           TEXT NOT NULL DEFAULT '3.1.1',
  smb_seal              INTEGER NOT NULL DEFAULT 1,
  conflict_mode         TEXT NOT NULL DEFAULT 'last_write_wins'
                          CHECK (conflict_mode IN ('tnc_wins','server_wins','last_write_wins')),
  exclude_patterns      TEXT NOT NULL DEFAULT '[]',    -- JSON string[] (picomatch)
  scan_interval_ms      INTEGER NOT NULL DEFAULT 15000,
  bandwidth_limit_kbps  INTEGER,                       -- NULL = unlimited
  max_file_size_mb      INTEGER NOT NULL DEFAULT 512,
  read_only             INTEGER NOT NULL DEFAULT 0,    -- manual read-only
  failover_read_only    INTEGER NOT NULL DEFAULT 0,    -- set by failover controller
  tnc_guest_ok          INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'idle',  -- idle|scanning|syncing|paused|error|offline
  last_scan_at          INTEGER,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- The heart of the sync engine: the (base, local, remote) triple.
CREATE TABLE file_index (
  id            INTEGER PRIMARY KEY,
  share_id      INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path      TEXT NOT NULL,
  rel_path_ci   TEXT NOT NULL,            -- lowercased: SMB is case-insensitive, ext4 is not
  is_dir        INTEGER NOT NULL DEFAULT 0,
  loc_size      INTEGER, loc_mtime INTEGER, loc_hash TEXT,
  srv_size      INTEGER, srv_mtime INTEGER, srv_hash TEXT,
  base_size     INTEGER, base_mtime INTEGER, base_hash TEXT,
  state         TEXT NOT NULL DEFAULT 'new'
                  CHECK (state IN ('new','synced','pending_push','pending_pull',
                                   'conflict','deferred_locked','error','excluded')),
  last_sync_at  INTEGER,
  last_error    TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  UNIQUE (share_id, rel_path_ci)
);
CREATE INDEX idx_fi_state  ON file_index(share_id, state);
CREATE INDEX idx_fi_retry  ON file_index(next_retry_at) WHERE next_retry_at IS NOT NULL;

CREATE TABLE locks (
  id                INTEGER PRIMARY KEY,
  share_id          INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path          TEXT NOT NULL,
  origin            TEXT NOT NULL CHECK (origin IN ('tnc','manual','schedule','sync')),
  owner_label       TEXT,                   -- "TNC-640-Halle2"
  tnc_ip            TEXT,
  smb_pid           INTEGER,
  smb_session_id    TEXT,
  server_lock_kind  TEXT NOT NULL DEFAULT 'sidecar'
                      CHECK (server_lock_kind IN ('none','sidecar','byte_range')),
  server_lock_ok    INTEGER NOT NULL DEFAULT 0,
  server_lock_error TEXT,
  acquired_at       INTEGER NOT NULL,
  expires_at        INTEGER,                -- TTL; NULL = until released
  released_at       INTEGER,
  note              TEXT
);
CREATE UNIQUE INDEX idx_locks_active ON locks(share_id, rel_path) WHERE released_at IS NULL;

CREATE TABLE file_versions (
  id          INTEGER PRIMARY KEY,
  share_id    INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path    TEXT NOT NULL,
  hash        TEXT NOT NULL,               -- sha256, also the blob address
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('server','tnc','restore','initial','conflict_loser')),
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0   -- pinned versions are never pruned
);
CREATE INDEX idx_ver_path ON file_versions(share_id, rel_path, created_at DESC);
CREATE INDEX idx_ver_hash ON file_versions(hash);

CREATE TABLE sync_events (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  share_id    INTEGER,
  rel_path    TEXT,
  direction   TEXT CHECK (direction IN ('pull','push','none')),
  action      TEXT NOT NULL,               -- copy|delete|mkdir|rename|skip|defer|verify
  bytes       INTEGER,
  duration_ms INTEGER,
  result      TEXT NOT NULL CHECK (result IN ('ok','error','skipped','deferred')),
  message     TEXT
);
CREATE INDEX idx_ev_ts ON sync_events(ts DESC);

CREATE TABLE conflicts (
  id                 INTEGER PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  share_id           INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  rel_path           TEXT NOT NULL,
  mode_applied       TEXT NOT NULL,
  winner             TEXT NOT NULL CHECK (winner IN ('local','remote')),
  loser_version_id   INTEGER REFERENCES file_versions(id),
  winner_hash        TEXT, loser_hash TEXT,
  local_mtime        INTEGER, remote_mtime INTEGER,
  acknowledged       INTEGER NOT NULL DEFAULT 0,
  detail             TEXT
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,           -- sha256 of the cookie value
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT, user_agent TEXT,
  csrf_token   TEXT NOT NULL
);

CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,       -- sha256
  scopes       TEXT NOT NULL DEFAULT '["read"]',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE schedules (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('lock','unlock','update','restart','prune','scan','backup')),
  cron        TEXT NOT NULL,               -- 5-field, TZ from config
  target      TEXT,                        -- JSON: {shareId, pathGlob, ...}
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER, next_run_at INTEGER,
  last_result TEXT, last_error TEXT
);

CREATE TABLE metrics_samples (
  ts       INTEGER NOT NULL,
  metric   TEXT NOT NULL,                  -- sync.bytes_in, queue.depth, disk.used_pct, cpu.temp …
  share_id INTEGER,
  value    REAL NOT NULL,
  PRIMARY KEY (ts, metric, share_id)
) WITHOUT ROWID;

CREATE TABLE tnc_clients (
  id            INTEGER PRIMARY KEY,
  name          TEXT, mac TEXT UNIQUE, ip TEXT,
  model         TEXT,                      -- iTNC530 | TNC620 | TNC640 | other
  dhcp_static   INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER, last_seen_at INTEGER,
  notes         TEXT
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY,
  ts     INTEGER NOT NULL,
  actor  TEXT NOT NULL,                    -- admin | token:<name> | system
  action TEXT NOT NULL,
  target TEXT, ip TEXT, result TEXT, detail TEXT
);

CREATE TABLE update_history (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  from_version TEXT, to_version TEXT, channel TEXT,
  result       TEXT NOT NULL CHECK (result IN ('ok','failed','rolled_back')),
  log          TEXT
);
```

**Retention** (nightly prune job): `sync_events` 30 d, `metrics_samples` raw 7 d then hourly rollup 90 d,
`audit_log` 365 d, `conflicts` 180 d, versions per §4.

---

## 3. Sync engine specification

### 3.1 Verdict table (`diff-engine.ts` — pure function, exhaustively unit-tested)

Inputs: `local`, `remote`, `base` (each `{exists, size, mtime, hash}` — hash lazily computed), share
`conflict_mode`, active lock, server health.

| local vs base | remote vs base | Verdict |
|---|---|---|
| unchanged | unchanged | `NOOP` |
| changed | unchanged | `PUSH` |
| unchanged | changed | `PULL` (→ `DEFER` if TNC-locked) |
| deleted | unchanged | `DELETE_REMOTE` (→ `PULL` if `protect_deletes`) |
| unchanged | deleted | `DELETE_LOCAL` (→ `PUSH` if `protect_deletes`) |
| created | absent | `PUSH` |
| absent | created | `PULL` |
| changed | changed, `hash` equal | `CONVERGE` (update base only, no I/O) |
| changed | changed, `hash` differ | `CONFLICT` → mode |
| deleted | changed | `CONFLICT` → mode (delete never silently wins) |
| changed | deleted | `CONFLICT` → mode |

Hard overrides, applied in order:
1. server offline or `read_only` → all server-mutating verdicts become `DEFER`
2. path matches `exclude_patterns` → `EXCLUDE`
3. active TNC lock → `PULL`/`DELETE_LOCAL` become `DEFER`
4. size > `max_file_size_mb` → `SKIP` + warning event

### 3.2 Correctness rules

- **Atomicity:** every write is `<dir>/.tnc-tmp-<random>` → `fsync` → `rename()`. Never write in place.
- **Verification:** post-copy size + xxhash64 must match source, else delete temp and retry (3×, exponential backoff 1/5/25 s).
- **Echo suppression:** before writing, register `(path, expectedSize, expectedMtime)` in an in-memory
  `EchoGuard` with a 10 s TTL. The watcher/scanner drops matching events. Without this the engine
  ping-pongs its own writes forever — this is the classic bidirectional-sync failure mode.
- **Clock skew:** `last_write_wins` uses mtime, but mtimes come from three clocks. Ties within a
  configurable `mtime_tolerance_ms` (default 2000) fall through to `tnc_wins`, because the operator at the
  machine is the more authoritative and more recent actor. NTP is enforced by `install.sh`.
- **Case collisions:** SMB is case-insensitive, ext4 is not. `rel_path_ci` catches `PROG.H` vs `prog.h`;
  a collision is an `error` state with an explicit log line, never a silent overwrite.
- **HEIDENHAIN filename validation:** on `PULL`, names are checked against the target control's constraints
  (uppercase, CP850-encodable, length limits, allowed extensions `.H .I .NC .T .TAB .PNT .CDT .DEP .PGM .CMA`).
  Violations are surfaced as a warning with the offending name — a program the control cannot open is worse
  than one that never arrived.
- **Deletion safety:** `protect_deletes` (default **on**) converts remote deletions into a version capture +
  local retain, so a mis-click on the server cannot wipe programs off the shop floor.

### 3.3 Throttling

Token bucket over the transfer stream (`bandwidth_limit_kbps`, refill 10×/s), plus `p-limit` concurrency
(default 4, 1 when a bandwidth limit is set to keep the limit meaningful). Schedule-aware: a `bandwidth`
schedule entry can lower the cap during production hours. Link speed read from
`/sys/class/net/<if>/speed` and shown in the UI as context.

---

## 4. Versioning

Content-addressed blob store at `/var/lib/tnc-bridge/versions/<sha256[0:2]>/<sha256>`. Identical content
across paths and times is stored once. Blobs are written with the same temp+rename discipline and are
read-only (`0440`).

**Capture triggers:** before any overwrite of the local cache (`PULL`), before any overwrite on the server
(`PUSH`), always for the losing side of a `CONFLICT`, and on the first index of an existing file (`initial`).

**Retention** (configurable, evaluated per path): keep last **N=20** versions, **and** all versions younger
than **90 days**, **and** never exceed a global cap (default **10 GB** or 25 % of free disk, whichever is
smaller); pinned versions are exempt. GC deletes blobs with zero referencing rows.

**Restore** writes the blob into the cache as a normal local change, which the engine then pushes to the
server through the ordinary path — and the pre-restore content is itself captured first. Restore is
therefore always reversible.

---

## 5. REST API v1

`https://<host>/api/v1`. Auth: session cookie (UI) **or** `X-API-Key` (machines, read-only scope).
Envelope: `{ "ok": true, "data": … }` / `{ "ok": false, "error": { "code", "message", "details" } }`.
All bodies validated by shared Zod schemas; the same schemas type the frontend client.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/login` · `/auth/logout` | Session lifecycle (rate-limited) |
| GET | `/auth/session` | Current session + CSRF token |
| POST | `/auth/password` | Change admin password |
| GET | `/status` | Aggregate: shares, sync, server health, locks, version |
| GET | `/health` | Unauthenticated, localhost only — systemd watchdog + update health gate |
| GET | `/metrics` | JSON time series |
| GET | `/metrics/prometheus` | Prometheus text exposition |
| GET | `/metrics/prtg` | **PRTG "HTTP Data Advanced"** shape: `{"prtg":{"result":[{"channel","value","unit","limit*"}]}}` |
| GET/PUT | `/config/:section` | `network·smb·sync·security·updates·dhcp·logging·versioning` |
| POST | `/config/test/smb` · `/test/ad` · `/test/network` | Connectivity probes with structured diagnostics |
| GET/POST | `/shares` · GET/PATCH/DELETE `/shares/:id` | Share CRUD |
| POST | `/shares/:id/{scan,resync,pause,resume,mount,unmount}` | Share actions |
| GET | `/files?share=&path=&state=&q=` | Index browser (paginated) |
| GET/POST | `/locks` · DELETE `/locks/:id` | List / manual lock / force release |
| GET | `/conflicts` · POST `/conflicts/:id/{resolve,acknowledge}` | Conflict review |
| GET | `/versions?share=&path=` · GET `/versions/:id/download` · POST `/versions/:id/{restore,pin}` · DELETE `/versions/:id` | Version history |
| GET | `/logs?source=&level=&since=&q=&limit=` | Log query |
| GET | `/logs/stream` · `/events/stream` | **SSE** — log tail, live status/sync/lock events |
| GET | `/system` | Disk, CPU, memory, SoC temp, uptime, interfaces, throttling flags |
| GET/POST/PATCH/DELETE | `/schedules[/:id]` | Cron entries |
| GET | `/update/status` · POST `/update/{check,apply,rollback}` · GET `/update/history` | Self-update |
| GET/POST | `/certificates` · POST `/certificates/regenerate` | TLS material |
| GET/PUT | `/firewall` · POST `/firewall/reset` | nftables rules |
| GET | `/fail2ban/status` · POST `/fail2ban/unban` | Ban management |
| GET/PATCH | `/tnc-clients[/:id]` | Discovered machines + DHCP reservations |
| GET/POST/DELETE | `/tokens[/:id]` | API tokens (value shown once) |
| GET/POST | `/setup/*` | Wizard — 410 Gone once completed |
| POST | `/system/{restart-service,reboot}` | Controlled restarts |

OpenAPI 3.1 is generated from the Zod schemas (`zod-to-openapi`) and served at `/api/v1/openapi.json`.

---

## 6. Configuration keys (defaults)

```
network.lan.interface        eth0        network.tnc.interface       eth1
network.tnc.address          192.168.42.1/24
network.ipv6.enabled         false       network.mtu                 1500
dhcp.enabled                 false       dhcp.range                  192.168.42.100-192.168.42.199
dhcp.lease_time              12h         dhcp.dns                    192.168.42.1

smb.server.min_protocol      SMB3_11     smb.server.seal             true
smb.tnc.max_protocol         SMB3        smb.tnc.min_protocol        NT1
smb.tnc.ntlm_auth            true        smb.tnc.lanman_auth         false
smb.tnc.dos_charset          CP850       smb.tnc.workgroup           WORKGROUP

sync.conflict_mode           last_write_wins   sync.mtime_tolerance_ms   2000
sync.scan_interval_ms        15000       sync.concurrency            4
sync.bandwidth_limit_kbps    null        sync.protect_deletes        true
sync.exclude_patterns        ["**/.DS_Store","**/Thumbs.db","**/~$*","**/.tnc-tmp-*"]
sync.failover_read_only      true        sync.max_file_size_mb       512

locking.enabled              true        locking.server_projection   sidecar
locking.tnc_lock_ttl_s       900         locking.release_linger_s    5
locking.schedule_default     none        locking.block_pull_when_locked  true

versioning.enabled           true        versioning.keep_count       20
versioning.keep_days         90          versioning.max_store_gb     10

security.session_idle_min    30          security.session_absolute_h 12
security.login_max_attempts  5           security.fail2ban_enabled   true
security.firewall_default    allow       security.tls_min            TLSv1.2

updates.enabled              true        updates.channel             stable
updates.schedule_cron        "0 3 * * 0" updates.auto_restart        true
updates.github_repo          hsh36/tnc-network-bridge
updates.rollback_on_failure  true        updates.health_timeout_s    120

logging.level                info        logging.retain_days         30
monitoring.sample_interval_s 10          monitoring.disk_warn_pct    85
```

---

## 7. Implementation sequence

### Phase 0 — Foundation (T1–T9) · 38 h
Build tooling, shared Zod schemas, SQLite layer + migrations, config manager with encrypted secrets,
logger, **privileged helper**, service bootstrap, CI. Nothing user-visible; everything depends on it.
The helper lands here deliberately — retrofitting privilege separation later never happens.

### Phase 1 — Core (T10–T33) · 139 h
**Exit criterion:** a file dropped on the server share appears on a real TNC within 30 s; a file edited at
the TNC appears on the server; a file open on the TNC is locked and not overwritten; the dashboard shows
all of it over HTTPS.

Order: mount manager → Samba config/control → audit ingest → index/scanner/watcher → **diff engine** →
transfer + throttle + echo guard → orchestrator → failover → lock manager → HTTPS + auth → core routes →
SSE → frontend shell → dashboard.

The diff engine (T18) is the critical path. It is a pure function with no I/O, so it can be written and
fully tested before the transfer layer exists — and it should be, because everything downstream trusts it.

### Phase 2 — Features (T34–T48) · 82 h
Network/DHCP/firewall/Fail2Ban management, versioning + retention + restore, scheduler + lock windows,
auto-update with rollback, metrics + PRTG/Prometheus, configuration UI, multi-TNC UI.

### Phase 3 — Polish & Release (T49–T64) · 103 h
Remaining UI pages, setup wizard, `install.sh` + systemd packaging, the full test suite, resilience pass,
performance pass, security review, documentation.

**Total = 362 developer-hours** (≈ 9–10 weeks single-developer, ~5 weeks with Opus/Sonnet parallelism).

**Parallelism:** after Phase 0, Sonnet's frontend track (T32, T33, T44, T47–T52) runs concurrently with
Opus's backend track, synchronised only through the shared Zod contract in `src/shared/`. That contract is
therefore written first (T2) and treated as the interface between the two workstreams.

---

## 8. Risk assessment

| # | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | **Samba drops SMB1.** Upstream has been deprecating NT1 for years; a Debian upgrade could remove it. | Medium | **Fatal** | Pin + `apt-mark hold` samba in `install.sh`; startup asserts `smbd -b \| grep NT1` and refuses to run silently degraded; document building Samba from source; track upstream. **Verify on the target image before Phase 1 exit.** |
| R2 | **iTNC 530 auth quirks** — very old controls may need NTLMv1 or even LANMAN, or specific `guest ok` semantics. | High | High | `ntlm auth = yes` by default; `lanman_auth` and `raw NTLMv2` exposed as config toggles; connectivity tester reports the negotiated dialect and auth method; a compatibility matrix per control model in `docs/HEIDENHAIN.md`. |
| R3 | **Hard CIFS mount hangs the event loop** in uninterruptible `D` state. | Medium | **Fatal** | `soft,timeo=30,retrans=2` mandatory and asserted at mount; every server-side `fs` call wrapped in `withTimeout()`; server scanning runs in a **worker thread** so a stall cannot block the API; watchdog restarts on repeated stalls. |
| R4 | **inotify missed on CIFS** leads someone to "optimise away" the poller. | Medium | High | Documented in code comments and ARCHITECTURE §4.2; an integration test asserts remote-origin changes are detected *only* via scan. |
| R5 | **Sync loop / echo storm** — the engine reacts to its own writes. | High | High | `EchoGuard`; per-path rate limiter (max 10 syncs/min → quarantine + alert); circuit breaker per share; loop-detection test in CI. |
| R6 | **Sidecar locks are advisory** — a Windows user overwrites a file a TNC is running. | High | Medium | Documented explicitly; `byte_range` mode in Phase 2 for real SMB locks; conflict always version-captures the loser so nothing is unrecoverable. |
| R7 | **Charset mangling** (CP850 ↔ UTF-8) corrupts filenames with umlauts. | High | Medium | Explicit `dos charset`/`unix charset`; filename validator flags non-CP850-encodable names before transfer; round-trip test fixture with German umlauts. |
| R8 | **Clock skew** breaks last-write-wins. | Medium | High | `chrony` installed and enabled by `install.sh`; `mtime_tolerance_ms` tie-break; hash comparison decides "changed", mtime only decides "which won"; skew > 60 s raises a health warning. |
| R9 | **SD-card wear / corruption** from WAL + versions. | Medium | High | Recommend NVMe/SSD in docs; `synchronous=NORMAL` not `OFF`; nightly `PRAGMA integrity_check` + auto-backup of `bridge.db`; version store relocatable to external storage. |
| R10 | **Bad update bricks the appliance.** | Medium | **Fatal** | Atomic release directories + `current` symlink; checksum verification before swap; post-restart health gate (120 s) with automatic symlink rollback; previous release retained; `update_history` records everything. |
| R11 | **Admin lockout** via bad cert upload or firewall rule. | Medium | High | Cert validated (key/cert match, parseable, not expired) *before* replacement; firewall changes require confirm-within-60 s or auto-revert; `tnc-bridge-recover` CLI resets cert/firewall/password from console. |
| R12 | **Disk fills** (versions + logs + cache) and sync fails hard. | Medium | Medium | Disk watermarks: 85 % warn, 92 % stop accepting new versions + aggressive prune, 96 % pause sync in read-only. Free space checked before every transfer. |
| R13 | **Large-file / bulk-import stalls** the queue behind one 500 MB file. | Medium | Medium | Priority queue (small files first), per-file size cap, separate lane for bulk; progress events over SSE. |
| R14 | **`better-sqlite3` / `@node-rs/argon2` lack ARM64 prebuilds** for the installed Node. | Low | High | `install.sh` installs `build-essential python3` unconditionally; build verified in CI on `linux/arm64` via QEMU; Node version pinned so prebuild lookups are deterministic. |
| R15 | **Multi-TNC write contention** on one program. | Medium | Medium | Lock table is authoritative and unique per `(share, path)`; second opener gets no lock and its write is treated as a conflict with full version capture. |
| R16 | **`full_audit` log volume** floods the disk on a busy share. | Medium | Low | Success events limited to the eight needed verbs; ingest reads a dedicated syslog socket, not a file; rsyslog rule discards after forwarding; rate-limited. |
| R17 | **Waveshare Box-A second NIC** enumerates unpredictably (`eth1` vs `enx…`). | Medium | Medium | Interfaces selected by MAC-anchored NetworkManager profiles, never by kernel name; wizard shows a live NIC picker with link state and MAC. |

### Error-handling doctrine

1. **Typed results over exceptions** in the sync core — `Result<T, SyncError>`; exceptions only for programmer error.
2. **Classify every error** as `transient` (retry with exponential backoff + jitter, 3 attempts), `persistent`
   (mark file `error`, continue the queue, surface in UI), or `fatal` (halt that share, alert, keep others running).
3. **Never let one file stop a share, never let one share stop the bridge.**
4. **Circuit breakers** per share: 10 consecutive failures → pause 5 min → half-open probe.
5. **Degrade, don't die** — server gone means read-only, not a crash. Samba stays up so the shop floor keeps working.
6. **Every state transition is logged** with correlation IDs so a sync decision can be reconstructed after the fact.
7. **systemd** `Restart=always`, `RestartSec=5`, `WatchdogSec=60` — the process pings the watchdog only while
   the event loop is responsive, so a wedged loop is a restart, not a silent hang.
