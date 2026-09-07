import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createServer, type Server as NetServer, type Socket as NetSocket } from 'node:net';

/**
 * `full_audit` event ingestion (T14).
 *
 * Samba's `full_audit` VFS module reports every file operation a TNC performs. That
 * stream is what tells the lock manager a control has opened a program *while it is
 * happening* — the difference between deferring a pull and overwriting a file a machine
 * is actively running.
 *
 * **A dedicated socket, not a file tail.** R16: `full_audit` on a busy share can produce
 * a great deal of output, and tailing a file means the same bytes are written to disk,
 * read back, and then rotated underneath the reader — with a gap every time rotation
 * happens. Instead rsyslog is configured to forward LOCAL5 to a socket this process
 * owns, and to discard afterwards, so the events never touch the disk at all:
 *
 * ```
 * local5.*  @127.0.0.1:5514
 * local5.*  stop
 * ```
 *
 * Three properties this module must have, because it sits on the path of every file
 * operation on the shop floor:
 *
 *  1. **It never crashes on input.** The input is text produced by a C module about
 *     filenames chosen by machine operators. Malformed lines are counted and dropped.
 *     A parse failure that took down ingestion would silently disable locking, which is
 *     worse than any individual missed event.
 *  2. **Its memory is bounded.** A bounded queue with an explicit drop policy, not an
 *     array that grows until the process dies. Under a burst the right behaviour is to
 *     lose events and say so; `smbstatus` reconciliation (T13) repairs the gap.
 *  3. **It is fast on the happy path.** Parsing is a `split`, delivery is a
 *     `setImmediate` drain. An open must become a typed event in well under 200 ms.
 */

// ---------------------------------------------------------------------------
// Event model
// ---------------------------------------------------------------------------

/** The eight verbs configured in `full_audit:success` (T12). */
export const AUDIT_OPERATIONS = [
  'open',
  'close',
  'write',
  'pwrite',
  'rename',
  'unlink',
  'mkdir',
  'rmdir',
] as const;

export type AuditOperation = (typeof AUDIT_OPERATIONS)[number];

const OPERATION_SET = new Set<string>(AUDIT_OPERATIONS);

export interface AuditEvent {
  /** When this process received the line, in epoch milliseconds. */
  readonly ts: number;
  readonly operation: AuditOperation;
  readonly result: 'ok' | 'fail';
  /** The TNC's IP, from the `%I` prefix. This is how a lock is attributed to a machine. */
  readonly clientIp: string | null;
  /** The SMB user, from `%u`. Usually the guest account on a TNC network. */
  readonly user: string | null;
  /** The share (Samba section) name, from `%S`. */
  readonly share: string | null;
  /** Share-relative path the operation touched. */
  readonly path: string;
  /** For `rename`, the destination. `null` for every other operation. */
  readonly newPath: string | null;
  /** Open mode when Samba reported one (`r`, `w`, `rw`). */
  readonly mode: string | null;
}

/** Syslog facility 21. `full_audit:facility = LOCAL5` in the generated smb.conf. */
export const LOCAL5_FACILITY = 21;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Strips the syslog envelope, returning the audit payload and the facility.
 *
 * Handles the bare payload too. Depending on how rsyslog is templated the line may
 * arrive with a full RFC3164 header, with only the `<PRI>`, or with neither — and a
 * parser that insisted on one shape would work in testing and silently receive nothing
 * in production.
 */
export function stripSyslogEnvelope(line: string): {
  payload: string;
  facility: number | null;
} {
  let rest = line.trim();
  let facility: number | null = null;

  const priMatch = /^<(\d{1,3})>/.exec(rest);
  if (priMatch !== null) {
    const pri = Number(priMatch[1]);
    facility = Math.floor(pri / 8);
    rest = rest.slice(priMatch[0].length);
  }

  // RFC3164 timestamp + hostname, e.g. "Sep  7 10:00:01 tnc-bridge ".
  rest = rest.replace(/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+/, '');
  // ISO timestamp variant emitted by rsyslog's RSYSLOG_SyslogProtocol23Format.
  rest = rest.replace(/^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?\s+\S+\s+/, '');
  // The program tag Samba writes, with or without a PID.
  rest = rest.replace(/^smbd_audit(?:\[\d+])?:\s*/, '');
  rest = rest.replace(/^smbd(?:\[\d+])?:\s*smbd_audit:\s*/, '');

  return { payload: rest.trim(), facility };
}

