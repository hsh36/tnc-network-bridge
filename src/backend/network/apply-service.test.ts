import { type NetworkInterfaceInfo } from 'node:os';

import { type InterfaceDiscovery } from '../../shared';
import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { PrivilegedCallError } from '../privileged/client';
import { type HelperResponse } from '../privileged/main';
import { type PrivilegedRequest } from '../privileged/verbs';

import { NetworkApplyError, NetworkApplyService } from './apply-service';

/**
 * The decision under test is one thing: does this change risk the connection it was
 * requested over, and therefore need a rollback timer?
 *
 * Getting it wrong in one direction costs a confirmation click. In the other it costs a
 * drive to the machine hall, so the service is expected to guess "risky" whenever it
 * cannot tell.
 */

const NICS: InterfaceDiscovery[] = [
  {
    mac: 'aa:bb:cc:dd:ee:00',
    name: 'eth0',
    state: 'up',
    speedMbps: 1000,
    driver: 'x',
    hasAddress: true,
  },
  {
    mac: 'aa:bb:cc:dd:ee:01',
    name: 'eth1',
    state: 'up',
    speedMbps: 100,
    driver: 'y',
    hasAddress: true,
  },
];

const ADDRESSES: Record<string, string[]> = { eth0: ['10.0.0.5'], eth1: ['192.168.42.1'] };

function fakeRead(): NodeJS.Dict<NetworkInterfaceInfo[]> {
  return Object.fromEntries(
    Object.entries(ADDRESSES).map(([name, addresses]) => [
      name,
      addresses.map<NetworkInterfaceInfo>((address) => ({
        address,
        family: 'IPv4',
        internal: false,
        mac: '00:00:00:00:00:00',
        netmask: '255.255.255.0',
        cidr: `${address}/24`,
      })),
    ]),
  );
}

let db: Db;
let config: ConfigManager;
let calls: PrivilegedRequest[];

function service(options: { fail?: string } = {}): NetworkApplyService {
  return new NetworkApplyService({
    db,
    config,
    discover: () => NICS,
    read: fakeRead,
    now: () => 1_700_000_000,
    invoke: (request): HelperResponse => {
      calls.push(request);
      if (options.fail !== undefined) {
        // How the real client signals a refusal. It never returns `ok: false` — a stub
        // that did let a wrong assumption pass the suite and reach the appliance, where
        // a failed apply surfaced as a 500 with no message.
        throw new PrivilegedCallError(options.fail, 'failed', 3);
      }
      return { ok: true, verb: request.verb };
    },
  });
}

