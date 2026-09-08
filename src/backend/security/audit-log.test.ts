import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { AuditLog, installAuditGuards } from './audit-log';

const NOW = 1_700_000_000;

let db: Db;
let audit: AuditLog;
let clock: number;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  installAuditGuards(db);
  clock = NOW;
  audit = new AuditLog(db, undefined, () => clock);
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('recording', () => {
  it('appends an entry with its defaults', () => {
    audit.record({ actor: 'admin', action: 'config.update', target: 'sync' });

    const { items, total } = audit.query();
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      actor: 'admin',
      action: 'config.update',
      target: 'sync',
      result: 'ok',
      ts: NOW,
    });
  });

  it('records a denial distinctly', () => {
    audit.recordDenied({ actor: 'admin', action: 'config.update', detail: 'rate limited' });

    expect(audit.query().items[0]?.result).toBe('denied');
  });

  it('never throws, even when the write fails', () => {
    db.close();
    // An operator locked out of their own bridge because the audit table is unavailable
    // is a worse outcome than a missing line.
    expect(() => audit.record({ actor: 'admin', action: 'config.update' })).not.toThrow();
  });
});

describe('append-only enforcement', () => {
  it('refuses an UPDATE at the database level', () => {
    audit.record({ actor: 'admin', action: 'config.update' });

    // Enforced by trigger, so even a direct sqlite3 session cannot rewrite history.
    expect(() => db.run("UPDATE audit_log SET actor = 'someone else'")).toThrow(/append-only/);
  });

  it('refuses a DELETE at the database level', () => {
    audit.record({ actor: 'admin', action: 'config.update' });

    expect(() => db.run('DELETE FROM audit_log')).toThrow(/append-only/);
  });

  it('installs its guards idempotently', () => {
    expect(() => {
      installAuditGuards(db);
      installAuditGuards(db);
    }).not.toThrow();
  });

  it('still refuses writes after the guards are re-asserted', () => {
    installAuditGuards(db);
    audit.record({ actor: 'admin', action: 'x' });
    expect(() => db.run('DELETE FROM audit_log')).toThrow(/append-only/);
  });
});

describe('query', () => {
  beforeEach(() => {
    audit.record({ actor: 'admin', action: 'config.update', target: 'sync' });
    clock += 10;
    audit.record({ actor: 'admin', action: 'config.testSmb' });
    clock += 10;
    audit.record({ actor: 'token:prtg', action: 'version.restore', target: '1:P.H' });
  });

  it('returns newest first', () => {
    expect(audit.query().items.map((e) => e.action)).toEqual([
      'version.restore',
      'config.testSmb',
      'config.update',
    ]);
  });

  it('filters by exact action', () => {
    expect(audit.query({ action: 'version.restore' }).total).toBe(1);
  });

  it('filters by action prefix, so "config" finds every config verb', () => {
    expect(audit.query({ action: 'config' }).total).toBe(2);
  });

  it('filters by actor', () => {
    expect(audit.query({ actor: 'token:prtg' }).total).toBe(1);
  });

  it('filters by time range', () => {
    expect(audit.query({ since: NOW + 5 }).total).toBe(2);
    expect(audit.query({ until: NOW + 5 }).total).toBe(1);
  });

  it('paginates while reporting the unpaginated total', () => {
    const page = audit.query({ limit: 2, offset: 1 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });
});

describe('stream', () => {
  it('yields every matching entry', () => {
    for (let i = 0; i < 25; i += 1) {
      clock += 1;
      audit.record({ actor: 'admin', action: 'config.update' });
    }

    expect([...audit.stream({ action: 'config.update' })]).toHaveLength(25);
  });

  it('yields nothing when there is nothing to yield', () => {
    expect([...audit.stream()]).toHaveLength(0);
  });
});

describe('truncateBefore', () => {
  it('records the truncation before performing it, so the trim is itself visible', () => {
    audit.record({ actor: 'admin', action: 'old.thing' });
    clock += 86_400 * 400;
    audit.record({ actor: 'admin', action: 'recent.thing' });

    const removed = audit.truncateBefore(clock - 86_400, 'admin');

    expect(removed).toBe(1);
    const actions = audit.query().items.map((e) => e.action);
    expect(actions).toContain('recent.thing');
    // The record that history was trimmed survives the trim.
    expect(actions).toContain('audit.truncate');
    expect(actions).not.toContain('old.thing');
  });

  it('does nothing, and writes nothing, when there is nothing old enough', () => {
    audit.record({ actor: 'admin', action: 'recent' });

    expect(audit.truncateBefore(NOW - 86_400, 'admin')).toBe(0);
    expect(audit.query().total).toBe(1);
  });

  it('restores the delete guard afterwards', () => {
    audit.record({ actor: 'admin', action: 'old' });
    clock += 86_400 * 400;
    audit.truncateBefore(clock - 86_400, 'admin');

    // The guard must be back, or the next bug silently erases the trail.
    expect(() => db.run('DELETE FROM audit_log')).toThrow(/append-only/);
  });
});