export class AuditParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditParseError';
  }
}

/**
 * Parses one `full_audit` line into a typed event, or returns `null` if it is not one.
 *
 * The wire format is `%I|%u|%S|operation|result|args…` — the first three fields come
 * from `full_audit:prefix`, which T12 pins to `%I|%u|%S`.
 *
 * **Filenames may contain `|`.** Samba does not escape the delimiter, so any operation
 * carrying a single path re-joins its trailing fields rather than taking `args[0]` and
 * truncating `Teil|2.H` to `Teil`. `rename` carries two paths and is genuinely ambiguous
 * in that case; it takes the first field as the source and joins the rest, which is
 * correct unless the *source* name contains a pipe. That residue is documented rather
 * than pretended away — the alternative would be to ask Samba for an escaping mode it
 * does not have.
 */
export function parseAuditLine(line: string): AuditEvent | null {
  const { payload } = stripSyslogEnvelope(line);
  if (payload === '') {
    return null;
  }

  const fields = payload.split('|');
  if (fields.length < 5) {
    return null;
  }

  const [clientIp = '', user = '', share = '', operation = '', result = '', ...args] = fields;

  if (!OPERATION_SET.has(operation)) {
    // A verb we did not subscribe to, or a line that is not an audit record at all.
    // Not an error: rsyslog may forward more than we asked for.
    return null;
  }
  if (result !== 'ok' && result !== 'fail') {
    return null;
  }
  if (args.length === 0) {
    return null;
  }

  let path: string;
  let newPath: string | null = null;
  let mode: string | null = null;

  if (operation === 'rename') {
    path = args[0] ?? '';
    newPath = args.slice(1).join('|');
    if (newPath === '') {
      return null;
    }
  } else if (operation === 'open' && args.length > 1 && /^[rw]{1,2}$/.test(args[0] ?? '')) {
    mode = args[0] ?? null;
    path = args.slice(1).join('|');
  } else {
    path = args.join('|');
  }

  if (path === '') {
    return null;
  }

  return {
    ts: Date.now(),
    operation: operation as AuditOperation,
    result,
    clientIp: clientIp === '' ? null : clientIp,
    user: user === '' ? null : user,
    share: share === '' ? null : share,
    path: normaliseAuditPath(path),
    newPath: newPath === null ? null : normaliseAuditPath(newPath),
    mode,
  };
}

/**
 * Normalises a path as reported by Samba to the form the file index uses.
 *
 * Samba reports share-relative paths, but emits `.` for the share root and may prefix
 * `./`. Backslashes are converted because an SMB1 client sends them and some Samba
 * versions pass them through unchanged — an index keyed on `sub\prog.H` would never
 * match the `sub/prog.H` the watcher reports for the same file.
 */
