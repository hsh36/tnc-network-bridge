import { copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../../tests/support/tmp-db';
import { ConfigManager } from '../config-manager';
import { type Db } from '../db';
import { generateSecretKey } from '../secrets';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from './runner';

/**
 * Splitting MTU and IPv6 into per-side values is the kind of change that loses an
 * operator's settings quietly: `ConfigManager` fills missing keys with defaults, so a
 * bridge whose LAN ran at MTU 9000 would come back at 1500 with nothing logged and
 * nothing visibly wrong. These tests are about the carry-over, not the schema.
 */

let db: Db;

/**
 * Brings the database to an older schema version, so the legacy rows can be seeded the
 * way a real upgrade would find them. The runner takes a directory rather than a list,
 * so the subset is staged as one.
 */
function migrateTo(version: number): void {
  const staged = tmpDir('tnc-migrations-');
  for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    const match = /^(\d{3,})_.*\.sql$/.exec(file);
    if (match !== null && Number(match[1]) <= version) {
      copyFileSync(join(DEFAULT_MIGRATIONS_DIR, file), join(staged, file));
    }
  }
  runMigrations(db, { directory: staged });
}

beforeEach(() => {
  db = tmpDb();
});

afterEach(() => {
  cleanupTmpDbs();
});

function seedLegacyConfig(entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    db.run(
      `INSERT INTO config (key, value, is_secret, updated_at, updated_by)
       VALUES (@key, @value, 0, 1700000000, 'operator')`,
      { key, value },
    );
  }
}

function readConfig(key: string): string | undefined {
  return db.pluck<string>('SELECT value FROM config WHERE key = @key', { key });
}

describe('004_network_per_side', () => {
  it('carries a customised MTU onto both sides', () => {
    migrateTo(3);
    seedLegacyConfig({ 'network.mtu': '9000' });

    runMigrations(db);

    expect(readConfig('network.lan.mtu')).toBe('9000');
    expect(readConfig('network.tnc.mtu')).toBe('9000');
  });

  it('carries the IPv6 switch onto both sides and drops its old nesting', () => {
    migrateTo(3);
    seedLegacyConfig({ 'network.ipv6.enabled': 'true' });

    runMigrations(db);

    expect(readConfig('network.lan.ipv6')).toBe('true');
    expect(readConfig('network.tnc.ipv6')).toBe('true');
    expect(readConfig('network.ipv6.enabled')).toBeUndefined();
  });

  it('records the TNC side as static, which it always implicitly was', () => {
    migrateTo(3);
    seedLegacyConfig({ 'network.tnc.address': '"10.9.0.1/24"' });

    runMigrations(db);

    // Without this the new schema's DHCP default would take over a segment where
    // nothing serves DHCP until the operator switches it on.
    expect(readConfig('network.tnc.method')).toBe('"static"');
  });

  it('removes the superseded keys so they cannot contradict the live values', () => {
    migrateTo(3);
    seedLegacyConfig({ 'network.mtu': '9000', 'network.ipv6.enabled': 'true' });

    runMigrations(db);

    expect(readConfig('network.mtu')).toBeUndefined();
    expect(readConfig('network.ipv6.enabled')).toBeUndefined();
  });

  it('is a no-op on a fresh database that never had the old keys', () => {
    runMigrations(db);

    expect(readConfig('network.lan.mtu')).toBeUndefined();
    // The whole ledger is applied here, so this tracks the newest migration, not 004.
    expect(db.userVersion).toBeGreaterThanOrEqual(4);
  });

  it('leaves the config readable, with the carried values in force', () => {
    migrateTo(3);
    seedLegacyConfig({
      'network.mtu': '9000',
      'network.ipv6.enabled': 'true',
      'network.lan.interface': '"enp1s0"',
      'network.tnc.address': '"10.9.0.1/24"',
    });

    runMigrations(db);
    const config = ConfigManager.create({ db, secretKey: generateSecretKey() });
    const network = config.get('network');

    expect(network.lan.mtu).toBe(9000);
    expect(network.tnc.mtu).toBe(9000);
    expect(network.lan.ipv6).toBe(true);
    expect(network.lan.interface).toBe('enp1s0');
    expect(network.tnc.method).toBe('static');
    expect(network.tnc.address).toBe('10.9.0.1/24');
  });
});
