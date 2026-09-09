-- Schema v4 — per-side network configuration
--
-- Wrapped in a transaction by the migration runner; this file must not open one.
--
-- MTU and IPv6 used to be single values covering both NICs, and the TNC side had no
-- addressing method at all because it was always static. The schema now describes each
-- side independently, so those values have to be carried across rather than left to be
-- silently replaced by defaults: an operator who set an MTU of 9000 for a jumbo-frame
-- LAN would otherwise find it back at 1500 after an update, with nothing said.
--
-- `ConfigManager.materialiseDefaults()` fills any key still missing after this, so only
-- the keys carrying an operator's choice need moving here.

-- MTU: one value becomes two, both starting from what was in force.
INSERT OR IGNORE INTO config (key, value, is_secret, updated_at, updated_by)
SELECT 'network.lan.mtu', value, 0, updated_at, 'migration'
FROM config WHERE key = 'network.mtu';

INSERT OR IGNORE INTO config (key, value, is_secret, updated_at, updated_by)
SELECT 'network.tnc.mtu', value, 0, updated_at, 'migration'
FROM config WHERE key = 'network.mtu';

-- IPv6: likewise, and the key loses its `.enabled` nesting.
INSERT OR IGNORE INTO config (key, value, is_secret, updated_at, updated_by)
SELECT 'network.lan.ipv6', value, 0, updated_at, 'migration'
FROM config WHERE key = 'network.ipv6.enabled';

INSERT OR IGNORE INTO config (key, value, is_secret, updated_at, updated_by)
SELECT 'network.tnc.ipv6', value, 0, updated_at, 'migration'
FROM config WHERE key = 'network.ipv6.enabled';

-- The TNC side was implicitly static: it carried a fixed address and no method field.
-- Recording that explicitly keeps an existing bridge on the addressing it already has,
-- instead of adopting the new schema's DHCP default for a segment where nothing serves
-- DHCP until the operator turns it on.
INSERT OR IGNORE INTO config (key, value, is_secret, updated_at, updated_by)
SELECT 'network.tnc.method', '"static"', 0, updated_at, 'migration'
FROM config WHERE key = 'network.tnc.address';

-- The superseded keys. Leaving them would not break parsing — the section schema strips
-- unknown keys — but they would sit in the table forever, contradicting the live values.
DELETE FROM config WHERE key IN ('network.mtu', 'network.ipv6.enabled');
