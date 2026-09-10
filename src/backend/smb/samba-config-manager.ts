import { type ConfigManager } from '../config/config-manager';
import { type Db, type DbLogger } from '../config/db';
import { invokePrivileged, type HelperInvoker } from '../privileged/client';
import { ShareStore } from '../sync/share-store';

import { buildSmbConf, type SmbShareConfig } from './smb-conf';

/**
 * Writes `smb.conf` and reloads Samba whenever what it should contain changes.
 *
 * `buildSmbConf` and the `write-samba-config` verb were both complete and tested, and
 * nothing in the running service ever called either of them. The machine-facing half of
 * the bridge — the entire reason the product exists — was therefore not serving SMB at
 * all: shares synced into the local cache and no TNC could reach them.
 *
 * Reconciliation rather than save-triggered writes, for the same reason the sync
 * supervisor works that way. The desired file is a pure function of the config and the
 * shares table, so the only correct behaviour after a restart, a share edit or a
 * failover is "make the file match" — not "remember to write it here, and here, and in
 * this third place somebody will add next month".
 */

export interface SambaConfigManagerOptions {
  readonly db: Db;
  readonly config: ConfigManager;
  readonly logger?: DbLogger;
  /** Injected by tests; production calls the real helper over sudo. */
  readonly invoke?: HelperInvoker;
}

export class SambaConfigManager {
  private readonly db: Db;
  private readonly config: ConfigManager;
  private readonly logger: DbLogger | undefined;
  private readonly invoke: HelperInvoker;
  private readonly shares: ShareStore;
  /** The last content successfully written, so an unchanged reconcile is free. */
  private lastWritten: string | undefined;

  constructor(options: SambaConfigManagerOptions) {
    this.db = options.db;
    this.config = options.config;
    this.logger = options.logger;
    this.invoke = options.invoke ?? invokePrivileged;
    this.shares = new ShareStore({ db: options.db, config: options.config });

    // Both sections feed the file: `smb` supplies the protocol and naming globals, and
    // `network` supplies the interface smbd is confined to. Missing the second is how a
    // TNC-side NIC change would leave smbd bound to a card nothing arrives on.
    this.config.onSectionChange('smb', () => {
      this.reconcile();
    });
    this.config.onSectionChange('network', () => {
      this.reconcile();
    });
  }

  /** The file the current configuration and share list call for. */
  render(): string {
    const smb = this.config.get('smb');
    const network = this.config.get('network');

    const shares: SmbShareConfig[] = this.shares
      .list(500, 0)
      .items.filter((share) => share.enabled)
      .map((share) => ({
        name: share.name,
        // The *cache*, never the mount point. Exporting the CIFS mount would put a TNC's
        // writes straight onto the server with none of the locking or conflict handling
        // this bridge exists to provide, and would hang the machine whenever the server
        // was unreachable.
        path: share.cachePath,
        readOnly: share.readOnly || share.failoverReadOnly,
        guestOk: share.tncGuestOk,
        ...(share.excludePatterns.length > 0 ? { extraVetoFiles: share.excludePatterns } : {}),
      }));

    return buildSmbConf({
      tncInterface: network.tnc.interface,
      // Handed over so the generator can prove it is absent rather than assume it.
      lanInterface: network.lan.interface,
      workgroup: smb.tnc.workgroup,
      // The SMB server name is the TNC side's hostname: the name the machines dial,
      // which is deliberately independent of what the appliance calls itself.
      ...(network.tnc.hostname === '' ? {} : { netbiosName: network.tnc.hostname }),
      maxProtocol: smb.tnc.maxProtocol,
      ntlmAuth: smb.tnc.ntlmAuth,
      lanmanAuth: smb.tnc.lanmanAuth,
      dosCharset: smb.tnc.dosCharset,
      shares,
    });
  }

  /**
   * Make `smb.conf` match, and reload Samba if it changed.
   *
   * Never throws. A bridge that cannot write its Samba config is still bridging files
   * for whoever can already reach it, and taking the process down — or failing the
   * share edit that triggered this — would turn a degraded state into an outage. The
   * failure is logged, and the next reconcile tries again.
   */
  reconcile(): boolean {
    let content: string;
    try {
      content = this.render();
    } catch (error) {
      this.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'could not render smb.conf',
      );
      return false;
    }

    if (content === this.lastWritten) {
      return false;
    }

    try {
      // The helper validates with `testparm` against a scratch file and only renames a
      // clean parse into place, so a bad render cannot leave smbd unconfined.
      this.invoke({ verb: 'write-samba-config', content });
      this.lastWritten = content;
      this.logger?.info({ bytes: content.length, shares: this.shareCount() }, 'smb.conf written');
      return true;
    } catch (error) {
      this.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'could not write smb.conf',
      );
      return false;
    }
  }

  /**
   * Restart smbd rather than reload it.
   *
   * `interfaces` and `bind interfaces only` are read at startup; smbd will not rebind
   * on a reload. A TNC-side NIC change therefore needs a restart, or smbd keeps
   * listening on the card the operator just moved away from.
   */
  restart(): void {
    try {
      this.invoke({ verb: 'reload-samba', mode: 'restart' });
    } catch (error) {
      this.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'could not restart Samba',
      );
    }
  }

  private shareCount(): number {
    return this.db.pluck<number>('SELECT COUNT(*) FROM shares WHERE enabled = 1') ?? 0;
  }
}
