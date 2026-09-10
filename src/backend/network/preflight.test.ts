import { type InterfaceDiscovery, type NetworkSide } from '../../shared';

import { isInSubnet, parseCidr, parseIpv4, preflight } from './preflight';

/**
 * Every rule here exists to turn a lockout into an error message. The bar for each is
 * the same: would getting this wrong cost the operator their connection to the only
 * interface that could put it right?
 */

const NICS: InterfaceDiscovery[] = [
  {
    mac: 'aa:bb:cc:dd:ee:00',
    name: 'eth0',
    state: 'up',
    speedMbps: 1000,
    driver: 'x',
    hasAddress: true,
  },
  {
    mac: 'aa:bb:cc:dd:ee:01',
    name: 'eth1',
    state: 'down',
    speedMbps: null,
    driver: 'y',
    hasAddress: false,
  },
];

function side(overrides: Partial<NetworkSide> = {}): NetworkSide {
  return {
    interface: 'eth0',
    hostname: '',
    method: 'static',
    address: '10.0.0.5/24',
    gateway: '10.0.0.1',
    dns: [],
    vlan: null,
    mtu: 1500,
    ipv6: false,
    ...overrides,
  };
}

describe('preflight', () => {
  it('passes a coherent static configuration', () => {
    expect(preflight({ side: 'lan', config: side(), interfaces: NICS })).toEqual([]);
  });

  it('catches a gateway outside the address subnet', () => {
    // The classic typo. Applied, it produces an interface that is up, addressed, and
    // reaches nothing.
    const issues = preflight({
      side: 'lan',
      config: side({ gateway: '10.0.1.1' }),
      interfaces: NICS,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('lan.gateway');
    expect(issues[0]?.message).toContain('not inside');
  });

  it('accepts a gateway that is inside a wider prefix', () => {
    expect(
      preflight({
        side: 'lan',
        config: side({ address: '10.0.0.5/16', gateway: '10.0.255.1' }),
        interfaces: NICS,
      }),
    ).toEqual([]);
  });

  it('reports an interface this machine does not have', () => {
    const issues = preflight({
      side: 'lan',
      config: side({ interface: 'eth9' }),
      interfaces: NICS,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('lan.interface');
  });

  it('says nothing else once the interface is missing', () => {
    // Reporting an address problem on an interface that is not there is noise the
    // operator has to read past to find the actual cause.
    const issues = preflight({
      side: 'lan',
      config: side({ interface: 'eth9', gateway: '192.168.99.1' }),
      interfaces: NICS,
    });
    expect(issues).toHaveLength(1);
  });

  it('warns that DHCP on a dead link will not get an address', () => {
    const issues = preflight({
      side: 'tnc',
      config: side({ interface: 'eth1', method: 'dhcp' }),
      interfaces: NICS,
    });

    expect(issues[0]?.field).toBe('tnc.method');
    expect(issues[0]?.message).toContain('no link');
  });

  it('requires an address for a static configuration', () => {
    const config = { ...side(), address: undefined };
    const issues = preflight({ side: 'lan', config, interfaces: NICS });
    expect(issues[0]?.field).toBe('lan.address');
  });

  it('requires a prefix length on the address', () => {
    const issues = preflight({
      side: 'lan',
      config: side({ address: '10.0.0.5' }),
      interfaces: NICS,
    });
    expect(issues[0]?.message).toContain('prefix length');
  });

  it('rejects a DNS entry that is not an address', () => {
    const issues = preflight({
      side: 'lan',
      config: side({ dns: ['not-an-ip'] }),
      interfaces: NICS,
    });
    expect(issues[0]?.field).toBe('lan.dns.0');
  });

  it('leaves DHCP alone: there is nothing of ours to check', () => {
    expect(preflight({ side: 'lan', config: side({ method: 'dhcp' }), interfaces: NICS })).toEqual(
      [],
    );
  });
});

describe('parseIpv4', () => {
  it.each([
    ['0.0.0.0', 0],
    ['255.255.255.255', 4_294_967_295],
    ['10.0.0.1', 167_772_161],
  ])('parses %p', (input, expected) => {
    expect(parseIpv4(input)).toBe(expected);
  });

  it.each(['10.0.0', '10.0.0.256', '10.0.0.01', '10.0.0.-1', '', 'ten.zero.zero.one'])(
    'rejects %p',
    (input) => {
      // Leading zeros are rejected because they read as octal to some resolvers and as
      // decimal to others; an address that means two things is not an address.
      expect(parseIpv4(input)).toBeUndefined();
    },
  );
});

describe('parseCidr', () => {
  it('splits address and prefix', () => {
    expect(parseCidr('192.168.1.10/24')).toEqual({ address: 3_232_235_786, prefix: 24 });
  });

  it.each(['192.168.1.10', '192.168.1.10/33', '192.168.1.10/-1', '192.168.1.10/24/8'])(
    'rejects %p',
    (input) => {
      expect(parseCidr(input)).toBeUndefined();
    },
  );
});

describe('isInSubnet', () => {
  it.each([
    ['10.0.0.1', '10.0.0.5/24', true],
    ['10.0.1.1', '10.0.0.5/24', false],
    ['10.0.255.1', '10.0.0.5/16', true],
    ['172.16.0.1', '10.0.0.5/8', false],
    ['10.255.255.254', '10.0.0.5/8', true],
  ])('%p in %p → %p', (ip, cidr, expected) => {
    expect(isInSubnet(ip, cidr)).toBe(expected);
  });

  it('handles a /1, where a signed 32-bit mask would go negative', () => {
    // `0xffffffff << 31` is negative in JS; without the unsigned shift the comparison
    // disagrees with itself for every prefix from /1 to /8.
    expect(isInSubnet('10.0.0.1', '120.0.0.1/1')).toBe(true);
    expect(isInSubnet('200.0.0.1', '120.0.0.1/1')).toBe(false);
  });

  it('treats /0 as everything', () => {
    expect(isInSubnet('8.8.8.8', '10.0.0.1/0')).toBe(true);
  });
});
