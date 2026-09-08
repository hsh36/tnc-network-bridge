/**
 * Parse dnsmasq lease file to discover machines.
 *
 * Format: `<timestamp> <mac> <ip> <hostname> <client-id>`
 *
 * Example:
 *   1694000000 aa:bb:cc:dd:ee:ff 192.168.42.50 my-tnc-machine *
 */

export interface DhcpLease {
  readonly timestamp: number;
  readonly mac: string;
  readonly ip: string;
  readonly hostname: string;
}

/**
 * Parses a dnsmasq lease file and returns discovered machines.
 *
 * @param content - Raw content of `/var/lib/dnsmasq/dnsmasq.leases`
 * @returns Array of discovered DHCP leases
 */
export function parseDnsmasqLeases(content: string): DhcpLease[] {
  const leases: DhcpLease[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) {
      continue;
    }

    const timestamp = Number(parts[0]);
    const mac = parts[1];
    const ip = parts[2];
    const hostname = parts[3];

    if (Number.isNaN(timestamp) || !mac || !ip) {
      continue;
    }

    // Validate MAC address format (simple check)
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) {
      continue;
    }

    // Validate IP address format (simple check)
    if (!/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.test(ip)) {
      continue;
    }

    leases.push({
      timestamp,
      mac: mac.toLowerCase(),
      ip,
      hostname: hostname === '*' ? '' : hostname,
    });
  }

  return leases;
}
