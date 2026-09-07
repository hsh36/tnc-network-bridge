import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Writable } from 'node:stream';

/**
 * Size-based rotating file sink.
 *
 * Writes are synchronous. That is a deliberate trade: log lines here are short and
 * infrequent — a bridge moving NC programs produces tens of lines a second at worst,
 * not thousands — and a synchronous write to the page cache costs microseconds. In
 * exchange, a log line written immediately before a crash is actually on disk, which
 * is precisely when the log matters most. An async buffered sink would drop exactly
 * the lines that explain the failure.
 *
 * Rotation is `app.log` → `app.log.1` → `app.log.2` …, oldest discarded past
 * `maxFiles`. Age-based pruning is separate ({@link pruneRotatedLogs}) because the
 * retention policy is expressed in days while rotation is driven by size.
 */

export interface RotatingFileSinkOptions {
  /** Absolute path of the live log file. Its directory is created if missing. */
  readonly path: string;
  /** Rotate once the live file would exceed this. Default 10 MiB. */
  readonly maxBytes?: number;
  /** How many rotated generations to keep alongside the live file. Default 5. */
  readonly maxFiles?: number;
}

export class RotatingFileSink extends Writable {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private fd: number | undefined;
  private size = 0;

  constructor(options: RotatingFileSinkOptions) {
    super({ decodeStrings: false });
    this.path = options.path;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;

    mkdirSync(dirname(this.path), { recursive: true });
    this.open();
  }

  private open(): void {
    this.fd = openSync(this.path, 'a');
    this.size = existsSync(this.path) ? statSync(this.path).size : 0;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;

      // Rotate before the write, not after, so a single line is never split across
      // two generations.
      if (this.size > 0 && this.size + buffer.length > this.maxBytes) {
        this.rotate();
      }
      if (this.fd === undefined) {
        this.open();
      }
      if (this.fd !== undefined) {
        writeSync(this.fd, buffer);
        this.size += buffer.length;
      }
      callback();
    } catch (err) {
      // A failing log sink must never take down the process it is observing.
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Closes the live file, shifts every generation up by one, and reopens. */
  rotate(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }

    // Drop the generation that is about to fall off the end.
    const oldest = `${this.path}.${this.maxFiles}`;
    if (existsSync(oldest)) {
      rmSync(oldest, { force: true });
    }
    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      const from = `${this.path}.${i}`;
      if (existsSync(from)) {
        renameSync(from, `${this.path}.${i + 1}`);
      }
    }
    if (existsSync(this.path)) {
      renameSync(this.path, `${this.path}.1`);
    }

    this.open();
  }

  /** Bytes currently in the live file. */
  get currentSize(): number {
    return this.size;
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.closeSink();
    callback();
  }

  closeSink(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }
}

/**
 * Deletes rotated generations older than the retention window.
 *
 * Only touches `<name>.<n>` files belonging to the given live log — never the live
 * file itself, and never anything else in the directory.
 */
export function pruneRotatedLogs(logPath: string, retainDays: number): string[] {
  const dir = dirname(logPath);
  const prefix = `${basename(logPath)}.`;
  if (!existsSync(dir)) {
    return [];
  }
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(prefix) || !/\.\d+$/.test(entry)) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).mtimeMs < cutoff) {
      rmSync(full, { force: true });
      removed.push(full);
    }
  }
  return removed;
}
