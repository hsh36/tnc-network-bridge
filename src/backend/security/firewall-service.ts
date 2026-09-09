import { type DbLogger } from '../config/db';
import { type HelperInvoker, invokePrivileged } from '../privileged/client';

import { renderManagementIsolation } from './firewall';

/**
 * Keeps the management-isolation ruleset loaded.
 *
 * Called at startup and again whenever the network configuration changes, because the
 * rule names an interface: moving the TNC side from `eth1` to `eth2` without reloading
 * would leave the drop pointing at the wrong NIC — that is, at nothing — and quietly
 * expose the admin interface on the machine segment.
 *
 * A failure is logged and swallowed. The alternative is refusing to start, and a bridge
 * that will not boot because `nft` is missing is worse than one that boots and says so:
 * `management-guard.ts` still refuses TNC-side requests inside the process, so the
 * appliance degrades to "protected but noisy" rather than "unreachable".
 */
export interface FirewallServiceOptions {
  readonly logger?: DbLogger | undefined;
  /** Injectable for tests; defaults to the real sudo-backed helper. */
  readonly invoke?: HelperInvoker;
}

export class FirewallService {
  private readonly logger: DbLogger | undefined;
  private readonly invoke: HelperInvoker;
  private lastApplied: string | undefined;

  constructor(options: FirewallServiceOptions = {}) {
    this.logger = options.logger;
    this.invoke = options.invoke ?? invokePrivileged;
  }

  /**
   * Loads the ruleset for `tncInterface`. Returns whether the ruleset is now in force.
   *
   * Skips the helper call when the same ruleset was applied already: this runs on every
   * config save, and each invocation is a sudo call plus an `nft -f` that briefly
   * replaces the table.
   */
  apply(tncInterface: string): boolean {
    let content: string;
    try {
      content = renderManagementIsolation({ tncInterface });
    } catch (error) {
      this.logger?.error(
        { tncInterface, error: messageOf(error) },
        'could not build the management isolation ruleset',
      );
      return false;
    }

    if (content === this.lastApplied) {
      return true;
    }

    try {
      const response = this.invoke({ verb: 'write-nft-ruleset', content });
      if (!response.ok) {
        this.logger?.error(
          { tncInterface, error: response.error },
          'the helper refused the management isolation ruleset',
        );
        return false;
      }
      this.lastApplied = content;
      this.logger?.info(
        { tncInterface },
        'management interface isolated from the TNC segment by nftables',
      );
      return true;
    } catch (error) {
      this.logger?.error(
        { tncInterface, error: messageOf(error) },
        'could not load the management isolation ruleset; the in-process guard still applies',
      );
      return false;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
