import {
  FIREWALL_TABLE,
  FirewallError,
  MANAGEMENT_PORTS,
  isManagementIsolationCurrent,
  renderManagementIsolation,
} from './firewall';

/**
 * The ruleset is a file executed as root, built from a string that names an interface
 * out of the configuration. Both halves of that sentence are what these tests are for:
 * that the rule it produces actually isolates the management ports on the TNC side, and
 * that nothing that is not an interface name can reach the file.
 */

describe('renderManagementIsolation', () => {
  it('drops the management ports arriving on the TNC interface', () => {
    const ruleset = renderManagementIsolation({ tncInterface: 'eth1' });

    expect(ruleset).toContain('iifname "eth1" tcp dport { 22, 443 } drop');
  });

  it('keeps the policy at accept', () => {
    // A default-deny policy here would take down SMB, DHCP and DNS on the machine
    // segment — the three services the appliance exists to provide.
    expect(renderManagementIsolation({ tncInterface: 'eth1' })).toContain('policy accept;');
  });

  it('is idempotent to load: it declares the table before deleting it', () => {
    const ruleset = renderManagementIsolation({ tncInterface: 'eth1' });
    const declare = ruleset.indexOf(`table inet ${FIREWALL_TABLE}\ndelete table inet`);

    // `delete` on a missing table is an error, so a fresh boot would fail to load a
    // file that deleted first.
    expect(declare).toBeGreaterThan(-1);
  });

  it('isolates SSH as well as HTTPS', () => {
    // "Configured from the LAN only" is not satisfied by closing the web interface and
    // leaving a shell open on the same segment.
    expect(MANAGEMENT_PORTS).toContain(22);
    expect(MANAGEMENT_PORTS).toContain(443);
  });

  it('names the ports in ascending order, whatever order they were given', () => {
    expect(renderManagementIsolation({ tncInterface: 'eth1', managementPorts: [443, 22] })).toBe(
      renderManagementIsolation({ tncInterface: 'eth1', managementPorts: [22, 443] }),
    );
  });

  it.each([
    ['eth1; drop', 'a command separator'],
    ['eth1" accept "', 'a quote break-out'],
    ['../../etc/passwd', 'a path'],
    ['', 'empty'],
    ['thisnameiswaytoolong', 'over the kernel limit'],
  ])('refuses %p — %s', (iface) => {
    expect(() => renderManagementIsolation({ tncInterface: iface })).toThrow(FirewallError);
  });

  it.each([0, 65_536, -1, 1.5])('refuses the port %p', (port) => {
    expect(() =>
      renderManagementIsolation({ tncInterface: 'eth1', managementPorts: [port] }),
    ).toThrow(FirewallError);
  });

  it('refuses an empty port list rather than emitting a rule that matches nothing', () => {
    expect(() => renderManagementIsolation({ tncInterface: 'eth1', managementPorts: [] })).toThrow(
      FirewallError,
    );
  });
});

describe('isManagementIsolationCurrent', () => {
  it('recognises its own output', () => {
    const input = { tncInterface: 'eth1' };
    expect(isManagementIsolationCurrent(renderManagementIsolation(input), input)).toBe(true);
  });

  it('rejects a ruleset naming a different interface', () => {
    // The case that matters: the TNC side was moved to another NIC and the loaded rule
    // now points at one nothing arrives on.
    const stale = renderManagementIsolation({ tncInterface: 'eth1' });
    expect(isManagementIsolationCurrent(stale, { tncInterface: 'eth2' })).toBe(false);
  });

  it('treats a missing ruleset as not current', () => {
    expect(isManagementIsolationCurrent(undefined, { tncInterface: 'eth1' })).toBe(false);
  });
});
