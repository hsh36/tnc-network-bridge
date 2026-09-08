# TNC Network Bridge — Task Breakdown

64 tasks · 362 developer-hours · 4 phases
Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)

**Legend** — Prio: `P0` blocker · `P1` core · `P2` feature · `P3` polish
**Owner** — `Opus`: architecture-critical, correctness-sensitive, privileged, or security code.
`Sonnet`: UI components, tests, scripts, docs, well-specified CRUD.

---

## Critical path

```
T2 → T3 → T4 → T5 → T8 → T10 → T12 → T15 → T18 → T22 → T24 → T27 → T30 → T33
     (contract)  (db)   (cfg)  (boot) (mount)(samba)(index)(diff)(orch)(lock)(https)(api)(ui)
```

T18 (diff engine) is the single highest-risk item. It is a **pure function with no I/O**, so write and
fully test it before the transfer layer exists.

---

## Phase 0 — Foundation · T1–T9 · 38 h

### T1: Build tooling & repo scaffold
├─ TS 5 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), project references
   `shared → backend|frontend`; ESLint + @typescript-eslint + Prettier; Jest + ts-jest (backend),
   Vitest (frontend); Vite config with `/api` dev proxy; npm scripts per CLAUDE.md
   (`dev`, `build`, `test:sync`, `test:smb`, `test:web`); populate the currently-empty `dependencies`.
├─ Dependencies: —
├─ Owner: Sonnet · Prio: P0 · Est: 4 h
└─ AC: `npm run build`, `lint`, `type-check`, `test` all pass on a clean clone; frontend and backend build independently.

### T2: Shared contract — Zod schemas & types
├─ `src/shared/schemas/` for config sections, share, file-index entry, lock, version, conflict, log entry,
   metrics, and the API request/response envelope; `api-contract.ts` mapping every endpoint to its types.
   **This is the interface between the Opus backend track and the Sonnet frontend track** — it must be
   correct and stable before either track scales up.
├─ Dependencies: T1
├─ Owner: Opus · Prio: P0 · Est: 4 h
└─ AC: every §5 endpoint has request+response schemas; types inferred, never hand-written; frontend imports compile with zero backend imports.

### T3: SQLite layer & migration runner
├─ better-sqlite3 wrapper: WAL, `foreign_keys=ON`, `busy_timeout`, prepared-statement cache, typed
   `query`/`exec`/`transaction` helpers; forward-only numbered migration runner on `PRAGMA user_version`,
   one transaction per file; nightly `integrity_check` hook.
├─ Dependencies: T1
├─ Owner: Opus · Prio: P0 · Est: 4 h
└─ AC: migrations apply from empty and are idempotent on restart; a failing migration rolls back cleanly; concurrent read/write under WAL proven by test.

### T4: Schema v1 migration
├─ All 14 tables from IMPLEMENTATION_PLAN §2 with indexes, CHECK constraints, and the partial unique index
   on active locks; seed default config rows.
├─ Dependencies: T3
├─ Owner: Opus · Prio: P0 · Est: 4 h
└─ AC: schema matches the plan exactly; constraint violations proven by test (duplicate active lock rejected, bad `conflict_mode` rejected).

### T5: Config Manager + secret encryption
├─ Typed `get`/`set` over the `config` table with Zod validation and defaults; change-event emitter so
   subsystems react to config updates without restart; AES-256-GCM envelope for secrets keyed from
   `/etc/tnc-bridge/secret.key`; API-safe redaction (`********` out, sentinel in = unchanged).
├─ Dependencies: T2, T4
├─ Owner: Opus · Prio: P0 · Est: 5 h
└─ AC: invalid values rejected with a useful message; secrets never appear in logs, API responses, or error output (asserted by test); subscribers fire on change.

### T6: Logging infrastructure
├─ pino with four sinks: journald (stdout), rotating JSON files (`app.log`, `sync.log`), a SQLite sink for
   the UI log viewer, and plaintext `auth.log` in the **exact format the Fail2Ban regex expects**;
   correlation IDs, child loggers per subsystem, redaction of secret fields.
├─ Dependencies: T3
├─ Owner: Sonnet · Prio: P0 · Est: 3 h
└─ AC: one log call reaches all configured sinks; rotation and retention verified; `auth.log` line matches the T37 regex in a shared test fixture.

### T7: Privileged helper + sudoers allowlist
├─ Separate binary run as root via a single sudoers rule. Exactly 11 verbs (ARCHITECTURE §5.4). Every
   argument validated inside the helper against strict allowlists; `execve` with an argv array, **never a
   shell**; all invocations written to the audit log. Landing this in Phase 0 is deliberate — privilege
   separation retrofitted later never happens.
├─ Dependencies: T1, T6
├─ Owner: Opus · Prio: P0 · Est: 6 h
└─ AC: injection attempts (`;`, `$()`, backticks, `..`, absolute paths outside roots) rejected with a test per verb; unknown verbs rejected; sudoers file passes `visudo -c`; helper refuses to run if not uid 0.

