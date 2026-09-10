import { networkInterfaces } from 'node:os';

import { type NetworkSide, type PendingChange } from '../../shared';
import { type ConfigManager } from '../config/config-manager';
import { type Db, type DbLogger } from '../config/db';
import { PrivilegedCallError, type HelperInvoker, invokePrivileged } from '../privileged/client';

import { discoverInterfaces } from './interface-discovery';
import { type PreflightIssue, preflight } from './preflight';

/**
 * Applying a saved network configuration to the running system.
 *
 * The dangerous case is the only interesting one: changing the interface the operator is
 * connected over. The privileged helper already handles it properly — it clones the
 * NetworkManager profile and arms a *transient systemd timer* to bring the clone back,
 * so the rollback outlives the service that just cut its own network. What this class
 * decides is when to ask for that.
 *
 * Not "LAN gets a timer, TNC does not". That rule is wrong in two configurations this
 * build supports: both sides sharing one NIC through tagged VLANs, and an operator
 * reaching the bridge from the machine segment. The question asked instead is whether
 * *this request* arrived on the interface being changed. If it did, arm the timer; if
 * it did not, the change cannot cut this connection and applying it outright is honest.
 */

export type NetworkSideName = 'lan' | 'tnc';

export class NetworkApplyError extends Error {
  constructor(
    message: string,
    readonly issues: readonly PreflightIssue[] = [],
  ) {
    super(message);
    this.name = 'NetworkApplyError';
  }
}

export interface ApplyResult {
  readonly side: NetworkSideName;
  readonly interface: string;
  /** `applied` when nothing had to be risked; `pending_confirmation` when a timer is armed. */
  readonly status: 'applied' | 'pending_confirmation';
  readonly expiresAt: number | null;
  /**
   * Where the operator should expect to find the interface afterwards, when the address
   * is known in advance. Shown before applying so they can copy it — after the change
   * they may have no way to look it up.
   */
  readonly expectedUrl: string | null;
}

export interface NetworkApplyServiceOptions {
  readonly db: Db;
  readonly config: ConfigManager;
  readonly logger?: DbLogger | undefined;
  readonly invoke?: HelperInvoker;
  readonly discover?: typeof discoverInterfaces;
  /** Injectable for tests; defaults to the real `os.networkInterfaces`. */
  readonly read?: typeof networkInterfaces;
  readonly now?: () => number;
}

export class NetworkApplyService {
  private readonly db: Db;
  private readonly config: ConfigManager;
  private readonly logger: DbLogger | undefined;
  private readonly invoke: HelperInvoker;
  private readonly discover: typeof discoverInterfaces;
  private readonly read: typeof networkInterfaces;
  private readonly now: () => number;

