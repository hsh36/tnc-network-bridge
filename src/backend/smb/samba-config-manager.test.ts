import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { type PrivilegedRequest } from '../privileged/verbs';
import { ShareStore } from '../sync/share-store';

import { SambaConfigManager } from './samba-config-manager';

/**
 * The defect: `buildSmbConf` and the `write-samba-config` verb were both complete and
 * tested, and nothing in the running service called either. The machine-facing half of
 * the bridge — the whole reason the product exists — served no shares at all. Files
 * synced into the local cache and no TNC could reach them.
 */

let db: Db;
let config: ConfigManager;
let invoked: PrivilegedRequest[];

function manager(invoke?: () => never): SambaConfigManager {
  return new SambaConfigManager({
    db,
    config,
    invoke:
      invoke ??
      ((request) => {
        invoked.push(request);
        return { ok: true, verb: request.verb, commands: [], detail: {} } as never;
      }),
  });
}

function addShare(name: string, overrides: Record<string, unknown> = {}): void {
  new ShareStore({ db, config }).create({
    name,
    serverUnc: `//server/${name}`,
    enabled: true,
    smbDomain: null,
    smbUser: null,
    smbVersion: '3.1.1',
    smbSeal: true,
    conflictMode: 'last_write_wins',
    excludePatterns: [],
    scanIntervalMs: 5000,
    bandwidthLimitKbps: null,
    maxFileSizeMb: 100,
    // Reachable by default, so a test that does not care about access control still
    // gets an exported share. The ones that do care override it.
    tncGuestOk: true,
    tncUser: null,
    tncPassword: '',
    ...overrides,
  } as never);
}

