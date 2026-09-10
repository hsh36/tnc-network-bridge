import {
  type SysfsReader,
  discoverInterfaces,
  maskToPrefix,
  toSpeed,
  toState,
} from './interface-discovery';

/**
 * The reason this module exists rather than reusing `os.networkInterfaces()` is that an
 * unconfigured NIC has no address — and that is exactly the interface an operator opens
 * the picker to select. The tests below are mostly about that: what shows up, and what
 * is deliberately hidden.
 */

interface FakeInterface {
  readonly attributes: Record<string, string>;
  readonly driver?: string;
  readonly addressed?: boolean;
}

function reader(interfaces: Record<string, FakeInterface>): SysfsReader {
  return {
    listInterfaces: () => Object.keys(interfaces),
    readAttribute: (iface, attribute) => interfaces[iface]?.attributes[attribute],
    readDriver: (iface) => interfaces[iface]?.driver,
    addressed: () =>
      new Map(
        Object.entries(interfaces)
          .filter(([, i]) => i.addressed)
          .map(([name]) => [name, ['10.0.0.1/24']]),
      ),
  };
}

/** Mirrors what the Raspberry Pi in the test rack actually reports. */
const REAL_PI: Record<string, FakeInterface> = {
  eth0: {
    attributes: { address: '2c:cf:67:2f:61:ee', operstate: 'up', speed: '1000' },
    driver: 'macb',
    addressed: true,
  },
  eth1: {
    // A second NIC that is cabled but unconfigured: down, no speed, no address.
    attributes: { address: '00:e0:4c:f2:00:88', operstate: 'down' },
    driver: 'r8169',
  },
  lo: { attributes: { address: '00:00:00:00:00:00', operstate: 'unknown' }, addressed: true },
  wlan0: {
    attributes: { address: '2c:cf:67:2f:61:ef', operstate: 'down' },
    driver: 'brcmfmac',
  },
};

describe('discoverInterfaces', () => {
  it('lists a cabled but unconfigured NIC', () => {
    const found = discoverInterfaces(reader(REAL_PI));

    // The whole point: eth1 has no address, so os.networkInterfaces() would not show
    // it, and the operator could never pick it as the TNC side.
    const eth1 = found.find((i) => i.name === 'eth1');
    expect(eth1).toMatchObject({
      mac: '00:e0:4c:f2:00:88',
      state: 'down',
      speedMbps: null,
      driver: 'r8169',
      hasAddress: false,
    });
  });

  it('reports link state, speed and driver for a live NIC', () => {
    const found = discoverInterfaces(reader(REAL_PI));

    expect(found.find((i) => i.name === 'eth0')).toMatchObject({
      state: 'up',
      speedMbps: 1000,
      driver: 'macb',
      hasAddress: true,
    });
  });

  it('hides loopback, which is never a side of the bridge', () => {
    expect(discoverInterfaces(reader(REAL_PI)).map((i) => i.name)).toEqual([
      'eth0',
      'eth1',
      'wlan0',
    ]);
  });

  it('skips an interface with no MAC of its own', () => {
    const found = discoverInterfaces(
      reader({
        bond0: { attributes: { address: '00:00:00:00:00:00', operstate: 'up' } },
        eth0: { attributes: { address: 'aa:bb:cc:dd:ee:ff', operstate: 'up' } },
      }),
    );
    expect(found.map((i) => i.name)).toEqual(['eth0']);
  });

  it('sorts by name so the picker does not reshuffle between reloads', () => {
    const found = discoverInterfaces(
      reader({
        enp3s0: { attributes: { address: 'aa:bb:cc:dd:ee:03', operstate: 'up' } },
        enp1s0: { attributes: { address: 'aa:bb:cc:dd:ee:01', operstate: 'up' } },
        enp2s0: { attributes: { address: 'aa:bb:cc:dd:ee:02', operstate: 'up' } },
      }),
    );
    expect(found.map((i) => i.name)).toEqual(['enp1s0', 'enp2s0', 'enp3s0']);
  });

  it('returns nothing rather than throwing where sysfs is absent', () => {
    const empty: SysfsReader = {
      listInterfaces: () => [],
      readAttribute: () => undefined,
      readDriver: () => undefined,
      addressed: () => new Map(),
    };
    expect(discoverInterfaces(empty)).toEqual([]);
  });
});

describe('toState', () => {
  it.each([
    ['up', 'up'],
    ['down', 'down'],
    ['lowerlayerdown', 'down'],
    ['dormant', 'unknown'],
    ['unknown', 'unknown'],
    [undefined, 'unknown'],
  ])('maps %p to %p', (raw, expected) => {
    expect(toState(raw)).toBe(expected);
  });
});

describe('toSpeed', () => {
  it('reads a reported speed', () => {
    expect(toSpeed('1000')).toBe(1000);
  });

  it.each(['-1', '0', '', 'unknown', undefined])('treats %p as unknown', (raw) => {
    // The kernel answers -1 for a link that is down, which is the normal state of the
    // NIC being configured — reporting it as a speed of -1 would be nonsense.
    expect(toSpeed(raw)).toBeNull();
  });
});

describe('maskToPrefix', () => {
  it.each([
    ['255.255.255.0', 24],
    // The one the appliance actually runs on.
    ['255.255.248.0', 21],
    ['255.255.254.0', 23],
    ['255.0.0.0', 8],
    ['255.255.255.255', 32],
    ['0.0.0.0', 0],
  ])('converts %s to /%i', (netmask, prefix) => {
    expect(maskToPrefix(netmask)).toBe(prefix);
  });

  it('treats a malformed octet as zero rather than throwing', () => {
    // os.networkInterfaces() should never produce one, but a status read is not the
    // place to discover that assumption was wrong.
    expect(maskToPrefix('255.255.x.0')).toBe(16);
  });
});

describe('reported addresses', () => {
  it('carries the live addresses through, so drift can be seen', () => {
    // `hasAddress` could only say whether there was an address at all. Telling a stored
    // configuration from the one in force needs to know *which*.
    const fake = reader({
      eth0: { attributes: { address: 'aa:bb:cc:dd:ee:00', operstate: 'up' }, addressed: true },
    });

    expect(discoverInterfaces(fake)[0]?.addresses).toEqual(['10.0.0.1/24']);
  });

  it('reports an empty list for a NIC with no address', () => {
    const fake = reader({
      eth1: { attributes: { address: 'aa:bb:cc:dd:ee:01', operstate: 'down' }, addressed: false },
    });

    expect(discoverInterfaces(fake)[0]?.addresses).toEqual([]);
  });
});