  constructor(options: NetworkApplyServiceOptions) {
    this.db = options.db;
    this.config = options.config;
    this.logger = options.logger;
    this.invoke = options.invoke ?? invokePrivileged;
    this.discover = options.discover ?? discoverInterfaces;
    this.read = options.read ?? networkInterfaces;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Applies the stored configuration for one side.
   *
   * `localAddress` is the address the calling request was accepted on — the local end
   * of the TCP connection, which is what makes "would this cut my own connection"
   * answerable at all.
   */
  apply(side: NetworkSideName, localAddress?: string): ApplyResult {
    const network = this.config.get('network');
    const desired = network[side];
    const interfaces = this.discover();

    const issues = preflight({ side, config: desired, interfaces });
    if (issues.length > 0) {
      throw new NetworkApplyError('The configuration was not applied', issues);
    }

    const nic = interfaces.find((entry) => entry.name === desired.interface);
    if (nic === undefined) {
      throw new NetworkApplyError(`No interface called "${desired.interface}"`);
    }

    const selfAffecting = this.wouldCutCaller(desired.interface, localAddress, interfaces);
    const revertAfterSeconds = selfAffecting ? network.applyRevertSeconds : 0;

    this.callHelper(desired, revertAfterSeconds);

    const expiresAt = revertAfterSeconds > 0 ? this.now() + revertAfterSeconds : null;
    if (expiresAt === null) {
      this.clearPending(nic.mac);
    } else {
      this.recordPending(nic.mac, desired, expiresAt);
    }

    this.logger?.info(
      { side, interface: desired.interface, selfAffecting, revertAfterSeconds },
      'network configuration applied',
    );

    return {
      side,
      interface: desired.interface,
      status: expiresAt === null ? 'applied' : 'pending_confirmation',
      expiresAt,
      expectedUrl: expectedUrlFor(desired),
    };
  }

  /**
   * Confirms a pending change: re-applies with no timer, which is how the helper is
   * told to stop the systemd unit and drop the backup profile.
   */
  confirm(side: NetworkSideName): void {
    const desired = this.config.get('network')[side];
    const nic = this.discover().find((entry) => entry.name === desired.interface);
    if (nic === undefined) {
      throw new NetworkApplyError(`No interface called "${desired.interface}"`);
    }

    this.callHelper(desired, 0);

    this.clearPending(nic.mac);
    this.logger?.info({ side, interface: desired.interface }, 'network change confirmed');
  }

  /**
   * Pending changes with the time left on each.
   *
   * Read from the database rather than from memory precisely because the operator will
   * be arriving in a *new* session on a *new* address when they need to see this.
   */
  pending(): { change: PendingChange; secondsRemaining: number }[] {
    const rows = this.db.all<{
      mac: string;
      old_config: string;
      new_config: string;
      expires_at: number;
    }>(
      'SELECT mac, old_config, new_config, expires_at FROM pending_network_change ORDER BY expires_at',
    );
    const now = this.now();
    return rows.map((row) => ({
      change: {
        mac: row.mac,
        oldConfig: JSON.parse(row.old_config) as PendingChange['oldConfig'],
        newConfig: JSON.parse(row.new_config) as PendingChange['newConfig'],
        expiresAt: row.expires_at,
      },
      secondsRemaining: Math.max(0, row.expires_at - now),
    }));
  }

  /**
   * Whether applying to `iface` could sever the connection this request came in on.
   *
   * Unknown answers conservatively: no local address, or an address that belongs to no
   * interface we can see, is treated as self-affecting. Arming a timer that was not
   * needed costs one confirmation click; not arming one that was needed costs a site
   * visit.
   */
  private wouldCutCaller(
    iface: string,
    localAddress: string | undefined,
    interfaces: readonly { name: string }[],
  ): boolean {
    if (localAddress === undefined || localAddress === '') {
      return true;
    }
    const normalised = localAddress.toLowerCase().replace(/^::ffff:/, '');
    if (isLoopback(normalised)) {
      // A request over loopback survives any change to a physical NIC.
      return false;
    }
    const owner = ownerOf(normalised, this.read);
    return owner === undefined || owner === iface || !interfaces.some((i) => i.name === owner);
  }

  /**
   * One call, one place to translate its failure.
   *
   * `invokePrivileged` signals a refusal by throwing `PrivilegedCallError`; it never
   * returns a response with `ok: false`. Checking the returned flag — which is what both
   * call sites used to do — is dead code, and the real error escaped the route as an
   * unhandled 500 carrying nothing the operator could act on.
   */
  private callHelper(desired: NetworkSide, revertAfterSeconds: number): void {
    try {
      this.invoke({
        verb: 'apply-network',
        interface: desired.interface,
        method: desired.method,
        ...(desired.address === undefined ? {} : { address: desired.address }),
        ...(desired.gateway === undefined ? {} : { gateway: desired.gateway }),
        dns: [...desired.dns],
        mtu: desired.mtu,
        ipv6Enabled: desired.ipv6,
        vlan: desired.vlan,
        revertAfterSeconds,
      });
    } catch (error) {
      if (error instanceof PrivilegedCallError) {
        throw new NetworkApplyError(error.message);
      }
      throw error;
    }
  }

  private recordPending(mac: string, applied: NetworkSide, expiresAt: number): void {
    const previous = this.db.pluck<string>(
      'SELECT config FROM network_interface_config WHERE mac = @mac',
      { mac },
    );
    this.db.run(
      `INSERT INTO pending_network_change (mac, old_config, new_config, expires_at, created_at)
       VALUES (@mac, @oldConfig, @newConfig, @expiresAt, @now)
       ON CONFLICT(mac) DO UPDATE SET
         old_config = excluded.old_config,
         new_config = excluded.new_config,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at`,
      {
        mac,
        oldConfig: previous ?? JSON.stringify(toInterfaceConfig(applied)),
        newConfig: JSON.stringify(toInterfaceConfig(applied)),
        expiresAt,
        now: this.now(),
      },
    );
    this.storeConfig(mac, applied);
  }

  private clearPending(mac: string): void {
    this.db.run('DELETE FROM pending_network_change WHERE mac = @mac', { mac });
  }

  private storeConfig(mac: string, applied: NetworkSide): void {
    this.db.run(
      `INSERT INTO network_interface_config (mac, config, stored_at)
       VALUES (@mac, @config, @now)
       ON CONFLICT(mac) DO UPDATE SET config = excluded.config, stored_at = excluded.stored_at`,
      { mac, config: JSON.stringify(toInterfaceConfig(applied)), now: this.now() },
    );
  }
}

/** The MAC-keyed shape the network tables and the helper-facing API store. */
function toInterfaceConfig(side: NetworkSide): Record<string, unknown> {
  return {
    method: side.method,
    ...(side.address === undefined ? {} : { address: side.address }),
    ...(side.gateway === undefined ? {} : { gateway: side.gateway }),
    dns: [...side.dns],
    mtu: side.mtu,
    ipv6Enabled: side.ipv6,
  };
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address.startsWith('127.');
}

/** Which interface currently holds `address`, if any. */
function ownerOf(address: string, read: typeof networkInterfaces): string | undefined {
  for (const [name, entries] of Object.entries(read())) {
    for (const entry of entries ?? []) {
      if (entry.address.toLowerCase().replace(/^::ffff:/, '') === address) {
        return name;
      }
    }
  }
  return undefined;
}

/**
 * The URL the interface is expected to answer on after the change, when that is
 * knowable. DHCP is not knowable, and guessing would send the operator to the wrong
 * place at the moment they can least afford it.
 */
function expectedUrlFor(side: NetworkSide): string | null {
  if (side.method !== 'static' || side.address === undefined) {
    return null;
  }
  const [host] = side.address.split('/');
  return host === undefined ? null : `https://${host}/`;
}