### T8: Service bootstrap & lifecycle
├─ `src/backend/index.ts`: DI container, ordered subsystem startup/shutdown, graceful SIGTERM (drain
   transfers, checkpoint WAL, release locks, unmount), systemd watchdog ping gated on event-loop
   responsiveness, `--check` self-test mode.
├─ Dependencies: T5, T6
├─ Owner: Opus · Prio: P0 · Est: 4 h
└─ AC: clean start/stop with no dangling handles; SIGTERM during an active transfer leaves no `.tnc-tmp-*` files and no orphaned locks; watchdog stops pinging when the loop is blocked.

### T9: CI pipeline
├─ GitHub Actions: lint, type-check, unit + API tests, coverage gate, frontend build, `linux/arm64` native
   module build via QEMU (guards R14), release workflow producing a **prebuilt** tarball (`dist/` included —
   the Pi must never compile the frontend) with a SHA256 manifest.
├─ Dependencies: T1
├─ Owner: Sonnet · Prio: P1 · Est: 4 h
└─ AC: PR checks green; tagging `v*` publishes a release asset + checksum consumable by T43.

---

## Phase 1 — Core · T10–T33 · 139 h

**Exit criterion:** a file dropped on the server share reaches a real TNC in < 30 s; a TNC edit reaches the
server; a file open on the TNC is locked and never overwritten; the HTTPS dashboard shows all of it.

### T10: CIFS mount manager
├─ Mount/unmount/remount with the mandatory option set (`soft` — see R3), credentials file written `0600`
   and shredded after use, mount health probe (marker file stat with timeout), reconnect with exponential
   backoff 15→300 s, `EIO`/`ESTALE`/`ENOTCONN` classification, `withTimeout()` wrapper for all server-side fs calls.
├─ Dependencies: T5, T7
├─ Owner: Opus · Prio: P0 · Est: 6 h
└─ AC: server disappearing mid-operation surfaces a typed transient error within `timeo` and never blocks the event loop; auto-remount on return; `hard` mounts rejected by assertion.

### T11: SMB connectivity tester
├─ `smbclient -L` + a scripted write/read/delete probe; reports negotiated dialect, auth method, signing,
   encryption, share list, and free space; maps common failures (`NT_STATUS_LOGON_FAILURE`,
   `ACCESS_DENIED`, `BAD_NETWORK_NAME`, clock skew) to actionable German+English messages.
├─ Dependencies: T10
├─ Owner: Opus · Prio: P1 · Est: 4 h
└─ AC: powers the "Verbindung testen" button with a structured result; wrong password vs wrong share name vs firewall are distinguishable.

### T12: smb.conf generator
├─ Handlebars template → validated config: NT1 min protocol, `ntlm auth`, signing disabled, CP850 dos
   charset, `interfaces = <tnc-if>` + `bind interfaces only = yes` (**security-critical**), `full_audit`
   VFS with the eight verbs, per-share sections, `veto files` for temp/sidecar/version paths, `wide links = no`.
   Written via the helper, `testparm`-validated **before** activation, previous config kept for rollback.
├─ Dependencies: T5, T7
├─ Owner: Opus · Prio: P0 · Est: 6 h
└─ AC: `testparm -s` clean; smbd verified listening on the TNC interface **only** (asserted by test — a LAN-side SMB1 listener is the vulnerability this product exists to remove); invalid config never activated.

### T13: Samba service control & smbstatus
├─ Reload (`smbcontrol all reload-config`) vs restart decisions, service state, `smbstatus --json` parsing
   into sessions/open-files/locks with a fallback text parser for older builds, startup assertion that the
   installed smbd actually supports NT1 (guards R1).
├─ Dependencies: T12
├─ Owner: Opus · Prio: P1 · Est: 4 h
└─ AC: open files on the TNC appear in parsed output; reload applies config without dropping connections; missing NT1 support fails startup loudly instead of degrading silently.

### T14: full_audit event ingestion
├─ Dedicated syslog LOCAL5 socket (not a file tail — R16), line parser for
   `open|close|write|pwrite|rename|unlink|mkdir|rmdir` with `%I|%u|%S` prefix → typed events with client IP,
   share, and path; backpressure-safe queue, rate limiting, resilience to malformed and partial lines.
├─ Dependencies: T13, T6
├─ Owner: Opus · Prio: P0 · Est: 6 h
└─ AC: a TNC opening a file produces a typed `open` event in < 200 ms; malformed lines are dropped with a counter, never a crash; sustained 1000 events/s does not grow memory.

### T15: File index & server scanner
├─ Recursive `readdir`+`stat` walk of the CIFS mount in a **worker thread** (so a stall cannot block the
   API — R3), incremental diff against `file_index`, exclude patterns via picomatch, `rel_path_ci`
   maintenance for case-collision detection, adaptive interval (5–120 s based on observed change rate),
   deletion detection by generation counter.
