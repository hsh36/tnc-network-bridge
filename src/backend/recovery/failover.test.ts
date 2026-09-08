import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { runMigrations } from '../config/migrations/runner';
import { AuditLog, installAuditGuards } from '../security/audit-log';
import { FailoverController, type FailoverState, type HealthInput } from './failover';

const NOW = 1_700_000_000;

let clock: number;
let controller: FailoverController;

const healthy: HealthInput = { serverReachable: true, diskUsedPct: 40, syncHealthy: true };

const make = (over: Partial<ConstructorParameters<typeof FailoverController>[0]> = {}) =>
  new FailoverController({
    serverGraceS: 300,
    diskFullPct: 95,
    recoveryStabilityS: 60,
    now: () => clock,
    ...over,
  });

beforeEach(() => {
  clock = NOW;
  controller = make();
});

describe('healthy operation', () => {
  it('starts healthy and writable', () => {
    const status = controller.observe(healthy);

    expect(status.state).toBe('healthy');
    expect(status.readOnly).toBe(false);
    expect(status.reasons).toEqual([]);
  });

  it('stays healthy across many observations', () => {
    for (let i = 0; i < 10; i += 1) {
      clock += 30;
      expect(controller.observe(healthy).readOnly).toBe(false);
    }
  });
});

describe('server unreachable', () => {
  it('tolerates a brief outage without failing over', () => {
    controller.observe(healthy);

    clock += 60;
    const status = controller.observe({ ...healthy, serverReachable: false });

    // A switch reboot or DHCP renewal must not disturb a running job.
    expect(status.readOnly).toBe(false);
    expect(status.state).toBe('degraded');
  });

  it('reports degraded while inside the grace period', () => {
    controller.observe({ ...healthy, serverReachable: false });
    clock += 100;

    // Surfacing this separately is what lets the dashboard warn before anything breaks.
    expect(controller.observe({ ...healthy, serverReachable: false }).state).toBe('degraded');
  });

  it('fails over once the grace period elapses', () => {
    controller.observe({ ...healthy, serverReachable: false });

    clock += 301;
    const status = controller.observe({ ...healthy, serverReachable: false });

    expect(status.readOnly).toBe(true);
    expect(status.state).toBe('read_only');
    expect(status.reasons).toEqual(['server_unreachable']);
  });

  it('restarts the grace period after a recovery', () => {
    controller.observe({ ...healthy, serverReachable: false });
    clock += 200;
    controller.observe(healthy);

    clock += 200;
    // 200s down, back up, 200s down again — never 300 consecutive seconds.
    expect(controller.observe({ ...healthy, serverReachable: false }).readOnly).toBe(false);
  });
});

describe('recovery hysteresis', () => {
  const failOver = (): void => {
    controller.observe({ ...healthy, serverReachable: false });
    clock += 301;
    controller.observe({ ...healthy, serverReachable: false });
  };

  it('does not resume writes on the first successful probe', () => {
    failOver();

    clock += 5;
    const status = controller.observe(healthy);

    // Resuming immediately would flap: a server up for ten seconds a minute would
    // toggle the read-only flag repeatedly, and every toggle is an smbd reload.
    expect(status.readOnly).toBe(true);
  });

  it('resumes once the link has been consistently healthy', () => {
    failOver();

    clock += 30;
    expect(controller.observe(healthy).readOnly).toBe(true);
    clock += 31;
    expect(controller.observe(healthy).readOnly).toBe(false);
  });

  it('restarts the stabilisation window if the link drops again', () => {
    failOver();

    clock += 40;
    controller.observe(healthy);
    clock += 5;
    controller.observe({ ...healthy, serverReachable: false });
    clock += 40;

    // 40s healthy, a blip, 40s healthy — never 60 consecutive.
    expect(controller.observe(healthy).readOnly).toBe(true);
  });
});

