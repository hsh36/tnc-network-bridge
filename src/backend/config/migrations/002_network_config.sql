-- Schema v2 — Network configuration tables (T34)
--
-- Adds tables to persist network interface configurations keyed by MAC address
-- (the stable identifier across reboots), with support for pending changes and
-- auto-revert timers.

-- ---------------------------------------------------------------------------
-- network_interface_config — Desired config for each MAC-identified interface
-- ---------------------------------------------------------------------------
CREATE TABLE network_interface_config (
  mac          TEXT PRIMARY KEY,                        -- Lowercase MAC address: b8:27:eb:00:11:22
  config       TEXT NOT NULL,                           -- JSON: InterfaceNetworkConfig
  stored_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------------------------------------------------------------------------
-- pending_network_change — Changes awaiting confirmation (apply-with-rollback)
-- ---------------------------------------------------------------------------
CREATE TABLE pending_network_change (
  mac          TEXT PRIMARY KEY,                        -- Which interface
  old_config   TEXT NOT NULL,                           -- JSON: InterfaceNetworkConfig (pre-change state)
  new_config   TEXT NOT NULL,                           -- JSON: InterfaceNetworkConfig (applied state)
  expires_at   INTEGER NOT NULL,                        -- Unix seconds: when auto-revert timer fires
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_pending_expires ON pending_network_change(expires_at);