export function normaliseAuditPath(path: string): string {
  const converted = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return converted === '.' ? '' : converted.replace(/^\/+/, '');
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Token bucket, refilled continuously from the clock.
 *
 * The backstop for R16. A runaway process on a control — or a genuine bulk import —
 * can produce audit lines far faster than they carry information, and the useful
 * response is to drop the excess and record that it happened, not to let a queue grow
 * until the service dies.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  tryConsume(count = 1): boolean {
    const timestamp = this.now();
    const elapsedSeconds = Math.max(0, timestamp - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = timestamp;

    if (this.tokens < count) {
      return false;
    }
    this.tokens -= count;
    return true;
  }

  get available(): number {
    return this.tokens;
  }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export interface AuditStats {
  readonly received: number;
  readonly parsed: number;
  readonly malformed: number;
  /** Dropped because the queue was full. */
  readonly droppedQueueFull: number;
  /** Dropped by the rate limiter. */
  readonly droppedRateLimited: number;
  /** Dropped because the facility was not LOCAL5. */
  readonly droppedWrongFacility: number;
  readonly queueDepth: number;
}

export type AuditHandler = (event: AuditEvent) => void | Promise<void>;

export interface AuditIngestOptions {
  /** UDP port on loopback that rsyslog forwards LOCAL5 to. */
  readonly port?: number;
  readonly host?: string;
  /** Unix stream socket path, as an alternative to UDP. */
  readonly socketPath?: string;
  /** Maximum queued events before the oldest are dropped. */
  readonly maxQueue?: number;
  /** Sustained events per second before the limiter starts dropping. */
  readonly rateLimitPerSecond?: number;
  readonly burstCapacity?: number;
  /** Enforce that lines arrived on LOCAL5. Off when the transport strips the PRI. */
  readonly requireFacility?: boolean;
  readonly now?: () => number;
  readonly logger?: {
    info(object: Record<string, unknown>, message: string): void;
    warn(object: Record<string, unknown>, message: string): void;
    error(object: Record<string, unknown>, message: string): void;
  };
}

export const DEFAULT_AUDIT_PORT = 5514;

/**
 * Receives audit lines and delivers typed events.
 *
 * Transport-agnostic at its core: {@link ingestLine} is the whole parser and can be
 * driven directly by a test or by any transport. UDP and Unix-stream listeners are thin
 * wrappers over it, which is what keeps the difficult logic testable without a socket.
 */
export class AuditIngest extends EventEmitter {
  private readonly queue: AuditEvent[] = [];
  private readonly maxQueue: number;
  private readonly bucket: TokenBucket;
  private readonly requireFacility: boolean;
  private readonly now: () => number;
  private readonly log: AuditIngestOptions['logger'];
  private readonly options: AuditIngestOptions;

  private udp: UdpSocket | undefined;
  private server: NetServer | undefined;
  private readonly sockets = new Set<NetSocket>();
  /** Partial line carried across stream chunk boundaries. */
  private streamBuffer = '';
  private draining = false;
  private handler: AuditHandler | undefined;

  private received = 0;
  private parsed = 0;
  private malformed = 0;
  private droppedQueueFull = 0;
  private droppedRateLimited = 0;
  private droppedWrongFacility = 0;

  constructor(options: AuditIngestOptions = {}) {
    super();
    this.options = options;
    this.maxQueue = options.maxQueue ?? 10_000;
    this.now = options.now ?? Date.now;
    this.requireFacility = options.requireFacility ?? false;
    this.log = options.logger;
    this.bucket = new TokenBucket(
      options.burstCapacity ?? 5_000,
      options.rateLimitPerSecond ?? 2_000,
      this.now,
    );
  }

  /** Registers the consumer. The lock manager (T24) is the real one. */
  onEvent(handler: AuditHandler): void {
    this.handler = handler;
  }

  get stats(): AuditStats {
    return {
      received: this.received,
      parsed: this.parsed,
      malformed: this.malformed,
      droppedQueueFull: this.droppedQueueFull,
      droppedRateLimited: this.droppedRateLimited,
      droppedWrongFacility: this.droppedWrongFacility,
      queueDepth: this.queue.length,
    };
  }

  /**
   * Parses one line and queues the result.
   *
   * Returns the event for the benefit of tests and direct callers; delivery to the
   * handler happens on the drain, not here, so a slow consumer cannot stall the socket
   * read that produced this line.
   */
  ingestLine(line: string): AuditEvent | null {
    this.received += 1;

    if (this.requireFacility) {
      const { facility } = stripSyslogEnvelope(line);
      if (facility !== null && facility !== LOCAL5_FACILITY) {
        this.droppedWrongFacility += 1;
        return null;
      }
    }

    if (!this.bucket.tryConsume()) {
      this.droppedRateLimited += 1;
      // Deliberately not logged per event: logging a flood at the rate of the flood is
      // how a rate limiter becomes the outage it was meant to prevent. The counter is
      // exported and surfaces on the dashboard.
      return null;
    }

    let event: AuditEvent | null;
    try {
      event = parseAuditLine(line);
    } catch {
      // Defence in depth. parseAuditLine is written not to throw; if it ever does, a
      // malformed filename must not take ingestion down with it.
      event = null;
    }

    if (event === null) {
      this.malformed += 1;
      return null;
    }

    this.parsed += 1;
    this.enqueue(event);
    return event;
  }

  /**
   * Enqueues, dropping the **oldest** event when full.
   *
   * Dropping the oldest is the right choice for this data: a lock decision is about what
   * is true now, and a queue that has fallen 10 000 events behind is holding history
   * that `smbstatus` reconciliation will supersede anyway.
   */
  private enqueue(event: AuditEvent): void {
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.droppedQueueFull += 1;
    }
    this.queue.push(event);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    setImmediate(() => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        if (event === undefined) {
          break;
        }
        this.emit('event', event);
        if (this.handler !== undefined) {
          try {
            await this.handler(event);
          } catch (error) {
            // One consumer failure must not stop the stream for every other path.
            this.log?.warn(
              { error: (error as Error).message, path: event.path },
              'audit event handler threw',
            );
          }
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) {
        this.scheduleDrain();
      }
    }
  }

  /** Splits a stream chunk into lines, carrying any partial line to the next chunk. */
  ingestChunk(chunk: string): void {
    this.streamBuffer += chunk;
    const lines = this.streamBuffer.split('\n');
    // The final element is either an empty string or a partial line; either way it is
    // not ready to parse yet.
    this.streamBuffer = lines.pop() ?? '';

    // A peer that never sends a newline would otherwise grow this buffer without bound.
    if (this.streamBuffer.length > 64 * 1024) {
      this.malformed += 1;
      this.streamBuffer = '';
    }

    for (const line of lines) {
      if (line.trim() !== '') {
        this.ingestLine(line);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Transports
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.options.socketPath !== undefined) {
      await this.startUnixStream(this.options.socketPath);
      return;
    }
    await this.startUdp(this.options.port ?? DEFAULT_AUDIT_PORT, this.options.host ?? '127.0.0.1');
  }

  private startUdp(port: number, host: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      this.udp = socket;

      socket.on('message', (message) => {
        this.ingestLine(message.toString('utf8'));
      });
      socket.on('error', (error) => {
        this.log?.error({ error: error.message }, 'audit socket error');
        this.emit('socket-error', error);
      });
      socket.once('listening', () => {
        this.log?.info({ port, host }, 'listening for full_audit events');
        resolve();
      });
      socket.once('error', reject);

      // Loopback only. These events name files and machines on the shop floor; there is
      // no reason for the socket to be reachable from anywhere else.
      socket.bind(port, host);
    });
  }

  private startUnixStream(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        this.sockets.add(socket);
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.ingestChunk(chunk));
        socket.on('error', () => socket.destroy());
        socket.on('close', () => this.sockets.delete(socket));
      });
      this.server = server;

      server.on('error', reject);
      server.listen(path, () => {
        this.log?.info({ path }, 'listening for full_audit events');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    if (this.udp !== undefined) {
      const socket = this.udp;
      this.udp = undefined;
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
    if (this.server !== undefined) {
      const server = this.server;
      this.server = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.queue.length = 0;
  }
}

/**
 * The rsyslog snippet that feeds this module.
 *
 * Shipped as a constant so the installer and the documentation cannot drift apart from
 * what the code actually listens on. `stop` is what keeps R16 honest: without it these
 * lines also land in `/var/log/syslog` and the disk fills anyway.
 */
export const rsyslogRule = (port: number = DEFAULT_AUDIT_PORT): string =>
  [
    '# Installed by TNC Network Bridge. Forwards Samba full_audit events to the',
    '# bridge and discards them afterwards, so they never reach the disk (R16).',
    `local5.*  @127.0.0.1:${port}`,
    'local5.*  stop',
    '',
  ].join('\n');
