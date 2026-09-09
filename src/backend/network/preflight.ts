import { type InterfaceDiscovery, type NetworkSide } from '../../shared';

/**
 * Checks a network change before it is applied.
 *
 * Everything here is a mistake that would otherwise be discovered by losing the
 * connection: the apply succeeds, the operator's browser stops responding, and the only
 * remedy is to wait out the revert window and guess what went wrong. A gateway outside
 * the address's subnet is unreachable; an interface that is not present cannot be
 * configured. Both are cheap to see beforehand and expensive to see afterwards.
 *
 * Pure, so the rules can be tested without a machine that has the interfaces on it.
 */

export interface PreflightIssue {
  readonly field: string;
  readonly message: string;
}

/** Parses `10.0.0.5/24`. Returns undefined for anything that is not that. */
export function parseCidr(value: string): { address: number; prefix: number } | undefined {
  const [addressPart, prefixPart, ...rest] = value.split('/');
  if (addressPart === undefined || prefixPart === undefined || rest.length > 0) {
    return undefined;
  }
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return undefined;
  }
  const address = parseIpv4(addressPart);
  return address === undefined ? undefined : { address, prefix };
}

/** IPv4 dotted quad to a 32-bit number. Rejects anything else, including leading zeros. */
export function parseIpv4(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  let result = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > 255) {
      return undefined;
    }
    result = result * 256 + octet;
  }
  return result;
}

/** True when `ip` falls inside the network `cidr` describes. */
export function isInSubnet(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  const target = parseIpv4(ip);
  if (parsed === undefined || target === undefined) {
    return false;
  }
  if (parsed.prefix === 0) {
    return true;
  }
  // `>>> 0` because a 32-bit mask with the top bit set is negative in JS otherwise, and
  // the comparison below would silently disagree with itself for /1 through /8.
  const mask = (0xffff_ffff << (32 - parsed.prefix)) >>> 0;
  return (parsed.address & mask) >>> 0 === (target & mask) >>> 0;
}

export interface PreflightInput {
  readonly side: 'lan' | 'tnc';
  readonly config: NetworkSide;
  readonly interfaces: readonly InterfaceDiscovery[];
}

export function preflight(input: PreflightInput): PreflightIssue[] {
  const { side, config, interfaces } = input;
  const issues: PreflightIssue[] = [];
  const at = (field: string, message: string): void => {
    issues.push({ field: `${side}.${field}`, message });
  };

  const nic = interfaces.find((entry) => entry.name === config.interface);
  if (nic === undefined) {
    at(
      'interface',
      `This machine has no interface called "${config.interface}". It may have been renamed or removed.`,
    );
    // Everything below describes addressing on an interface that is not there.
    return issues;
  }

  if (nic.state === 'down' && config.method === 'dhcp') {
    // Not fatal — the cable may be plugged in after this — but a DHCP lease on a link
    // that is down will never arrive, and the operator should know before waiting.
    at('method', `${config.interface} has no link. DHCP will not obtain an address until it does.`);
  }

  if (config.method !== 'static') {
    return issues;
  }

  if (config.address === undefined) {
    at('address', 'A static configuration needs an address.');
    return issues;
  }
  if (parseCidr(config.address) === undefined) {
    at('address', 'Expected an address with a prefix length, such as 192.168.1.10/24.');
    return issues;
  }

  if (config.gateway !== undefined && !isInSubnet(config.gateway, config.address)) {
    at(
      'gateway',
      `The gateway ${config.gateway} is not inside ${config.address}, so it cannot be reached.`,
    );
  }

  for (const [index, server] of config.dns.entries()) {
    if (parseIpv4(server) === undefined && !server.includes(':')) {
      at(`dns.${String(index)}`, `"${server}" is not an IP address.`);
    }
  }

  return issues;
}