├─ Dependencies: T4, T10
├─ Owner: Opus · Prio: P0 · Est: 8 h
└─ AC: 10 000 files scanned in < 2 s on a Pi 5; changes made by another SMB client are detected (the test that proves R4/D4); memory flat across 100 consecutive scans.

### T16: Hash service
├─ `hash-wasm` streaming xxhash64 (change detection) and sha256 (version blob addressing); LRU cache keyed
   on `(path, size, mtime, dev, ino)`; concurrency-limited; skips hashing when the cheap `(size, mtime)`
   check already says unchanged.
├─ Dependencies: T1
├─ Owner: Sonnet · Prio: P1 · Est: 3 h
└─ AC: correct against reference vectors; 100 MB hashed without memory growth; cache hit avoids re-read.

### T17: Local cache watcher
├─ chokidar with native inotify (`usePolling: false`), `awaitWriteFinish` (750 ms stability) so a
   half-written TNC file is never synced, per-path debounce, atomic-rename detection, `ENOSPC` inotify-limit
   handling with a clear remediation message.
├─ Dependencies: T4
├─ Owner: Opus · Prio: P0 · Est: 4 h
└─ AC: a slow 10 MB write fires exactly one stable event; rename produces a rename, not delete+create; watcher survives directory deletion and recreation.

### T18: Diff & decision engine ⭐ **critical path**
├─ Pure function implementing the full verdict table (IMPLEMENTATION_PLAN §3.1) over the
   `(base, local, remote)` triple, all three conflict modes, mtime-tolerance tie-break, the four hard
   overrides (offline, excluded, locked, oversized), and delete-vs-change conflicts. **No I/O whatsoever** —
   which is exactly why it can be written and fully tested before anything downstream exists.
├─ Dependencies: T2, T4
├─ Owner: Opus · Prio: P0 · Est: 10 h
└─ AC: every row of the verdict table covered by an explicit unit test; 100 % branch coverage; property-based test asserts the invariant *no verdict ever discards data without a version capture*; zero I/O imports in the module.

### T19: Transfer executor
├─ Streamed copy to `.tnc-tmp-<random>` → `fsync` → `rename()`; post-copy size + xxhash64 verification;
   mtime/permission preservation; retry 3× with exponential backoff on transient errors; free-space
   precheck; temp cleanup on every failure path and on startup; directory create/delete; rename optimisation.
├─ Dependencies: T16, T10, T18
├─ Owner: Opus · Prio: P0 · Est: 6 h
└─ AC: a transfer killed mid-flight (SIGKILL) leaves the destination untouched and no temp files after restart; corrupted copies are detected by hash and retried; disk-full aborts cleanly.

### T20: Bandwidth throttle & concurrency queue
├─ Token-bucket `Transform` stream (refill 10×/s), `p-limit` concurrency, priority queue (small files
   first — R13), schedule-aware limit changes applied to in-flight transfers, link speed from `/sys/class/net`.
├─ Dependencies: T19
├─ Owner: Opus · Prio: P1 · Est: 5 h
└─ AC: measured throughput within ±10 % of the configured cap over 60 s; limit changes take effect without aborting transfers; a large file cannot starve small ones.

### T21: Echo guard
├─ In-memory registry of `(path, expectedSize, expectedMtime)` with 10 s TTL registered before every write;
   watcher and scanner events matching an entry are dropped. Plus a per-path rate limiter (>10 syncs/min →
   quarantine + alert) as the backstop against loop storms (R5).
├─ Dependencies: T17, T19
├─ Owner: Opus · Prio: P0 · Est: 4 h
└─ AC: a full sync cycle generates zero self-triggered follow-up syncs (the explicit anti-loop test); an artificially induced loop trips the quarantine within 60 s.

### T22: Sync orchestrator
├─ Per-share state machine (`idle → scanning → syncing → paused/error/offline`), event intake from watcher +
   scanner + audit, verdict dispatch to the queue, base-state commit after success, retry scheduling with
   `next_retry_at`, circuit breaker (10 consecutive failures → 5 min pause → half-open probe), pause/resume,
   full-resync, progress events.
├─ Dependencies: T18, T19, T20, T21, T15, T17
├─ Owner: Opus · Prio: P0 · Est: 8 h
└─ AC: **end-to-end bidirectional sync works against a dockerised Samba server**; one failing file does not stop the share; one failing share does not stop the bridge; state survives restart mid-sync.

### T23: Read-only failover controller
├─ Health probe with 3-strike debounce (~30 s), transition to read-only: flip `read only = yes` in the
   share section, `smbcontrol all reload-config`, pause server-mutating verdicts while preserving queue
   state, banner + API status; automatic recovery with a verification pass on return.
