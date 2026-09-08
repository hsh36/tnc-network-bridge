import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { runMigrations } from '../config/migrations/runner';
import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import {
  NetworkConfigManager,
  parseMacFromNmcliOutput,
  parseStateFromNmcliOutput,
  parseDriverFromNmcliOutput,
} from './network-config-manager';
import { defaultInterfaceNetworkConfig, type InterfaceNetworkConfig } from '../../shared';

describe('NetworkConfigManager', () => {
  let db: Db;
  let manager: NetworkConfigManager;

  beforeEach(() => {
    db = tmpDb();
    runMigrations(db);
    manager = new NetworkConfigManager({ db });
  });

  afterEach(() => {
    cleanupTmpDbs();
  });

  describe('parseMacFromNmcliOutput', () => {
    it('extracts MAC address from nmcli device show output', () => {
      const output = `GENERAL.DEVICE:                         eth0
GENERAL.TYPE:                          ethernet
GENERAL.HWADDR:                         b8:27:eb:00:11:22
GENERAL.MTU:                            1500
GENERAL.STATE:                          100
GENERAL.CONNECTION:                     Wired connection 1`;

      const mac = parseMacFromNmcliOutput(output);
      expect(mac).toBe('b8:27:eb:00:11:22');
    });

    it('returns undefined if no MAC found', () => {
      const output = `GENERAL.DEVICE:                         eth0
GENERAL.TYPE:                          ethernet
GENERAL.MTU:                            1500`;

      const mac = parseMacFromNmcliOutput(output);
      expect(mac).toBeUndefined();
    });

    it('handles uppercase MAC addresses', () => {
      const output = 'GENERAL.HWADDR:                         B8:27:EB:00:11:22';
      const mac = parseMacFromNmcliOutput(output);
      expect(mac).toBe('b8:27:eb:00:11:22');
    });
  });

  describe('parseStateFromNmcliOutput', () => {
    it('recognizes "100" as up', () => {
      const output = 'GENERAL.STATE:                          100';
      expect(parseStateFromNmcliOutput(output)).toBe('up');
    });

    it('recognizes "activated" as up', () => {
      const output = 'GENERAL.STATE:                          activated';
      expect(parseStateFromNmcliOutput(output)).toBe('up');
    });

    it('recognizes disconnected states as down', () => {
      const output = 'GENERAL.STATE:                          disconnected';
      expect(parseStateFromNmcliOutput(output)).toBe('down');
    });

    it('recognizes "0" as down', () => {
      const output = 'GENERAL.STATE:                          0';
      expect(parseStateFromNmcliOutput(output)).toBe('down');
    });

    it('returns unknown for unrecognized states', () => {
      const output = 'GENERAL.STATE:                          unknown';
      expect(parseStateFromNmcliOutput(output)).toBe('unknown');
    });

    it('returns unknown if no STATE line found', () => {
      const output = 'GENERAL.DEVICE:                         eth0';
      expect(parseStateFromNmcliOutput(output)).toBe('unknown');
    });
  });

  describe('parseDriverFromNmcliOutput', () => {
    it('extracts driver name from nmcli output', () => {
      const output = `GENERAL.DEVICE:                         eth0
GENERAL.DRIVER:                         r8169
GENERAL.HWADDR:                         b8:27:eb:00:11:22`;

      const driver = parseDriverFromNmcliOutput(output);
      expect(driver).toBe('r8169');
    });

    it('returns undefined if no DRIVER line found', () => {
      const output = 'GENERAL.DEVICE:                         eth0';
      expect(parseDriverFromNmcliOutput(output)).toBeUndefined();
    });
  });

  describe('config storage and retrieval', () => {
    it('stores and retrieves interface config by MAC', async () => {
      const mac = 'b8:27:eb:00:11:22';
      const config: InterfaceNetworkConfig = {
        method: 'static',
        address: '192.168.1.100/24',
        gateway: '192.168.1.1',
        dns: ['8.8.8.8'],
        mtu: 1500,
        ipv6Enabled: false,
      };

      await manager.storeConfig(mac, config);
      const retrieved = await manager.getConfig(mac);

      expect(retrieved).toEqual(config);
    });

    it('returns default config for unknown MAC', async () => {
      const mac = 'ff:ff:ff:ff:ff:ff';
      const config = await manager.getConfig(mac);

      expect(config).toEqual(defaultInterfaceNetworkConfig());
    });

    it('updates stored config', async () => {
      const mac = 'b8:27:eb:00:11:22';
      const config1: InterfaceNetworkConfig = {
        method: 'dhcp',
        dns: [],
        mtu: 1500,
        ipv6Enabled: false,
      };
      const config2: InterfaceNetworkConfig = {
        method: 'static',
        address: '10.0.0.50/24',
        gateway: '10.0.0.1',
        dns: [],
        mtu: 9000,
        ipv6Enabled: true,
      };

      await manager.storeConfig(mac, config1);
      let retrieved = await manager.getConfig(mac);
      expect(retrieved.method).toBe('dhcp');

      await manager.storeConfig(mac, config2);
      retrieved = await manager.getConfig(mac);
      expect(retrieved.method).toBe('static');
      expect(retrieved.mtu).toBe(9000);
      expect(retrieved.ipv6Enabled).toBe(true);
    });

    it('retrieves all stored configs', async () => {
      const configs = new Map<string, InterfaceNetworkConfig>();
      configs.set('b8:27:eb:00:11:22', {
        method: 'dhcp',
        dns: [],
        mtu: 1500,
        ipv6Enabled: false,
      });
      configs.set('b8:27:eb:00:11:23', {
        method: 'static',
        address: '192.168.1.100/24',
        gateway: '192.168.1.1',
        dns: [],
        mtu: 1500,
        ipv6Enabled: false,
      });

      for (const [mac, config] of configs) {
        await manager.storeConfig(mac, config);
      }

      const all = await manager.getAllConfigs();
      expect(all.size).toBe(2);
      expect(all.get('b8:27:eb:00:11:22')).toEqual(configs.get('b8:27:eb:00:11:22'));
      expect(all.get('b8:27:eb:00:11:23')).toEqual(configs.get('b8:27:eb:00:11:23'));
    });
  });

  describe('pending changes', () => {
    it('stores and retrieves pending change', async () => {
      const mac = 'b8:27:eb:00:11:22';
      const oldConfig: InterfaceNetworkConfig = {
        method: 'dhcp',
        dns: [],
        mtu: 1500,
        ipv6Enabled: false,
      };
      const newConfig: InterfaceNetworkConfig = {
        method: 'static',
        address: '192.168.1.100/24',
        gateway: '192.168.1.1',
        dns: ['8.8.8.8'],
        mtu: 1500,
        ipv6Enabled: false,
      };
      const expiresAt = Math.floor(Date.now() / 1000) + 60;

      await manager.storePendingChange(mac, oldConfig, newConfig, expiresAt);
      const pending = await manager.getPendingChange(mac);

      expect(pending).not.toBeNull();
      expect(pending!.mac).toBe(mac);
      expect(pending!.oldConfig).toEqual(oldConfig);
      expect(pending!.newConfig).toEqual(newConfig);
      expect(pending!.expiresAt).toBe(expiresAt);
    });

    it('returns null for non-existent pending change', async () => {
      const pending = await manager.getPendingChange('ff:ff:ff:ff:ff:ff');
      expect(pending).toBeNull();
    });

    it('confirms and removes pending change', async () => {
      const mac = 'b8:27:eb:00:11:22';
      const oldConfig: InterfaceNetworkConfig = {
        method: 'dhcp',
        dns: [],
        mtu: 1500,
        ipv6Enabled: false,
      };
      const newConfig: InterfaceNetworkConfig = {
        method: 'static',
        address: '192.168.1.100/24',
        gateway: '192.168.1.1',
        dns: [],
        mtu: 1500,
        ipv6Enabled: false,
      };
      const expiresAt = Math.floor(Date.now() / 1000) + 60;

      await manager.storePendingChange(mac, oldConfig, newConfig, expiresAt);
      let pending = await manager.getPendingChange(mac);
      expect(pending).not.toBeNull();

      await manager.confirmPendingChange(mac);
      pending = await manager.getPendingChange(mac);
      expect(pending).toBeNull();
    });

    it('cleans up expired pending changes', async () => {
      const mac1 = 'b8:27:eb:00:11:22';
      const mac2 = 'b8:27:eb:00:11:23';
      const config: InterfaceNetworkConfig = {
        method: 'dhcp',
        dns: [],
        mtu: 1500,
        ipv6Enabled: false,
      };
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expiredAt = nowSeconds - 10; // 10 seconds ago
      const futureAt = nowSeconds + 60;

      await manager.storePendingChange(mac1, config, config, expiredAt);
      await manager.storePendingChange(mac2, config, config, futureAt);

      const cleaned = await manager.cleanupExpiredChanges(nowSeconds);

      expect(cleaned).toBe(1);
      const expired = await manager.getPendingChange(mac1);
      const valid = await manager.getPendingChange(mac2);
      expect(expired).toBeNull();
      expect(valid).not.toBeNull();
    });
  });
});