/** The content of the last write-samba-config call. */
function written(): string {
  const last = [...invoked].reverse().find((r) => r.verb === 'write-samba-config');
  return last !== undefined && 'content' in last ? last.content : '';
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  invoked = [];
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('reconcile', () => {
  it('writes smb.conf, which nothing in the service used to do at all', () => {
    expect(manager().reconcile()).toBe(true);

    expect(invoked.map((r) => r.verb)).toContain('write-samba-config');
    expect(written()).toContain('[global]');
  });

  it('exports every enabled share', () => {
    addShare('werkstatt');
    addShare('buero');

    manager().reconcile();

    expect(written()).toContain('[werkstatt]');
    expect(written()).toContain('[buero]');
  });

  it('does not export a disabled share', () => {
    // Disabled means "do not sync this", and a share that is not synced has a stale or
    // empty cache. Exporting it would show a machine the wrong files.
    addShare('werkstatt', { enabled: false });

    manager().reconcile();

    expect(written()).not.toContain('[werkstatt]');
  });

  it('exports the cache, never the server mount', () => {
    // Exporting the CIFS mount would put a TNC's writes straight onto the server with
    // none of the locking or conflict handling this bridge exists to provide, and would
    // hang the machine whenever the server was unreachable.
    addShare('werkstatt');

    manager().reconcile();

    expect(written()).toContain('/srv/tnc/werkstatt');
    expect(written()).not.toContain('/mnt/tnc-server/werkstatt');
  });

  it('binds smbd to the TNC interface and never to the LAN one', () => {
    config.set('network', {
      ...config.get('network'),
      lan: { ...config.get('network').lan, interface: 'eth0' },
      tnc: { ...config.get('network').tnc, interface: 'eth1' },
    });

    manager().reconcile();

    expect(written()).toMatch(/interfaces\s*=.*eth1/);
    expect(written()).not.toMatch(/interfaces\s*=.*eth0/);
  });

  it('names the server what the TNC side is called, not what the host is called', () => {
    config.set('network', {
      ...config.get('network'),
      tnc: { ...config.get('network').tnc, hostname: 'CNC-BRIDGE' },
    });

    manager().reconcile();

    expect(written()).toMatch(/netbios name\s*=\s*CNC-BRIDGE/);
  });

  it('carries the protocol range and workgroup from the smb section', () => {
    config.set('smb', {
      ...config.get('smb'),
      tnc: { ...config.get('smb').tnc, workgroup: 'WERKSTATT', maxProtocol: 'SMB2' },
    });

    manager().reconcile();

    expect(written()).toMatch(/workgroup\s*=\s*WERKSTATT/);
  });

  it('marks a read-only share read-only', () => {
    addShare('werkstatt');
    db.run("UPDATE shares SET read_only = 1 WHERE name = 'werkstatt'");

    manager().reconcile();

    expect(written()).toMatch(/\[werkstatt][\s\S]*?read only\s*=\s*yes/);
  });

  it('is a no-op when nothing changed, so a reload is not provoked for free', () => {
    const samba = manager();
    expect(samba.reconcile()).toBe(true);
    invoked = [];

    expect(samba.reconcile()).toBe(false);
    expect(invoked).toHaveLength(0);
  });

  it('writes again once a share is added', () => {
    const samba = manager();
    samba.reconcile();
    addShare('werkstatt');

    expect(samba.reconcile()).toBe(true);
    expect(written()).toContain('[werkstatt]');
  });

  it('reconciles on its own when the network section changes', () => {
    const samba = manager();
    samba.reconcile();
    invoked = [];

    config.set('network', {
      ...config.get('network'),
      tnc: { ...config.get('network').tnc, interface: 'eth2' },
    });

    // Otherwise a TNC-side NIC change leaves smbd bound to a card nothing arrives on.
    expect(written()).toMatch(/interfaces\s*=.*eth2/);
    void samba;
  });

  it('reconciles on its own when the smb section changes', () => {
    const samba = manager();
    samba.reconcile();
    invoked = [];

    config.set('smb', {
      ...config.get('smb'),
      tnc: { ...config.get('smb').tnc, workgroup: 'NEUWERK' },
    });

    expect(written()).toMatch(/workgroup\s*=\s*NEUWERK/);
  });

  it('does not throw when the helper refuses', () => {
    // A bridge that cannot write its Samba config is still bridging files for whoever
    // can already reach it. Failing the share edit that triggered this would turn a
    // degraded state into an outage.
    const samba = manager(() => {
      throw new Error('sudo: a password is required');
    });

    expect(() => samba.reconcile()).not.toThrow();
    expect(samba.reconcile()).toBe(false);
  });

  it('retries on the next reconcile after a failure, rather than caching the failure', () => {
    let fail = true;
    const samba = new SambaConfigManager({
      db,
      config,
      invoke: (request: PrivilegedRequest) => {
        if (fail) {
          throw new Error('helper unavailable');
        }
        invoked.push(request);
        return { ok: true, verb: request.verb, commands: [], detail: {} };
      },
    });

    expect(samba.reconcile()).toBe(false);
    fail = false;
    expect(samba.reconcile()).toBe(true);
  });
});

describe('render', () => {
  it("vetoes a share's own exclude patterns, so a TNC never sees them", () => {
    // The machines would otherwise see files the sync engine has deliberately decided
    // not to keep in step, which is worse than not showing them at all.
    addShare('werkstatt', { excludePatterns: ['*.bak', 'Thumbs.db'] });

    manager().reconcile();

    expect(written()).toMatch(/\[werkstatt][\s\S]*?veto files[\s\S]*?\*\.bak/);
  });

  it('leaves the server name to Samba when the TNC side has no hostname', () => {
    // The default: an appliance named during installation should not have that name
    // silently replaced by an empty string.
    manager().reconcile();

    expect(written()).not.toMatch(/netbios name\s*=\s*$/m);
  });

  it('marks a share read-only when failover has imposed it', () => {
    // Distinct from the operator setting it: the server became unreachable, and letting
    // a machine write into a cache that cannot be pushed back would lose the work.
    addShare('werkstatt');
    db.run("UPDATE shares SET failover_read_only = 1 WHERE name = 'werkstatt'");

    manager().reconcile();

    expect(written()).toMatch(/\[werkstatt][\s\S]*?read only\s*=\s*yes/);
  });

  it('reports failure rather than throwing when the config cannot be rendered', () => {
    // A bridge that cannot render its Samba config is still bridging files for whoever
    // can already reach it; taking the process down would turn degraded into an outage.
    const broken = new SambaConfigManager({
      db,
      config: {
        get: () => {
          throw new Error('config table is locked');
        },
        onSectionChange: () => undefined,
      } as never,
      invoke: () => ({ ok: true }),
    });

    expect(() => broken.reconcile()).not.toThrow();
    expect(broken.reconcile()).toBe(false);
  });
});

describe('TNC-side accounts', () => {
  /** The set-samba-user calls made, in order. */
  const accountCalls = (): { username: string; remove: boolean }[] =>
    invoked
      .filter((r) => r.verb === 'set-samba-user')
      .map((r) => r as { username: string; remove: boolean });

  it('creates the account a share authenticates against', () => {
    addShare('werkstatt', { tncGuestOk: false, tncUser: 'cnc', tncPassword: 'geheim' });

    manager().reconcile();

    expect(accountCalls()).toContainEqual(
      expect.objectContaining({ username: 'tnc-werkstatt', remove: false }),
    );
  });

  it('names the account in valid users, so the share actually requires it', () => {
    addShare('werkstatt', { tncGuestOk: false, tncUser: 'cnc', tncPassword: 'geheim' });

    manager().reconcile();

    expect(written()).toMatch(/\[werkstatt][\s\S]*?valid users\s*=\s*tnc-werkstatt/);
  });

  it('does not name an account on a guest share', () => {
    // `valid users` alongside `guest ok = yes` is a contradiction Samba resolves in
    // favour of the guest, which would make the account silently decorative.
    addShare('werkstatt', { tncGuestOk: true, tncUser: 'cnc', tncPassword: 'geheim' });

    manager().reconcile();

    expect(written()).toMatch(/\[werkstatt]/);
    expect(written()).not.toMatch(/valid users/);
  });

  it('does not export a share no machine could connect to', () => {
    // Guest off and no account. Exporting it means the control gets ACCESS_DENIED,
    // which reads as a password problem and sends the operator looking for credentials
    // that do not exist. Found on real hardware, where exactly this share existed.
    addShare('werkstatt', { tncGuestOk: false, tncUser: null });

    manager().reconcile();

    expect(written()).not.toContain('[werkstatt]');
  });

  it('exports the other shares even when one is unreachable', () => {
    addShare('kaputt', { tncGuestOk: false, tncUser: null });
    addShare('werkstatt', { tncGuestOk: true });

    manager().reconcile();

    expect(written()).not.toContain('[kaputt]');
    expect(written()).toContain('[werkstatt]');
  });

  it('removes the account when a share switches to guest access', () => {
    addShare('werkstatt', { tncGuestOk: true });

    manager().reconcile();

    expect(accountCalls()).toContainEqual(
      expect.objectContaining({ username: 'tnc-werkstatt', remove: true }),
    );
  });

  it('removes the account of a disabled share', () => {
    // The share is not exported, so an account that can still authenticate against the
    // appliance is a credential with nothing behind it.
    addShare('werkstatt', { enabled: false, tncGuestOk: false, tncUser: 'cnc' });

    manager().reconcile();

    expect(accountCalls()).toContainEqual(
      expect.objectContaining({ username: 'tnc-werkstatt', remove: true }),
    );
  });

  it('creates no account for a share that names a user but stored no password', () => {
    // An account nobody can log into is less use than a logged warning.
    addShare('werkstatt', { tncGuestOk: false, tncUser: 'cnc' });

    manager().reconcile();

    expect(accountCalls().filter((c) => !c.remove)).toEqual([]);
  });

  it("writes the config even when one share's account could not be set", () => {
    // A partial bridge is worth more than none, and the failure is on the record.
    addShare('werkstatt', { tncGuestOk: false, tncUser: 'cnc', tncPassword: 'geheim' });
    const samba = new SambaConfigManager({
      db,
      config,
      invoke: (request: { verb: string }) => {
        if (request.verb === 'set-samba-user') {
          throw new Error('useradd is missing');
        }
        invoked.push(request as never);
        return { ok: true, verb: request.verb, commands: [], detail: {} };
      },
    });

    expect(samba.reconcile()).toBe(true);
    expect(written()).toContain('[werkstatt]');
  });

  it('keeps the two passwords apart, since they point in opposite directions', () => {
    // One reaches the corporate server, one lets a shop-floor control in. Storing them
    // under the same label would let an envelope be moved between the columns.
    const store = new ShareStore({ db, config });
    addShare('werkstatt', { tncGuestOk: false, tncUser: 'cnc', tncPassword: 'tnc-secret' });
    const id = store.list(10, 0).items[0]!.id;

    expect(store.tncPassword(id)).toBe('tnc-secret');
    expect(store.password(id)).toBeUndefined();
  });
});

describe('restart', () => {
  it('restarts rather than reloads, because smbd reads interfaces only at startup', () => {
    manager().restart();

    expect(invoked).toEqual([{ verb: 'reload-samba', mode: 'restart' }]);
  });

  it('does not throw when the helper refuses', () => {
    const samba = manager(() => {
      throw new Error('unit not found');
    });

    expect(() => samba.restart()).not.toThrow();
  });
});
