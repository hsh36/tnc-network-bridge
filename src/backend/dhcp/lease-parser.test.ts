import { parseDnsmasqLeases } from './lease-parser';

describe('lease-parser', () => {
  describe('parseDnsmasqLeases', () => {
    it('parses a valid lease file', () => {
      const content = `1694000000 aa:bb:cc:dd:ee:ff 192.168.42.50 tnc-machine-1 *
1694000100 11:22:33:44:55:66 192.168.42.51 tnc-machine-2 *`;

      const leases = parseDnsmasqLeases(content);

      expect(leases).toHaveLength(2);
      expect(leases[0]).toEqual({
        timestamp: 1694000000,
        mac: 'aa:bb:cc:dd:ee:ff',
        ip: '192.168.42.50',
        hostname: 'tnc-machine-1',
      });
      expect(leases[1]).toEqual({
        timestamp: 1694000100,
        mac: '11:22:33:44:55:66',
        ip: '192.168.42.51',
        hostname: 'tnc-machine-2',
      });
    });

    it('handles asterisk as hostname', () => {
      const content = `1694000000 aa:bb:cc:dd:ee:ff 192.168.42.50 * *`;

      const leases = parseDnsmasqLeases(content);

      expect(leases).toHaveLength(1);
      expect(leases[0]?.hostname).toBe('');
    });

    it('ignores comments', () => {
      const content = `# This is a comment
1694000000 aa:bb:cc:dd:ee:ff 192.168.42.50 machine1 *
# Another comment
1694000100 11:22:33:44:55:66 192.168.42.51 machine2 *`;

      const leases = parseDnsmasqLeases(content);

      expect(leases).toHaveLength(2);
    });

    it('ignores empty lines', () => {
      const content = `1694000000 aa:bb:cc:dd:ee:ff 192.168.42.50 machine1 *

1694000100 11:22:33:44:55:66 192.168.42.51 machine2 *

`;

      const leases = parseDnsmasqLeases(content);

      expect(leases).toHaveLength(2);
    });

    it('skips malformed lines', () => {
      const content = `1694000000 aa:bb:cc:dd:ee:ff 192.168.42.50 machine1 *
invalid line
1694000100 11:22:33:44:55:66 192.168.42.51 machine2 *`;

      const leases = parseDnsmasqLeases(content);

      expect(leases).toHaveLength(2);
    });

    it('validates MAC address format', () => {
      const content = `1694000000 not-a-mac 192.168.42.50 machine1 *
1694000000 aa:bb:cc:dd:ee:ff 192.168.42.50 machine1 *`;

      const leases = parseDnsmasqLeases(content);

      expect(leases).toHaveLength(1);
      expect(leases[0]?.mac).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('validates IP address format', () => {
      const content = `1694000000 aa:bb:cc:dd:ee:ff not-an-ip machine1 *
1694000000 aa:bb:cc:dd:ee:ff 192.168.42.50 machine1 *`;

      const leases = parseDnsmasqLeases(content);

      expect(leases).toHaveLength(1);
      expect(leases[0]?.ip).toBe('192.168.42.50');
    });

    it('lowercases MAC addresses', () => {
      const content = `1694000000 AA:BB:CC:DD:EE:FF 192.168.42.50 machine1 *`;

      const leases = parseDnsmasqLeases(content);

      expect(leases[0]?.mac).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('returns empty array for empty content', () => {
      const leases = parseDnsmasqLeases('');

      expect(leases).toEqual([]);
    });

    it('handles missing timestamp as NaN', () => {
      const content = `not-a-number aa:bb:cc:dd:ee:ff 192.168.42.50 machine1 *
1694000000 aa:bb:cc:dd:ee:ff 192.168.42.50 machine1 *`;

      const leases = parseDnsmasqLeases(content);

      expect(leases).toHaveLength(1);
      expect(leases[0]?.timestamp).toBe(1694000000);
    });
  });
});
