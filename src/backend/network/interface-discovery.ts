import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, join } from 'node:path';

import { type InterfaceDiscovery } from '../../shared';

/**
 * Enumerates the machine's NICs for the interface pickers in Settings → Network.
 *
 * Read from `/sys/class/net` rather than from `os.networkInterfaces()`, which is what
 * the rest of the backend uses for reporting. The difference decides whether this
 * feature works at all: `os.networkInterfaces()` lists interfaces *that have an
 * address*, and the second NIC on a fresh bridge has none — it is unconfigured, which
 * is precisely why the operator is opening the picker. Sysfs lists the hardware.
 *
 * Nothing here needs privilege; every attribute read is world-readable.
 */

const SYSFS_NET = '/sys/class/net';

/** Interfaces that are never a LAN or TNC side, so offering them would only mislead. */
const EXCLUDED = new Set(['lo']);

/** The kernel reports this MAC for interfaces that have none of their own. */
const NULL_MAC = '00:00:00:00:00:00';

export interface SysfsReader {
  listInterfaces(): string[];
  /** One sysfs attribute, or `undefined` if it is absent or unreadable. */
  readAttribute(iface: string, attribute: string): string | undefined;
  /** Target of the driver symlink, or `undefined` for virtual interfaces. */
  readDriver(iface: string): string | undefined;
  /** Interface names that currently hold at least one address. */
  addressed(): Set<string>;
}

export function sysfsReader(root: string = SYSFS_NET): SysfsReader {
  return {
    listInterfaces: () => {
      try {
        return readdirSync(root);
      } catch {
        // Not Linux, or a container without sysfs. An empty list is honest: we cannot
        // enumerate hardware here, and inventing entries would be worse.
        return [];
      }
    },
    readAttribute: (iface, attribute) => {
      try {
        return readFileSync(join(root, iface, attribute), 'utf8').trim();
      } catch {
        // `speed` in particular throws EINVAL on a link that is down — an expected
        // state for an unconfigured NIC, not an error worth surfacing.
        return undefined;
      }
    },
    readDriver: (iface) => {
      try {
        return basename(readlinkSync(join(root, iface, 'device', 'driver')));
      } catch {
        return undefined;
      }
    },
    addressed: () => {
      const named = new Set<string>();
      for (const [name, addresses] of Object.entries(networkInterfaces())) {
        if ((addresses ?? []).length > 0) {
          named.add(name);
        }
      }
      return named;
    },
  };
}

/** Parses `/sys/class/net/<iface>/operstate`, which carries more states than we model. */
export function toState(operstate: string | undefined): InterfaceDiscovery['state'] {
  if (operstate === 'up') return 'up';
  if (operstate === 'down' || operstate === 'lowerlayerdown') return 'down';
  return 'unknown';
}

/** `speed` is -1 (or unreadable) whenever the driver cannot answer, notably when down. */
export function toSpeed(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Every physical NIC on the machine, sorted by name so the picker does not reorder
 * itself between reloads.
 */
export function discoverInterfaces(reader: SysfsReader = sysfsReader()): InterfaceDiscovery[] {
  const withAddress = reader.addressed();
  const found: InterfaceDiscovery[] = [];

  for (const name of reader.listInterfaces()) {
    if (EXCLUDED.has(name)) {
      continue;
    }
    const mac = reader.readAttribute(name, 'address');
    // No MAC, or the all-zero placeholder, means this is not something an operator can
    // meaningfully bind a side of the bridge to.
    if (mac === undefined || mac === '' || mac === NULL_MAC) {
      continue;
    }

    found.push({
      mac,
      name,
      state: toState(reader.readAttribute(name, 'operstate')),
      speedMbps: toSpeed(reader.readAttribute(name, 'speed')),
      driver: reader.readDriver(name) ?? null,
      hasAddress: withAddress.has(name),
    });
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}
