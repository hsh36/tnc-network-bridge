-- Schema v3 — DHCP server management (T35)
--
-- Wrapped in a transaction by the migration runner; this file must not open one.

-- ---------------------------------------------------------------------------
-- Rebuild tnc_clients to support DHCP static reservations
-- ---------------------------------------------------------------------------

-- Create new table with extended schema
CREATE TABLE tnc_clients_new (
  id            INTEGER PRIMARY KEY,
  name          TEXT,
  mac           TEXT UNIQUE,
  ip            TEXT,
  mac_address   TEXT UNIQUE,
  ip_address    TEXT,
  model         TEXT CHECK (model IS NULL OR model IN ('iTNC530', 'TNC620', 'TNC640', 'other')),
  dhcp_static   INTEGER NOT NULL DEFAULT 0 CHECK (dhcp_static IN (0, 1)),
  dhcp_reserved INTEGER NOT NULL DEFAULT 0 CHECK (dhcp_reserved IN (0, 1)),
  reserved_ip   TEXT,
  first_seen_at INTEGER,
  last_seen_at  INTEGER,
  created_at    INTEGER,
  updated_at    INTEGER,
  notes         TEXT
);

-- Copy data from old table
INSERT INTO tnc_clients_new (id, name, mac, ip, model, dhcp_static, first_seen_at, last_seen_at, notes)
SELECT id, name, mac, ip, model, dhcp_static, first_seen_at, last_seen_at, notes FROM tnc_clients;

-- Set created_at and updated_at for existing rows
UPDATE tnc_clients_new SET created_at = UNIXEPOCH(), updated_at = UNIXEPOCH() WHERE created_at IS NULL;

-- Copy MAC to mac_address for existing rows
UPDATE tnc_clients_new SET mac_address = mac WHERE mac IS NOT NULL AND mac_address IS NULL;

-- Copy IP to ip_address for existing rows
UPDATE tnc_clients_new SET ip_address = ip WHERE ip IS NOT NULL AND ip_address IS NULL;

-- Drop old table and rename new one
DROP TABLE tnc_clients;
ALTER TABLE tnc_clients_new RENAME TO tnc_clients;

-- Create indexes
CREATE UNIQUE INDEX idx_tnc_mac ON tnc_clients(mac_address) WHERE mac_address IS NOT NULL;

-- ---------------------------------------------------------------------------
-- discovered_machines — machines discovered on the TNC network
-- ---------------------------------------------------------------------------

CREATE TABLE discovered_machines (
  id            INTEGER PRIMARY KEY,
  mac_address   TEXT UNIQUE NOT NULL,
  ip_address    TEXT,
  hostname      TEXT,
  is_online     INTEGER NOT NULL DEFAULT 1 CHECK (is_online IN (0, 1)),
  dhcp_leased   INTEGER NOT NULL DEFAULT 0 CHECK (dhcp_leased IN (0, 1)),
  last_seen     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_machines_online ON discovered_machines(is_online);
CREATE INDEX idx_machines_last_seen ON discovered_machines(last_seen DESC);
