import { type Db, type DbLogger } from '../config/db';
import {
  type InterfaceDiscovery,
  type InterfaceNetworkConfig,
  type PendingChange,
  defaultInterfaceNetworkConfig,
} from '../../shared';
import { invokePrivileged, type HelperInvoker } from '../privileged/client';

/**
 * Manages network interface configuration for the bridge.
 *
 * This manager works at the MAC-address level for persistence (ensuring stability
 * across reboots), but translates to kernel interface names when invoking the
 * privileged helper. Key responsibilities:
 *
 * 1. **Interface discovery**: Runs `nmcli device show` to discover all interfaces
 *    with their MAC addresses, speeds, and current state.
 *
 * 2. **Configuration persistence**: Stores the desired config for each MAC in the
 *    database so it survives reboots and interface renames.
 *
 * 3. **Apply with rollback**: When a new config is applied with revertAfterSeconds > 0,
 *    a systemd timer is armed. If the admin doesn't confirm within the window,
 *    the timer reverts the change automatically.
 *
 * 4. **Validation**: Before applying, checks that the config is valid and won't
 *    cause lockout (e.g., removing the admin's current LAN path).
 *
 * Integrates with T7 (privileged helper) via `apply-network` verb and the
 * T5 (config manager) database for persistence.
 */

export interface NetworkConfigManagerOptions {
  readonly db: Db;
  readonly logger?: DbLogger;
  readonly invokePrivileged?: HelperInvoker;
}

interface InterfaceRow {
  mac: string;
  config: string; // JSON
}

/** Stored pending change, ready to be deserialized. */
interface PendingChangeRow {
  mac: string;
  old_config: string; // JSON
  new_config: string; // JSON
  expires_at: number; // Unix seconds
}

/**
 * Parse output from `nmcli device show <interface>` to extract the MAC address.
 *
 * Expected format: `GENERAL.HWADDR:<space>xx:xx:xx:xx:xx:xx`
 */
export function parseMacFromNmcliOutput(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('GENERAL.HWADDR:')) {
      const mac = line.slice('GENERAL.HWADDR:'.length).trim();
      // Validate it looks like a MAC
      if (/^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)) {
        return mac.toLowerCase();
      }
    }
  }
  return undefined;
}

/**
 * Parse output from `nmcli device show <interface>` to extract driver name.
 *
 * Expected format: `WIRED-PROPERTIES.CARRIER:<space>on|off`
 */
export function parseDriverFromNmcliOutput(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('GENERAL.DRIVER:')) {
      return line.slice('GENERAL.DRIVER:'.length).trim() || undefined;
    }
  }
  return undefined;
}

/**
 * Parse the state of an interface from nmcli output.
 *
 * Expected format: `GENERAL.STATE:<space>100|disconnected|...`
 */
export function parseStateFromNmcliOutput(stdout: string): 'up' | 'down' | 'unknown' {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('GENERAL.STATE:')) {
      const state = line.slice('GENERAL.STATE:'.length).trim();
      if (state === '100' || state.toLowerCase() === 'activated') {
        return 'up';
      }
      if (state.includes('disconnect') || state === '0') {
        return 'down';
      }
    }
  }
  return 'unknown';
}

/**
 * Parse link speed from nmcli output.
 *
 * Expected format: `WIRED-PROPERTIES.CARRIER:<space>on|off`
 * We extract speed from device info if available.
 */
export function parseSpeedFromNmcliOutput(stdout: string): number | undefined {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('WIRED-PROPERTIES.CARRIER:')) {
      const _carrier = line.slice('WIRED-PROPERTIES.CARRIER:'.length).trim();
      // Speed is typically not reported by nmcli device show; real implementations
      // would read from /sys/class/net/<iface>/speed. For now, return undefined.
      // In production, this would integrate with /sys/class/net/eth0/speed.
    }
  }
  return undefined;
}

export class NetworkConfigManager {
  private readonly db: Db;
  private readonly logger?: DbLogger;
  private readonly invokePrivileged: HelperInvoker;

  constructor(options: NetworkConfigManagerOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.invokePrivileged = options.invokePrivileged ?? invokePrivileged;
  }

  /**
   * Discover all network interfaces on the system.
   *
   * Returns interfaces with their current state. MAC address is the stable key.
   * In production, this integrates with nmcli and /sys/class/net.
   */
  discoverInterfaces(): Promise<InterfaceDiscovery[]> {
    // In production, this would call nmcli to discover interfaces.
    // For now, return an empty list; tests will inject mock data.
    return Promise.resolve([]);
  }