function lastApply(): Extract<PrivilegedRequest, { verb: 'apply-network' }> {
  const call = calls.at(-1);
  if (call?.verb !== 'apply-network') {
    throw new Error('expected an apply-network call');
  }
  return call;
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  calls = [];
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  config.set('network', {
    lan: { interface: 'eth0', method: 'static', address: '10.0.0.5/24', gateway: '10.0.0.1' },
    tnc: { interface: 'eth1', method: 'static', address: '192.168.42.1/24' },
    applyRevertSeconds: 300,
  });
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('apply', () => {
  it('arms a rollback when the change touches the interface the request came in on', () => {
    const result = service().apply('lan', '10.0.0.5');

    expect(result.status).toBe('pending_confirmation');
    expect(lastApply().revertAfterSeconds).toBe(300);
    expect(result.expiresAt).toBe(1_700_000_000 + 300);
  });

  it('applies outright when the change cannot touch this connection', () => {
    // The operator is on the LAN and is changing the machine segment. Making them
    // confirm would be theatre — nothing they are using is at risk.
    const result = service().apply('tnc', '10.0.0.5');

    expect(result.status).toBe('applied');
    expect(lastApply().revertAfterSeconds).toBe(0);
    expect(result.expiresAt).toBeNull();
  });

  it('arms a rollback for the TNC side when the request came in over it', () => {
    // The rule is about the caller's own path, not about which side is "safe": someone
    // managing the bridge from the machine segment can lock themselves out just as well.
    expect(service().apply('tnc', '192.168.42.1').status).toBe('pending_confirmation');
  });

  it('treats an unknown local address as risky', () => {
    expect(service().apply('lan', '203.0.113.9').status).toBe('pending_confirmation');
  });

  it('treats a missing local address as risky', () => {
    expect(service().apply('lan', undefined).status).toBe('pending_confirmation');
  });

  it('does not arm a rollback for a request over loopback', () => {
    // A local curl survives any change to a physical NIC.
    expect(service().apply('lan', '127.0.0.1').status).toBe('applied');
  });

  it('passes the VLAN tag through, so a tagged side is actually tagged', () => {
    config.set('network', {
      lan: {
        interface: 'eth0',
        method: 'static',
        address: '10.0.0.5/24',
        gateway: '10.0.0.1',
        vlan: 10,
      },
      tnc: { interface: 'eth1', method: 'static', address: '192.168.42.1/24', vlan: 20 },
    });

    service().apply('tnc', '10.0.0.5');

    expect(lastApply().vlan).toBe(20);
  });

  it('refuses a configuration that would not work, without calling the helper', () => {
    config.set('network', {
      lan: { interface: 'eth0', method: 'static', address: '10.0.0.5/24', gateway: '10.9.9.1' },
      tnc: { interface: 'eth1', method: 'static', address: '192.168.42.1/24' },
    });

    expect(() => service().apply('lan', '10.0.0.5')).toThrow(NetworkApplyError);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a helper failure rather than reporting success', () => {
    expect(() => service({ fail: 'nmcli exited 1' }).apply('tnc', '10.0.0.5')).toThrow(
      /nmcli exited 1/,
    );
  });

  it('offers the address the interface should answer on next', () => {
    expect(service().apply('lan', '10.0.0.5').expectedUrl).toBe('https://10.0.0.5/');
  });

  it('offers no URL for DHCP, rather than guessing one', () => {
    config.set('network', {
      lan: { interface: 'eth0', method: 'dhcp' },
      tnc: { interface: 'eth1', method: 'static', address: '192.168.42.1/24' },
    });

    // Sending the operator to the wrong address at the moment they cannot look one up
    // is worse than sending them nowhere.
    expect(service().apply('lan', '10.0.0.5').expectedUrl).toBeNull();
  });
});

describe('pending', () => {
  it('records the change so it can be found from a new session on the new address', () => {
    service().apply('lan', '10.0.0.5');

    const [entry] = service().pending();
    expect(entry?.change.mac).toBe('aa:bb:cc:dd:ee:00');
    expect(entry?.secondsRemaining).toBe(300);
  });

  it('is empty after a change that was never at risk', () => {
    service().apply('tnc', '10.0.0.5');
    expect(service().pending()).toEqual([]);
  });

  it('never reports a negative countdown once the window has passed', () => {
    service().apply('lan', '10.0.0.5');
    const later = new NetworkApplyService({
      db,
      config,
      discover: () => NICS,
      read: fakeRead,
      now: () => 1_700_000_000 + 9999,
      invoke: () => ({ ok: true, verb: 'apply-network' }),
    });
    expect(later.pending()[0]?.secondsRemaining).toBe(0);
  });
});

describe('confirm', () => {
  it('re-applies with no timer, which is how the helper stops the revert unit', () => {
    const svc = service();
    svc.apply('lan', '10.0.0.5');

    svc.confirm('lan');

    expect(lastApply().revertAfterSeconds).toBe(0);
    expect(svc.pending()).toEqual([]);
  });

  it('leaves the pending record in place if the helper refuses', () => {
    service().apply('lan', '10.0.0.5');

    expect(() => service({ fail: 'still down' }).confirm('lan')).toThrow(NetworkApplyError);

    // The timer is still running; forgetting the record here would hide the countdown
    // from the operator who most needs to see it.
    expect(service().pending()).toHaveLength(1);
  });
});
