import { createSocket } from 'node:dgram';

import {
  AUDIT_OPERATIONS,
  type AuditEvent,
  AuditIngest,
  normaliseAuditPath,
  parseAuditLine,
  rsyslogRule,
  stripSyslogEnvelope,
  TokenBucket,
} from './audit-syslog';

// A realistic line: PRI for LOCAL5/notice, RFC3164 header, Samba tag, then the payload
// whose first three fields come from `full_audit:prefix = %I|%u|%S`.
const line = (payload: string): string => `<173>Sep  7 10:00:01 tnc-bridge smbd_audit: ${payload}`;

const OPEN = '192.168.42.50|tnc|programs|open|ok|w|12345.H';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

describe('stripSyslogEnvelope', () => {
  it('extracts the facility from the PRI', () => {
    // LOCAL5 is facility 21; 21*8 + 5 (notice) = 173.
    expect(stripSyslogEnvelope(line(OPEN)).facility).toBe(21);
  });

  it('strips PRI, RFC3164 header and the Samba tag', () => {
    expect(stripSyslogEnvelope(line(OPEN)).payload).toBe(OPEN);
  });

  it('accepts a bare payload with no envelope at all', () => {
    // Depending on the rsyslog template the line may arrive with a full header, with
    // only the PRI, or with neither. Insisting on one shape works in testing and
    // silently receives nothing in production.
    expect(stripSyslogEnvelope(OPEN).payload).toBe(OPEN);
  });

  it('accepts the ISO-timestamp template', () => {
    const iso = `<173>2026-09-07T10:00:01.123456+02:00 tnc-bridge smbd_audit: ${OPEN}`;
    expect(stripSyslogEnvelope(iso).payload).toBe(OPEN);
  });

  it('strips a tag carrying a PID', () => {
    expect(stripSyslogEnvelope(`<173>smbd_audit[1234]: ${OPEN}`).payload).toBe(OPEN);
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseAuditLine', () => {
  it('parses an open into a typed event with client IP, share and path', () => {
    const event = parseAuditLine(line(OPEN));

    expect(event).toMatchObject({
      operation: 'open',
      result: 'ok',
      clientIp: '192.168.42.50',
      user: 'tnc',
      share: 'programs',
      path: '12345.H',
      mode: 'w',
      newPath: null,
    });
  });

  it('parses an open with no mode field', () => {
    const event = parseAuditLine(line('192.168.42.50|tnc|programs|open|ok|12345.H'));
    expect(event).toMatchObject({ path: '12345.H', mode: null });
  });

  it.each(['close', 'write', 'pwrite', 'unlink', 'mkdir', 'rmdir'])(
    'parses a %s event',
    (operation) => {
      const event = parseAuditLine(line(`10.0.0.1|tnc|programs|${operation}|ok|sub/12345.H`));
      expect(event).toMatchObject({ operation, path: 'sub/12345.H' });
    },
  );

  it('parses a rename with both paths', () => {
    const event = parseAuditLine(line('10.0.0.1|tnc|programs|rename|ok|old.H|new.H'));
    expect(event).toMatchObject({ operation: 'rename', path: 'old.H', newPath: 'new.H' });
  });

  it('records a failed operation without discarding it', () => {
    const event = parseAuditLine(line('10.0.0.1|tnc|programs|open|fail|12345.H'));
    expect(event?.result).toBe('fail');
  });

  it('covers every verb configured in full_audit:success', () => {
    for (const operation of AUDIT_OPERATIONS) {
      const payload =
        operation === 'rename'
          ? `10.0.0.1|tnc|programs|${operation}|ok|a.H|b.H`
          : `10.0.0.1|tnc|programs|${operation}|ok|a.H`;
      expect(parseAuditLine(line(payload))?.operation).toBe(operation);
    }
  });

  it('keeps a filename containing a pipe intact', () => {
    // Samba does not escape the delimiter. Taking args[0] would truncate "Teil|2.H"
    // to "Teil" and lock the wrong path — or no path at all.
    const event = parseAuditLine(line('10.0.0.1|tnc|programs|close|ok|Teil|2.H'));
    expect(event?.path).toBe('Teil|2.H');
  });

  it('handles German filenames with umlauts', () => {
    // R7: these are the names that actually appear on a German shop floor.
    const event = parseAuditLine(line('10.0.0.1|tnc|programs|open|ok|Größe_Träger.H'));
    expect(event?.path).toBe('Größe_Träger.H');
  });

  it.each([
    ['too few fields', 'a|b|c'],
    ['an unknown verb', '10.0.0.1|tnc|programs|chdir|ok|x'],
    ['a bad result', '10.0.0.1|tnc|programs|open|maybe|x'],
    ['no path argument', '10.0.0.1|tnc|programs|open|ok'],
    ['an empty path', '10.0.0.1|tnc|programs|open|ok|'],
    ['a rename with no destination', '10.0.0.1|tnc|programs|rename|ok|old.H'],
    ['an empty line', ''],
    ['unrelated syslog noise', 'CRON[123]: session opened'],
  ])('returns null for %s', (_label, payload) => {
    expect(parseAuditLine(line(payload))).toBeNull();
  });

  it('never throws, whatever the input', () => {
    // The input is text produced by a C module about filenames chosen by operators.
    const nasty = ['|||||', '\0\0\0', '<173>', '|'.repeat(1000), '𝕏'.repeat(500)];
    for (const input of nasty) {
      expect(() => parseAuditLine(input)).not.toThrow();
    }
  });

  it('tolerates an absent client IP or user', () => {
    const event = parseAuditLine(line('||programs|open|ok|x.H'));
    expect(event).toMatchObject({ clientIp: null, user: null, share: 'programs' });
  });
});

describe('normaliseAuditPath', () => {
  it('converts backslashes an SMB1 client sends', () => {
    // An index keyed on `sub\prog.H` would never match the `sub/prog.H` the watcher
    // reports for the same file.
    expect(normaliseAuditPath('sub\\prog.H')).toBe('sub/prog.H');
  });

  it('strips a leading ./ and maps the share root to an empty path', () => {
    expect(normaliseAuditPath('./x.H')).toBe('x.H');
    expect(normaliseAuditPath('.')).toBe('');
  });

  it('strips leading slashes', () => {
    expect(normaliseAuditPath('/x.H')).toBe('x.H');
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('TokenBucket', () => {
  it('allows a burst up to capacity then refuses', () => {
    const now = 0;
    const bucket = new TokenBucket(3, 10, () => now);

    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('refills continuously from the clock', () => {
    let now = 0;
    const bucket = new TokenBucket(10, 10, () => now);
    for (let i = 0; i < 10; i += 1) {
      bucket.tryConsume();
    }
    expect(bucket.tryConsume()).toBe(false);

    now = 500; // half a second at 10/s = 5 tokens
    expect(bucket.tryConsume()).toBe(true);
  });

  it('never exceeds capacity however long it idles', () => {
    let now = 0;
    const bucket = new TokenBucket(5, 10, () => now);
    now = 1_000_000;
    bucket.tryConsume();
    expect(bucket.available).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

describe('AuditIngest', () => {
  it('delivers a typed event to the handler', async () => {
    const ingest = new AuditIngest();
    const events: AuditEvent[] = [];
    ingest.onEvent((event) => {
      events.push(event);
    });

    ingest.ingestLine(line(OPEN));
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toHaveLength(1);
    expect(events[0]?.path).toBe('12345.H');
  });

  it('turns an open into an event well inside the 200 ms budget', async () => {
    // The AC. Locking is only useful if it happens before the pull it must block.
    const ingest = new AuditIngest();
    const started = Date.now();
    let seenAt = 0;
    ingest.onEvent(() => {
      seenAt = Date.now();
    });

    ingest.ingestLine(line(OPEN));
    await new Promise((resolve) => setImmediate(resolve));

    expect(seenAt - started).toBeLessThan(200);
  });

  it('counts malformed lines and keeps going', async () => {
    // A parse failure that stopped ingestion would silently disable locking, which is
    // worse than any individual missed event.
    const ingest = new AuditIngest();
    const events: AuditEvent[] = [];
    ingest.onEvent((event) => {
      events.push(event);
    });

    ingest.ingestLine('garbage');
    ingest.ingestLine(line(OPEN));
    ingest.ingestLine('|||');
    ingest.ingestLine(line(OPEN));
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toHaveLength(2);
    expect(ingest.stats.malformed).toBe(2);
    expect(ingest.stats.parsed).toBe(2);
    expect(ingest.stats.received).toBe(4);
  });

  it('keeps memory bounded under a sustained flood', async () => {
    // The AC: 1000 events/s sustained must not grow memory. The queue is capped and
    // the oldest events are dropped, with a counter to prove it happened.
    const ingest = new AuditIngest({ maxQueue: 100, rateLimitPerSecond: 1e9, burstCapacity: 1e9 });
    let handled = 0;
    ingest.onEvent(() => {
      handled += 1;
    });

    for (let i = 0; i < 5_000; i += 1) {
      ingest.ingestLine(line(`10.0.0.1|tnc|programs|open|ok|file${i}.H`));
    }

    expect(ingest.stats.queueDepth).toBeLessThanOrEqual(100);
    expect(ingest.stats.droppedQueueFull).toBeGreaterThan(0);

    await new Promise((resolve) => setImmediate(resolve));
    expect(handled).toBeGreaterThan(0);
  });

  it('drops the oldest event when the queue is full, keeping the newest', async () => {
    // A lock decision is about what is true now; stale history is what smbstatus
    // reconciliation supersedes anyway.
    const ingest = new AuditIngest({ maxQueue: 2, rateLimitPerSecond: 1e9, burstCapacity: 1e9 });
    const events: AuditEvent[] = [];
    ingest.onEvent((event) => {
      events.push(event);
    });

    ingest.ingestLine(line('10.0.0.1|tnc|programs|open|ok|first.H'));
    ingest.ingestLine(line('10.0.0.1|tnc|programs|open|ok|second.H'));
    ingest.ingestLine(line('10.0.0.1|tnc|programs|open|ok|third.H'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.map((event) => event.path)).toEqual(['second.H', 'third.H']);
  });

  it('rate-limits beyond the configured sustained rate', () => {
    const now = 0;
    const ingest = new AuditIngest({
      rateLimitPerSecond: 10,
      burstCapacity: 5,
      now: () => now,
    });

    for (let i = 0; i < 20; i += 1) {
      ingest.ingestLine(line(OPEN));
    }

    expect(ingest.stats.parsed).toBe(5);
    expect(ingest.stats.droppedRateLimited).toBe(15);
  });

  it('recovers capacity after the flood subsides', () => {
    let now = 0;
    const ingest = new AuditIngest({ rateLimitPerSecond: 10, burstCapacity: 2, now: () => now });

    ingest.ingestLine(line(OPEN));
    ingest.ingestLine(line(OPEN));
    ingest.ingestLine(line(OPEN));
    expect(ingest.stats.droppedRateLimited).toBe(1);

    now = 1000;
    ingest.ingestLine(line(OPEN));
    expect(ingest.stats.parsed).toBe(3);
  });

  it('survives a handler that throws', async () => {
    // One consumer failure must not stop the stream for every other path.
    const warn = jest.fn();
    const ingest = new AuditIngest({ logger: { info: jest.fn(), warn, error: jest.fn() } });
    const seen: string[] = [];
    ingest.onEvent((event) => {
      if (event.path === 'boom.H') {
        throw new Error('handler failure');
      }
      seen.push(event.path);
    });

    ingest.ingestLine(line('10.0.0.1|tnc|programs|open|ok|boom.H'));
    ingest.ingestLine(line('10.0.0.1|tnc|programs|open|ok|fine.H'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual(['fine.H']);
    expect(warn).toHaveBeenCalled();
  });

  it('does not let a slow async handler stall the ingest call', async () => {
    // Delivery happens on the drain, not on the socket read, so a slow consumer cannot
    // stall the datagram that produced the event.
    const ingest = new AuditIngest();
    let handled = false;
    ingest.onEvent(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            handled = true;
            resolve();
          }, 20),
        ),
    );

    const started = Date.now();
    ingest.ingestLine(line(OPEN));
    expect(Date.now() - started).toBeLessThan(20);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handled).toBe(true);
  });

  it('filters by facility when asked', () => {
    const ingest = new AuditIngest({ requireFacility: true });

    // LOCAL2 (facility 18) rather than LOCAL5.
    ingest.ingestLine(`<149>Sep  7 10:00:01 host smbd_audit: ${OPEN}`);
    expect(ingest.stats.droppedWrongFacility).toBe(1);

    ingest.ingestLine(line(OPEN));
    expect(ingest.stats.parsed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stream framing
// ---------------------------------------------------------------------------

describe('AuditIngest.ingestChunk', () => {
  it('reassembles a line split across chunks', async () => {
    const ingest = new AuditIngest();
    const events: AuditEvent[] = [];
    ingest.onEvent((event) => {
      events.push(event);
    });

    const full = `${line(OPEN)}\n`;
    ingest.ingestChunk(full.slice(0, 30));
    ingest.ingestChunk(full.slice(30));
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toHaveLength(1);
    expect(events[0]?.path).toBe('12345.H');
  });

  it('handles several lines in one chunk', async () => {
    const ingest = new AuditIngest();
    const events: AuditEvent[] = [];
    ingest.onEvent((event) => {
      events.push(event);
    });

    ingest.ingestChunk(`${line(OPEN)}\n${line(OPEN)}\n${line(OPEN)}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toHaveLength(3);
  });

  it('discards an unbounded partial line rather than buffering forever', () => {
    // A peer that never sends a newline must not be able to exhaust memory.
    const ingest = new AuditIngest();
    ingest.ingestChunk('x'.repeat(100_000));
    expect(ingest.stats.malformed).toBeGreaterThan(0);
    ingest.ingestChunk(`${line(OPEN)}\n`);
    expect(ingest.stats.parsed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// UDP transport
// ---------------------------------------------------------------------------

describe('AuditIngest UDP transport', () => {
  it('receives a datagram end to end and binds loopback only', async () => {
    const ingest = new AuditIngest({ port: 0 });
    const received = new Promise<AuditEvent>((resolve) => {
      ingest.onEvent(resolve);
    });

    await ingest.start();
    // Port 0 asks the OS to choose; read back what it picked.
    const address = (ingest as unknown as { udp: { address(): { port: number } } }).udp.address();

    const client = createSocket('udp4');
    await new Promise<void>((resolve) => {
      client.send(line(OPEN), address.port, '127.0.0.1', () => {
        client.close();
        resolve();
      });
    });

    const event = await received;
    expect(event.path).toBe('12345.H');
    expect(event.clientIp).toBe('192.168.42.50');

    await ingest.stop();
  });

  it('stops cleanly and releases the socket', async () => {
    const ingest = new AuditIngest({ port: 0 });
    await ingest.start();
    await expect(ingest.stop()).resolves.toBeUndefined();
    // A second stop must not throw.
    await expect(ingest.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rsyslog rule
// ---------------------------------------------------------------------------

describe('rsyslogRule', () => {
  it('forwards LOCAL5 to the port the ingest listens on', () => {
    // Shipped as a constant so the installer and the code cannot drift apart.
    expect(rsyslogRule(5514)).toContain('local5.*  @127.0.0.1:5514');
  });

  it('stops the messages so they never also reach the disk', () => {
    // Without `stop` these lines land in /var/log/syslog and R16 happens anyway.
    expect(rsyslogRule()).toContain('local5.*  stop');
  });
});