describe('disk full', () => {
  it('fails over immediately at the threshold', () => {
    // No grace: past this there is not room to complete a transfer, and a partially
    // written file is worse than a refused write.
    const status = controller.observe({ ...healthy, diskUsedPct: 95 });

    expect(status.readOnly).toBe(true);
    expect(status.reasons).toEqual(['disk_full']);
  });

  it('stays writable below the threshold', () => {
    expect(controller.observe({ ...healthy, diskUsedPct: 94 }).readOnly).toBe(false);
  });

  it('applies hysteresis when clearing', () => {
    controller.observe({ ...healthy, diskUsedPct: 96 });

    // Clearing at exactly the threshold would let a cache hovering on the line toggle
    // on every sample.
    expect(controller.observe({ ...healthy, diskUsedPct: 93 }).readOnly).toBe(true);
    expect(controller.observe({ ...healthy, diskUsedPct: 89 }).readOnly).toBe(false);
  });
});

describe('sync errors', () => {
  it('fails over when the sync loop is unhealthy', () => {
    const status = controller.observe({ ...healthy, syncHealthy: false });

    // If the engine cannot reason about state, it must not act on it.
    expect(status.readOnly).toBe(true);
    expect(status.reasons).toEqual(['sync_error']);
  });

  it('clears as soon as the loop recovers', () => {
    controller.observe({ ...healthy, syncHealthy: false });
    expect(controller.observe(healthy).readOnly).toBe(false);
  });
});

describe('independent latches', () => {
  it('keeps read-only while any one reason remains', () => {
    controller.observe({ serverReachable: false, diskUsedPct: 96, syncHealthy: true });
    clock += 301;
    const both = controller.observe({
      serverReachable: false,
      diskUsedPct: 96,
      syncHealthy: true,
    });
    expect(both.reasons).toEqual(['disk_full', 'server_unreachable']);

    // The disk empties, but the server is still gone.
    clock += 10;
    const status = controller.observe({
      serverReachable: false,
      diskUsedPct: 20,
      syncHealthy: true,
    });

    expect(status.readOnly).toBe(true);
    expect(status.reasons).toEqual(['server_unreachable']);
  });
});

describe('manual control', () => {
  it('forces read-only on hold', () => {
    const status = controller.hold();

    expect(status.readOnly).toBe(true);
    expect(status.reasons).toEqual(['manual']);
  });

  it('survives a healthy observation', () => {
    controller.hold();
    expect(controller.observe(healthy).readOnly).toBe(true);
  });

  it('lifts on resume', () => {
    controller.hold();
    controller.resume();
    expect(controller.observe(healthy).readOnly).toBe(false);
  });

  it('resume does not override an automatic reason', () => {
    controller.observe({ ...healthy, syncHealthy: false });
    controller.hold();

    const status = controller.resume();

    // An operator saying "resume" while the server is unreachable is asking for
    // something that would lose their colleagues' work.
    expect(status.readOnly).toBe(true);
    expect(status.reasons).toEqual(['sync_error']);
  });

  it('reset clears everything for recovery mode', () => {
    controller.observe({ serverReachable: false, diskUsedPct: 99, syncHealthy: false });
    clock += 301;
    controller.observe({ serverReachable: false, diskUsedPct: 99, syncHealthy: false });

    const status = controller.reset();

    expect(status.readOnly).toBe(false);
    expect(status.reasons).toEqual([]);
  });
});

describe('change notification', () => {
  it('fires only when the effective state changes', () => {
    const seen: FailoverState[] = [];
    const watched = make({ onChange: (state) => seen.push(state) });

    watched.observe(healthy);
    watched.observe(healthy);
    watched.observe({ ...healthy, syncHealthy: false });
    watched.observe({ ...healthy, syncHealthy: false });
    watched.observe(healthy);

    // Two transitions, not five observations — every notification is an smbd reload.
    expect(seen).toEqual(['read_only', 'healthy']);
  });

  it('reports the reasons alongside the state', () => {
    const seen: string[][] = [];
    const watched = make({ onChange: (_s, reasons) => seen.push([...reasons]) });

    watched.observe({ ...healthy, diskUsedPct: 99 });

    expect(seen[0]).toEqual(['disk_full']);
  });
});

describe('auditing', () => {
  it('records each state change', () => {
    const db = tmpDb();
    runMigrations(db);
    installAuditGuards(db);
    const audit = new AuditLog(db, undefined, () => clock);
    const audited = make({ audit });

    audited.observe(healthy);
    audited.observe({ ...healthy, syncHealthy: false });

    const entries = audit.query({ action: 'failover' });
    expect(entries.total).toBeGreaterThan(0);
    expect(entries.items[0]?.detail).toContain('read_only');

    cleanupTmpDbs();
  });
});