├─ Dependencies: T10, T12, T22
├─ Owner: Opus · Prio: P1 · Est: 5 h
└─ AC: pulling the LAN cable puts the share read-only within 30 s while the TNC can still **read** every cached program; reconnect restores read-write and reconciles changes made while offline.

### T24: Lock Manager core
├─ Acquire/release/renew with TTL and expiry sweeper, DB-backed with the partial unique index enforcing one
   active lock per `(share, path)`, origin tracking (`tnc`/`manual`/`schedule`), crash recovery of orphaned
   locks at startup, lock events on the bus, force-release with audit entry.
├─ Dependencies: T4, T6
├─ Owner: Opus · Prio: P0 · Est: 6 h
└─ AC: concurrent acquire attempts — exactly one wins (R15); expired locks reaped; a lock survives restart but an orphan from a dead session does not.

### T25: TNC lock source
├─ Audit `open`(write intent) → acquire, `close` → release after `release_linger_s`; periodic `smbstatus`
   reconciliation as the authoritative correction for missed events; machine identification by IP → `tnc_clients`;
   handling of a TNC that opens a file and never closes it (TTL).
├─ Dependencies: T14, T13, T24
├─ Owner: Opus · Prio: P0 · Est: 6 h
└─ AC: opening a program on a real (or emulated) TNC creates a visible lock within 1 s and releases within `linger` of close; killing the SMB session releases the lock at the next reconcile; PULL to a locked path is deferred, not applied.

