import { renderDnsmasqConf, DHCPConfigManager } from './dhcp-config-manager';
import { tmpDb, cleanupTmpDbs } from '../../../tests/support/tmp-db';
import { runMigrations } from '../config/migrations/runner';
import { type Db } from '../config/db';
import { ConfigManager } from '../config/config-manager';
import { generateSecretKey } from '../config/secrets';

describe('renderDnsmasqConf', () => {
  it('renders a valid dnsmasq configuration', () => {
    const config = {
      tncInterface: 'eth1',
      rangeStart: '192.168.42.100',
      rangeEnd: '192.168.42.199',
      leaseTime: '12h',
      gateway: '192.168.42.1',
      domain: 'tnc.local',
      enabled: true,
    };

    const content = renderDnsmasqConf(config, []);

    expect(content).toContain('interface=eth1');
    expect(content).toContain('bind-interfaces');
    expect(content).toContain('dhcp-range=192.168.42.100,192.168.42.199,12h');
    expect(content).toContain('dhcp-option=option:router,192.168.42.1');
    // No DNS server, and specifically an *empty* option rather than a missing line:
    // omitting it makes dnsmasq offer itself as the resolver, which is exactly what a
    // bridge on the machine segment must not do.
    expect(content).toMatch(/dhcp-option=option:dns-server$/m);
    expect(content).not.toMatch(/dhcp-option=option:dns-server,/);
    expect(content).toContain('dhcp-option=option:domain-name,tnc.local');
  });

  it('includes static reservations', () => {
    const config = {
      tncInterface: 'eth1',
      rangeStart: '192.168.42.100',
      rangeEnd: '192.168.42.199',
      leaseTime: '12h',
      gateway: '192.168.42.1',
      domain: 'tnc.local',
      enabled: true,
    };

    const reservations = [
      { mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.42.10', hostname: 'tnc-machine-1' },
      { mac: '11:22:33:44:55:66', ip: '192.168.42.11', hostname: 'tnc-machine-2' },
    ];

    const content = renderDnsmasqConf(config, reservations);

    expect(content).toContain('dhcp-host=aa:bb:cc:dd:ee:ff,192.168.42.10,tnc-machine-1');
    expect(content).toContain('dhcp-host=11:22:33:44:55:66,192.168.42.11,tnc-machine-2');
  });

  it('uses MAC address as hostname when hostname is not provided', () => {
    const config = {
      tncInterface: 'eth1',
      rangeStart: '192.168.42.100',
      rangeEnd: '192.168.42.199',
      leaseTime: '12h',
      gateway: '192.168.42.1',
      domain: 'tnc.local',
      enabled: true,
    };

    const reservations = [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '192.168.42.10', hostname: '' }];

    const content = renderDnsmasqConf(config, reservations);

    expect(content).toContain('dhcp-host=aa:bb:cc:dd:ee:ff,192.168.42.10,aa-bb-cc-dd-ee-ff');
  });

  it('lowercases MAC addresses', () => {
    const config = {
      tncInterface: 'eth1',
      rangeStart: '192.168.42.100',
      rangeEnd: '192.168.42.199',
      leaseTime: '12h',
      gateway: '192.168.42.1',
      domain: 'tnc.local',
      enabled: true,
    };

    const reservations = [{ mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.42.10', hostname: 'machine1' }];

    const content = renderDnsmasqConf(config, reservations);

    expect(content).toContain('dhcp-host=aa:bb:cc:dd:ee:ff,192.168.42.10,machine1');
  });
});

describe('DHCPConfigManager', () => {
  let db: Db;
  let configManager: ConfigManager;
  let dhcpManager: DHCPConfigManager;

  beforeEach(() => {
    db = tmpDb();
    runMigrations(db);
    const secretKey = generateSecretKey();
    configManager = ConfigManager.create({ db, secretKey });
    dhcpManager = new DHCPConfigManager({ db, config: configManager, logger: undefined });
  });

  afterEach(() => {
    cleanupTmpDbs();
  });

  describe('buildConfiguration', () => {
    it('builds a configuration from the config section', () => {
      const result = dhcpManager.buildConfiguration('eth1');

      expect(result.config).toMatchObject({
        tncInterface: 'eth1',
        enabled: false, // default from schema
        leaseTime: '12h',
      });
      expect(result.content).toContain('interface=eth1');
    });

    it('extracts gateway from TNC interface address', () => {
      const result = dhcpManager.buildConfiguration('eth1');

      // Default TNC interface is '192.168.42.1/24'
      expect(result.config.gateway).toBe('192.168.42.1');
    });

    it('parses DHCP range correctly', () => {
      const result = dhcpManager.buildConfiguration('eth1');

      expect(result.config.rangeStart).toBe('192.168.42.100');
      expect(result.config.rangeEnd).toBe('192.168.42.199');
    });
  });

  describe('getStaticReservations', () => {
    it('returns empty array when no reservations exist', () => {
      const result = dhcpManager.buildConfiguration('eth1');

      expect(result.content).not.toContain('dhcp-host=');
    });

    it('fetches static reservations from tnc_clients table', () => {
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT INTO tnc_clients (mac_address, reserved_ip, name, dhcp_reserved, created_at, updated_at)
         VALUES (@mac, @ip, @name, 1, @now, @now)`,
        {
          mac: 'aa:bb:cc:dd:ee:ff',
          ip: '192.168.42.10',
          name: 'test-machine',
          now,
        },
      );

      const result = dhcpManager.buildConfiguration('eth1');

      expect(result.content).toContain('dhcp-host=aa:bb:cc:dd:ee:ff,192.168.42.10,test-machine');
    });

    it('ignores entries without reserved_ip', () => {
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT INTO tnc_clients (mac_address, name, dhcp_reserved, created_at, updated_at)
         VALUES (@mac, @name, 0, @now, @now)`,
        {
          mac: 'aa:bb:cc:dd:ee:ff',
          name: 'test-machine',
          now,
        },
      );

      const result = dhcpManager.buildConfiguration('eth1');

      expect(result.content).not.toContain('dhcp-host=');
    });

    it('ignores entries with dhcp_reserved = 0', () => {
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT INTO tnc_clients (mac_address, reserved_ip, name, dhcp_reserved, created_at, updated_at)
         VALUES (@mac, @ip, @name, 0, @now, @now)`,
        {
          mac: 'aa:bb:cc:dd:ee:ff',
          ip: '192.168.42.10',
          name: 'test-machine',
          now,
        },
      );

      const result = dhcpManager.buildConfiguration('eth1');

      expect(result.content).not.toContain('dhcp-host=');
    });
  });

  describe('parseLeaseFile', () => {
    it('returns empty array when file does not exist', async () => {
      const leases = await dhcpManager.parseLeaseFile('/nonexistent/file');

      expect(leases).toEqual([]);
    });
  });

  describe('getDiscoveredMachines', () => {
    it('returns empty array when table does not exist', () => {
      const machines = dhcpManager.getDiscoveredMachines();

      expect(machines).toEqual([]);
    });
  });
});