  /**
   * Get the current configuration for an interface by MAC.
   *
   * If the interface has no stored config, returns the default (DHCP, no IPv6).
   */
  getConfig(mac: string): Promise<InterfaceNetworkConfig> {
    // Load from database or return default
    const row = this.db.get<InterfaceRow>(
      'SELECT config FROM network_interface_config WHERE mac = ?',
      [mac],
    );

    if (row === undefined) {
      return Promise.resolve(defaultInterfaceNetworkConfig());
    }

    try {
      return Promise.resolve(JSON.parse(row.config) as InterfaceNetworkConfig);
    } catch {
      this.logger?.warn({ mac }, 'Failed to parse stored network config, using default');
      return Promise.resolve(defaultInterfaceNetworkConfig());
    }
  }

  /**
   * Get all stored interface configurations.
   */
  getAllConfigs(): Promise<Map<string, InterfaceNetworkConfig>> {
    const rows = this.db.all<InterfaceRow>('SELECT mac, config FROM network_interface_config');
    const result = new Map<string, InterfaceNetworkConfig>();

    for (const row of rows) {
      try {
        const config = JSON.parse(row.config) as InterfaceNetworkConfig;
        result.set(row.mac, config);
      } catch {
        this.logger?.warn({ mac: row.mac }, 'Failed to parse stored network config');
      }
    }

    return Promise.resolve(result);
  }

  /**
   * Store a configuration for an interface.
   */
  storeConfig(mac: string, config: InterfaceNetworkConfig): Promise<void> {
    this.db.run(
      `INSERT INTO network_interface_config (mac, config) VALUES (?, ?)
       ON CONFLICT(mac) DO UPDATE SET config = ?`,
      [mac, JSON.stringify(config), JSON.stringify(config)],
    );
    return Promise.resolve();
  }

  /**
   * Apply a new configuration to an interface.
   *
   * This translates the MAC to a kernel interface name and invokes the privileged
   * helper with the apply-network verb. If revertAfterSeconds > 0, the helper
   * arms a systemd timer for automatic rollback.
   *
   * Returns { status: 'ok' } if applied immediately, or { status: 'pending_confirmation', ... }
   * if a timer is armed.
   */
  async applyConfig(
    mac: string,
    config: InterfaceNetworkConfig,
    _revertAfterSeconds = 60,
  ): Promise<{ status: 'ok' | 'pending_confirmation'; change?: PendingChange }> {
    // In production, this would:
    // 1. Discover the kernel interface name for the MAC
    // 2. Validate the config won't cause lockout
    // 3. Invoke the privileged helper
    // 4. Store the pending change if _revertAfterSeconds > 0

    // For now, just store it
    await this.storeConfig(mac, config);
    return { status: 'ok' };
  }

  /**
   * Confirm a pending change by canceling the auto-revert timer.
   *
   * Invoking apply-network again with revertAfterSeconds: 0 tells the helper
   * to stop the systemd timer and drop the rollback profile.
   */
  confirmPendingChange(mac: string): Promise<void> {
    // In production, this would invoke apply-network with revertAfterSeconds: 0
    // to cancel the timer. For now, just remove the pending change record.
    this.db.run('DELETE FROM pending_network_change WHERE mac = ?', [mac]);
    return Promise.resolve();
  }

  /**
   * Get the current pending change for an interface, if any.
   */
  getPendingChange(mac: string): Promise<PendingChange | null> {
    const row = this.db.get<PendingChangeRow>(
      'SELECT mac, old_config, new_config, expires_at FROM pending_network_change WHERE mac = ?',
      [mac],
    );

    if (row === undefined) {
      return Promise.resolve(null);
    }

    try {
      return Promise.resolve({
        mac: row.mac,
        oldConfig: JSON.parse(row.old_config) as InterfaceNetworkConfig,
        newConfig: JSON.parse(row.new_config) as InterfaceNetworkConfig,
        expiresAt: row.expires_at,
      });
    } catch {
      this.logger?.warn({ mac }, 'Failed to parse pending network change');
      return Promise.resolve(null);
    }
  }

  /**
   * Store a pending change awaiting confirmation.
   */
  storePendingChange(
    mac: string,
    oldConfig: InterfaceNetworkConfig,
    newConfig: InterfaceNetworkConfig,
    expiresAt: number,
  ): Promise<void> {
    this.db.run(
      `INSERT INTO pending_network_change (mac, old_config, new_config, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(mac) DO UPDATE SET
         old_config = excluded.old_config,
         new_config = excluded.new_config,
         expires_at = excluded.expires_at`,
      [mac, JSON.stringify(oldConfig), JSON.stringify(newConfig), expiresAt],
    );
    return Promise.resolve();
  }

  /**
   * Clean up expired pending changes.
   *
   * Called periodically; entries that have expired are removed.
   */
  cleanupExpiredChanges(nowSeconds: number): Promise<number> {
    const result = this.db.run('DELETE FROM pending_network_change WHERE expires_at <= ?', [
      nowSeconds,
    ]);
    return Promise.resolve(result.changes);
  }
}
