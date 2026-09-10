-- Schema v7 — per-share TNC-side credentials
--
-- Wrapped in a transaction by the migration runner; this file must not open one.
--
-- A share already carried the account it uses to reach the *server* (`smb_user`,
-- `smb_password`). It carried nothing about how a *machine* authenticates to the
-- bridge: the only control was `tnc_guest_ok`, so the choice was guest access or no
-- access. Guest access on a machine segment is defensible and often what a shop wants,
-- but it cannot be the only option — and it certainly cannot be the default, which is
-- what it was.
--
-- The password is an AES-256-GCM envelope (`secrets.ts`), never plaintext, with
-- associated data binding it to this column and this row. The Samba account itself is
-- created by the privileged helper; what is stored here is what to recreate it from
-- after a restore.
ALTER TABLE shares ADD COLUMN tnc_user TEXT;
ALTER TABLE shares ADD COLUMN tnc_password TEXT;

-- Guest access stops being the default.
--
-- Existing shares keep whatever they were set to: an appliance already in service has
-- machines authenticating the way it was configured, and a migration that locked them
-- out overnight would be a far worse bug than the default it was fixing. Only shares
-- created from here on get the new default, which lives in the schema.