### T26: Server-side lock projection
├─ Sidecar `.~lock.<name>#` with owner/IP/machine/timestamp/bridge_id/TTL; creation and removal tied to the
   lock lifecycle; startup sweep removing **our own** stale sidecars only (never another bridge's — D5b);
   `veto files` so TNCs never see them; failure to project is a warning, not a sync blocker.
├─ Dependencies: T24, T10
├─ Owner: Opus · Prio: P1 · Est: 5 h
└─ AC: lock creates the sidecar on the server, release removes it; a crash leaves sidecars that are cleaned at next startup; other bridges' sidecars are respected and preserved; projection failure degrades gracefully.

### T27: HTTPS server & certificate manager
├─ Express + `node:https` on 443 via `CAP_NET_BIND_SERVICE` (not root); self-signed generation at install
   (10 y, SAN = hostname + all interface IPs + localhost); custom cert/key/chain upload **validated before
   replacement** (key matches cert, parseable, not expired — R11); hot reload without dropping the process;
   Helmet, HSTS, CSP without inline script; TLS 1.2 min.
├─ Dependencies: T5, T7
├─ Owner: Opus · Prio: P0 · Est: 5 h
└─ AC: HTTPS reachable on 443 as a non-root process; a malformed or mismatched upload is rejected and the old cert stays live (no lockout possible); cert swap needs no restart.

### T28: Authentication & sessions
├─ argon2id (m=64 MiB, t=3, p=4); 256-bit session IDs stored hashed; `HttpOnly; Secure; SameSite=Strict`;
   idle + absolute timeouts; CSRF double-submit; login rate limit 5/15 min/IP; every failure written to
   `auth.log` in the Fail2Ban-matched format; password change; session revocation.
├─ Dependencies: T4, T6, T27
├─ Owner: Opus · Prio: P0 · Est: 6 h
└─ AC: timing-safe verification; brute force blocked at the 6th attempt; sessions expire on both timers; CSRF-less mutation rejected; no session fixation (ID rotates on login).

### T29: API middleware stack
├─ Zod validation from the shared contract, uniform error envelope with codes, session **or** `X-API-Key`
   auth with scope enforcement (tokens are read-only), audit logging of all mutations, request-ID
   correlation, rate limiting, structured 4xx/5xx that never leak internals.
├─ Dependencies: T2, T28
├─ Owner: Opus · Prio: P0 · Est: 4 h
└─ AC: invalid bodies rejected with field-level detail; a read-only token cannot mutate anything (test per mutating route); stack traces never reach the client.

### T30: Core REST routes
├─ `/status`, `/health`, `/config/:section`, `/config/test/*`, `/shares` CRUD + actions, `/files`,
   `/locks`, `/conflicts`, `/system` — wired to the subsystems above.
├─ Dependencies: T29, T22, T24, T11
├─ Owner: Sonnet · Prio: P1 · Est: 8 h
└─ AC: every endpoint matches the shared contract; Supertest covers success + validation-failure + authz-failure per route.

### T31: SSE event bus
├─ Internal typed event bus → `/events/stream` and `/logs/stream`; per-client filtering, heartbeat, backpressure
   handling, client-count limit, replay of the last N events on reconnect.
├─ Dependencies: T29, T6, T22
├─ Owner: Sonnet · Prio: P1 · Est: 4 h
└─ AC: dashboard updates live with no polling; a slow client is dropped rather than growing server memory; reconnect resumes without a gap.

### T32: Frontend shell
├─ Vite + React 18 + Tailwind + Radix; app layout, navigation, routing, auth guard + login page, typed API
   client generated from the shared contract, TanStack Query setup, `useSSE` hook, toast/error boundary,
   dark mode, i18n scaffold (DE/EN — the operators are German-speaking).
├─ Dependencies: T2, T30
├─ Owner: Sonnet · Prio: P1 · Est: 8 h
└─ AC: login → dashboard flow works against the real API; bundle < 200 KB gzipped; 401 redirects to login and preserves the intended route.

### T33: Dashboard page
├─ Status tiles (server link, shares, sync state, active locks, disk), live throughput chart (Recharts),
   active-lock table, recent-event feed, conflict badge, share cards with pause/resume/resync — all fed by SSE.
├─ Dependencies: T32, T31
├─ Owner: Sonnet · Prio: P1 · Est: 8 h
└─ AC: reflects real backend state within 2 s of a change; usable at 1280×720 (typical shop-floor panel); no layout shift on update.

---

## Phase 2 — Features · T34–T48 · 82 h

### T34: Network configuration manager
├─ `nmcli` connection profiles **anchored to MAC addresses, not kernel names** (R17); static/DHCP per
   interface; IPv6 enable/disable (NM method + sysctl); MTU; apply-with-rollback (confirm within 60 s or revert);
   live interface enumeration with link state, speed, MAC.
├─ Dependencies: T7, T5
├─ Owner: Opus · Prio: P2 · Est: 6 h
└─ AC: interface changes survive reboot; a config that breaks admin reachability auto-reverts (no lockout); NIC identity is stable across reboots regardless of enumeration order.

### T35: DHCP server management
├─ dnsmasq config generation bound to the TNC interface only; range, lease time, gateway, DNS; static
   reservations from `tnc_clients`; lease-file parsing → discovered machines; enable/disable without
   touching the LAN side.
├─ Dependencies: T34, T7
├─ Owner: Sonnet · Prio: P2 · Est: 5 h
└─ AC: a TNC receives an address on the TNC segment; dnsmasq never listens on the LAN interface (asserted); leases appear in the UI; reservations survive restart.

### T36: Firewall manager
├─ nftables `table inet tnc_bridge`, additive to a default-accept policy per spec; rule CRUD (proto, port,
   source, interface, action); atomic ruleset apply with `nft -c` validation first; confirm-or-revert
   protection for admin lockout (R11); reset-to-default.
├─ Dependencies: T7
├─ Owner: Opus · Prio: P2 · Est: 5 h
└─ AC: rules apply atomically and persist across reboot; an invalid ruleset is rejected before load; a rule that would block the admin's own session triggers the revert timer.

### T37: Fail2Ban integration
├─ Ship `filter.d/tnc-bridge.conf` (regex against T6's `auth.log`) and `jail.d/tnc-bridge.local`
   (`maxretry=5 findtime=600 bantime=3600`); status/banned-IP query and unban via helper; enable/disable.
├─ Dependencies: T28, T7, T6
├─ Owner: Sonnet · Prio: P2 · Est: 4 h
└─ AC: `fail2ban-regex` matches real log lines from a shared fixture; 5 failed logins ban the IP; unban from the UI works.

### T38: Versioning engine
├─ Content-addressed blob store `/var/lib/tnc-bridge/versions/<ab>/<sha256>`, temp+rename writes, `0440`
   blobs, dedup by hash; capture hooks at all four trigger points (pre-PULL, pre-PUSH, conflict-loser,
   initial); metadata rows; disk-pressure awareness (R12).
├─ Dependencies: T16, T19, T4
├─ Owner: Opus · Prio: P2 · Est: 6 h
└─ AC: identical content across paths stored once; every overwrite path is preceded by a capture (asserted in the sync integration test); capture never blocks or fails a sync.

### T39: Version retention & GC
├─ Prune by keep-count / keep-days / global size cap with pinned exemption; orphan-blob GC; scheduled
   nightly; dry-run mode reporting what would be freed.
├─ Dependencies: T38, T41
├─ Owner: Sonnet · Prio: P2 · Est: 4 h
└─ AC: retention rules applied exactly as specified; no blob referenced by a live row is ever deleted; GC is interruptible and resumable.

### T40: Version restore
├─ Restore writes the blob into the cache as an ordinary local change (so the normal engine pushes it),
   capturing the pre-restore content first; restore-to-alternate-path; download a version directly.
├─ Dependencies: T38, T22
├─ Owner: Opus · Prio: P2 · Est: 4 h
└─ AC: restore propagates to the server through the normal path; **the restore is itself reversible** (pre-image captured); restoring a locked path is refused with a clear reason.

### T41: Scheduler
├─ `croner` engine, jobs registry, DB-persisted schedules, missed-run policy after downtime, next-run
   computation, manual trigger, per-job concurrency guard, result/error recording.
├─ Dependencies: T4, T8
├─ Owner: Opus · Prio: P2 · Est: 5 h
└─ AC: cron expressions validated on save; DST transitions handled; a long job never overlaps itself; schedules survive restart with correct next-run.

### T42: Lock/unlock schedule windows
├─ Scheduled lock windows over path globs (**default: none**, per spec); automatic acquire at window start
   and release at end; interaction rules with TNC-origin locks (a TNC lock always wins); UI preview of the next windows.
├─ Dependencies: T41, T24
├─ Owner: Sonnet · Prio: P2 · Est: 4 h
└─ AC: windows apply and release on time; scheduled locks never stomp a TNC lock; disabled by default on a fresh install.

### T43: Auto-update engine
├─ GitHub Releases polling on the configured channel; download + **SHA256 manifest verification before
   anything is swapped**; extract to `/opt/tnc-bridge/releases/<ver>`; `npm ci --omit=dev`; DB migration;
   flip the `current` symlink; `systemctl restart`; **health gate** polling `/health` for up to 120 s;
   automatic symlink rollback + restart on failure; retain the previous release; full `update_history`.
├─ Dependencies: T7, T9, T41, T8
├─ Owner: Opus · Prio: P2 · Est: 10 h
└─ AC: update applies and restarts unattended; a deliberately broken release is detected by the health gate and rolled back automatically with the service running the old version (R10); a corrupted download is rejected before the swap; migrations are not run twice.

### T44: Update UI & history
├─ Current/available version, changelog from the release body, check/apply/rollback actions with progress,
   schedule editor (weekday + time per spec), history table.
├─ Dependencies: T43, T32
├─ Owner: Sonnet · Prio: P2 · Est: 4 h
└─ AC: update progress visible live and survives the restart-induced reconnect; rollback reachable in one click.

### T45: Metrics collector
├─ Sampling of sync throughput in/out, queue depth, files/s, error rate, active locks, disk used/free, CPU,
   memory, SoC temperature, throttling flags, interface counters, uptime; raw 7 d → hourly rollup 90 d;
   efficient time-range queries.
├─ Dependencies: T4, T22, T41
├─ Owner: Opus · Prio: P2 · Est: 5 h
└─ AC: sampling overhead < 1 % CPU; rollups mathematically correct; `metrics_samples` growth bounded by retention.

### T46: PRTG, Prometheus & API tokens
├─ `/metrics/prtg` in the exact **HTTP Data Advanced** shape (`{"prtg":{"result":[{channel,value,unit,limit*}]}}`)
   with sensible warning/error limits per channel; `/metrics/prometheus` text exposition; token CRUD with
   one-time display, SHA-256 storage, read-only scope, last-used tracking.
├─ Dependencies: T45, T29
├─ Owner: Sonnet · Prio: P2 · Est: 4 h
└─ AC: PRTG parses the response without a custom script; Prometheus scrapes cleanly; a token cannot mutate anything; revoked tokens are rejected immediately.

### T47: Configuration UI
├─ Form pages for network, SMB, AD credentials (+ **Verbindung testen** with structured results), sync
   behaviour, conflict mode, exclude patterns, locking, versioning, security/session, certificates,
   firewall, DHCP, updates — all driven by the shared Zod schemas so validation is identical client and server.
├─ Dependencies: T32, T30, T34, T35, T36, T27
├─ Owner: Sonnet · Prio: P2 · Est: 10 h
└─ AC: client validation mirrors the server exactly (same schema, no duplication); unsaved-changes guard; secrets shown as `********` and only sent when actually changed; every destructive action confirms.

### T48: Multi-TNC & share management UI
├─ Discovered machines (DHCP leases + SMB sessions + audit activity), naming, model, static reservations,
   per-machine activity; share list/create/edit with per-share conflict mode, excludes, bandwidth, read-only.
├─ Dependencies: T47, T35, T30
├─ Owner: Sonnet · Prio: P2 · Est: 6 h
└─ AC: multiple simultaneous TNCs are listed with live activity; per-share settings apply without a restart.

---

## Phase 3 — Polish & Release · T49–T64 · 103 h

### T49: Logs page
├─ Unified viewer over sync/error/audit/system sources; filters (level, source, share, time range,
   full-text), live tail via SSE with pause/resume, virtualised list for large volumes, export CSV/JSON,
   deep-link to a file's history.
├─ Dependencies: T32, T31, T30
├─ Owner: Sonnet · Prio: P3 · Est: 6 h
└─ AC: 10 000 rows scroll smoothly; filters compose; live tail does not leak memory over an hour.

### T50: Monitoring page
├─ Time-series charts (throughput, queue depth, error rate, CPU/mem/temp), disk usage incl. version store
   breakdown, share health, system info, selectable ranges (1 h/24 h/7 d/30 d).
├─ Dependencies: T32, T45
├─ Owner: Sonnet · Prio: P3 · Est: 6 h
└─ AC: charts render from real data; range switching is responsive; theme-correct in light and dark.

### T51: Locks & conflicts page
├─ Active locks with origin/machine/age and force-release; lock history; conflict list with both sides'
   metadata, applied mode, link to the preserved losing version, restore, acknowledge.
├─ Dependencies: T32, T30, T40
├─ Owner: Sonnet · Prio: P3 · Est: 5 h
└─ AC: force-release requires confirmation and is audited; every conflict row links to a recoverable version (the visible proof of the no-data-loss invariant).

### T52: File browser & version history
├─ Tree/list browser over the index with per-file state, search, filters; version timeline with size/time/origin,
   preview for text NC programs, restore, download, pin.
├─ Dependencies: T32, T30, T38, T40
├─ Owner: Sonnet · Prio: P3 · Est: 6 h
└─ AC: browsing 10 000 files stays responsive (virtualised + paginated); restore reachable in ≤ 3 clicks; preview handles CP850 text correctly.

### T53: Setup wizard
├─ Backend state machine + UI steps: admin password → interface selection (live NIC picker with MAC/link) →
   TNC network + optional DHCP → server share + AD credentials + **connectivity test** → share/sync config →
   certificate → review & apply. Resumable, validated per step, `/setup/*` returns 410 once completed.
├─ Dependencies: T47, T27, T28, T34, T11, T12
├─ Owner: Opus · Prio: P3 · Est: 8 h
└─ AC: a fresh install reaches a working synced bridge through the wizard alone, with no shell access; each step validates before advancing; interruption resumes where it stopped.

### T54: install.sh — the one-liner
├─ OS/arch/model verification; apt deps (samba, cifs-utils, dnsmasq, nftables, fail2ban, chrony,
   build-essential, python3 — R14); NodeSource **Node 22** pin; `apt-mark hold samba` (R1); `tncbridge`
   user; directory tree with correct ownership/modes; `secret.key` generation; sysctl
   (`fs.inotify.max_user_watches=524288`); self-signed cert; DB init; systemd install + enable; idempotent
   re-run; clear post-install message with the wizard URL. Must run correctly under `curl … | bash`.
├─ Dependencies: T55, T9, T27
├─ Owner: Opus · Prio: P3 · Est: 8 h
└─ AC: **clean Raspberry Pi OS Lite 64-bit → working bridge with a single command**; re-running is safe; every failure exits non-zero with an actionable message and no half-configured state.

### T55: systemd units & packaging
├─ `tnc-bridge.service` with `Restart=always`, `RestartSec=5`, `WatchdogSec=60`,
   `AmbientCapabilities=CAP_NET_BIND_SERVICE`, and hardening (`NoNewPrivileges`, `ProtectSystem=strict`,
   `ProtectHome`, `PrivateTmp`, `ReadWritePaths` limited to our four runtime paths); `systemd-setup.sh`;
   sudoers, Fail2Ban, and config templates packaged.
├─ Dependencies: T8, T7
├─ Owner: Opus · Prio: P3 · Est: 4 h
└─ AC: `systemd-analyze security` score materially better than default; service survives reboot; hardening does not break the helper or the mounts (verified, not assumed).

### T56: Backup, restore & recovery CLI
├─ Config export/import (secrets re-encrypted, never exported in plaintext), DB backup via SQLite
   `.backup`, scheduled nightly backup, `uninstall.sh` with a data-retention choice, and
   **`tnc-bridge-recover`** — a console tool to reset the admin password, regenerate the certificate, and
   flush the firewall (the answer to R11 lockout).
├─ Dependencies: T55, T5, T41
├─ Owner: Sonnet · Prio: P3 · Est: 4 h
└─ AC: export→import on a fresh device reproduces the configuration; recovery tool works from a serial/HDMI console with no network; uninstall leaves no orphaned units, users, or sudoers entries.

### T57: Unit test suite
├─ Diff engine (exhaustive verdict table + property tests), lock manager concurrency, config manager +
   secret redaction, throttle accuracy, echo guard, retention rules, path safety/traversal, HEIDENHAIN
   filename validation, smb.conf generation snapshots.
├─ Dependencies: T18, T24, T5, T20, T21, T39, T12
├─ Owner: Sonnet · Prio: P3 · Est: 10 h
└─ AC: ≥ 80 % overall coverage, **100 % branch coverage on `diff-engine.ts`**; suite runs in < 60 s; no flakes across 10 consecutive runs.

### T58: Integration test suite
├─ Testcontainers: a Samba server as the "corporate server" plus an SMB1 client as a simulated TNC.
   Scenarios: bidirectional sync, all three conflict modes, lock-blocks-overwrite, read-only failover and
   recovery, server-drops-mid-transfer, echo-loop absence, remote-change-needs-scan (proves R4), CP850
   umlaut round-trip (R7), large file, 10 000 small files.
├─ Dependencies: T22, T23, T25, T26, T15
├─ Owner: Opus · Prio: P3 · Est: 10 h
└─ AC: all scenarios pass in CI on `linux/arm64` and `amd64`; no data loss in any scenario (the central acceptance criterion of the whole product); suite is deterministic.

### T59: API test suite
├─ Supertest across every route: success, validation failure, unauthenticated, wrong-scope token, CSRF
   missing, rate limit; SSE stream tests; OpenAPI conformance check.
├─ Dependencies: T30, T29, T46
├─ Owner: Sonnet · Prio: P3 · Est: 6 h
└─ AC: every endpoint has all six cases; no route is reachable without correct auth (enumerated, not sampled); responses conform to the shared schemas.

### T60: Frontend test suite
├─ Vitest + Testing Library for components, hooks, forms (validation parity with the server), SSE handling;
   MSW-mocked API; smoke tests per page.
├─ Dependencies: T33, T47, T49, T50, T51, T52
├─ Owner: Sonnet · Prio: P3 · Est: 5 h
└─ AC: critical flows (login, config save, restore, force-release) covered; forms reject exactly what the server rejects.

### T61: Resilience & error-handling pass
├─ Audit every subsystem against the doctrine in IMPLEMENTATION_PLAN §8: typed `Result` in the sync core,
   error classification, timeouts on all external calls, circuit breakers, disk watermarks (85/92/96 %),
   inotify-limit handling, SQLite `SQLITE_BUSY` retry, graceful degradation everywhere. Add chaos tests
   (kill mount, fill disk, kill smbd, SIGKILL mid-transfer, corrupt the DB).
├─ Dependencies: T22, T23, T43, T10
├─ Owner: Opus · Prio: P3 · Est: 6 h
└─ AC: every chaos scenario ends in a recoverable state with a clear log trail; no unhandled rejection or uncaught exception anywhere in the suite; no scenario loses data.

### T62: Performance pass
├─ Profile with 10 000+ files: SQLite index tuning and `ANALYZE`, batched transactions, scanner in a worker
   thread, memory profiling for leaks over 24 h, frontend virtualisation and bundle audit, startup time.
├─ Dependencies: T58, T15, T22
├─ Owner: Opus · Prio: P3 · Est: 6 h
└─ AC: 10 k-file scan < 2 s; steady-state RSS < 250 MB; idle CPU < 2 %; startup < 10 s; frontend bundle < 200 KB gzipped; no growth over a 24 h soak.

### T63: Security review & hardening
├─ Threat-model review against ARCHITECTURE §5; helper argument-validation audit (the single most important
   surface); secret handling audit (no secret in logs, API, core dumps, or exports); CSP without inline
   script; dependency audit + lockfile pinning; TLS cipher review; `npm audit` in CI; penetration checklist
   (traversal, injection, session fixation, CSRF, brute force, privilege escalation).
├─ Dependencies: T7, T27, T28, T29, T36, T37
├─ Owner: Opus · Prio: P3 · Est: 5 h
└─ AC: no high/critical findings open; every helper verb has a documented threat analysis and a rejection test; a compromised web tier is demonstrably unable to obtain root.
└─ Run `/security-review` as part of this task.

### T64: Documentation
├─ `README` (rewrite — the current one describes a generic bridge, not this HEIDENHAIN TNC-specific
   product), `INSTALL.md`, `ADMIN.md` (operations, backup, recovery, troubleshooting), `API.md` + generated
   OpenAPI, `HEIDENHAIN.md` (**per-control compatibility matrix, SMB settings, filename rules, known quirks —
   the highest-value document for the actual user**), `CONTRIBUTING.md`, architecture diagrams, changelog.
├─ Dependencies: T53, T54, T46, T58
├─ Owner: Sonnet · Prio: P3 · Est: 8 h
└─ AC: a technician who has never seen the project can install and configure it from the docs alone; every config key documented with default and effect; every REST endpoint documented with an example.

---

## Summary

| Phase | Tasks | Hours | Opus | Sonnet |
|---|---|---|---|---|
| 0 — Foundation | T1–T9 | 38 | 27 | 11 |
| 1 — Core | T10–T33 | 139 | 108 | 31 |
| 2 — Features | T34–T48 | 82 | 41 | 41 |
| 3 — Polish & Release | T49–T64 | 103 | 47 | 56 |
| **Total** | **64** | **362** | **223** | **139** |

**Suggested start:** T1 → T2 → T3 → T4 in sequence (they unlock everything), then run T5–T7 in parallel.
Once T2 is merged, the Sonnet frontend track (T32) can begin against mocked endpoints while the Opus
backend track builds T10–T22.

**Definition of done for the product:** an unattended Raspberry Pi, installed with one command, keeps a
corporate SMB 3.1.1 share and a shop floor of SMB 1.0 HEIDENHAIN controls in sync, never loses an edit,
never shows a machine a half-written program, and never exposes SMB 1.0 to the corporate LAN.
