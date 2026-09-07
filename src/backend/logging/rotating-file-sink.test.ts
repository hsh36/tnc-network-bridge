import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpDbs, tmpDir } from '../../../tests/support/tmp-db';
import { pruneRotatedLogs, RotatingFileSink } from './rotating-file-sink';

afterEach(() => {
  cleanupTmpDbs();
});

const line = (n: number): string => `${'x'.repeat(90)}${String(n).padStart(8, '0')}\n`;

describe('RotatingFileSink', () => {
  it('writes lines to the live file', () => {
    const path = join(tmpDir(), 'app.log');
    const sink = new RotatingFileSink({ path });
    sink.write('hello\n');
    sink.write('world\n');
    sink.closeSink();
    expect(readFileSync(path, 'utf8')).toBe('hello\nworld\n');
  });

  it('creates the log directory', () => {
    const path = join(tmpDir(), 'nested', 'app.log');
    const sink = new RotatingFileSink({ path });
    sink.write('hi\n');
    sink.closeSink();
    expect(existsSync(path)).toBe(true);
  });

  it('rotates once the size limit would be exceeded', () => {
    const path = join(tmpDir(), 'app.log');
    const sink = new RotatingFileSink({ path, maxBytes: 300, maxFiles: 3 });
    for (let i = 0; i < 5; i += 1) {
      sink.write(line(i));
    }
    sink.closeSink();

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.1`)).toBe(true);
  });

  it('never splits a line across two generations', () => {
    const path = join(tmpDir(), 'app.log');
    const sink = new RotatingFileSink({ path, maxBytes: 250, maxFiles: 5 });
    for (let i = 0; i < 10; i += 1) {
      sink.write(line(i));
    }
    sink.closeSink();

    const files = readdirSync(join(path, '..')).filter((f) => f.startsWith('app.log'));
    for (const file of files) {
      const content = readFileSync(join(path, '..', file), 'utf8');
      if (content === '') {
        continue;
      }
      expect(content.endsWith('\n')).toBe(true);
      for (const written of content.trim().split('\n')) {
        expect(written).toHaveLength(98);
      }
    }
  });

  it('keeps every line across all generations', () => {
    const path = join(tmpDir(), 'app.log');
    const sink = new RotatingFileSink({ path, maxBytes: 250, maxFiles: 20 });
    for (let i = 0; i < 20; i += 1) {
      sink.write(line(i));
    }
    sink.closeSink();

    const dir = join(path, '..');
    const all = readdirSync(dir)
      .filter((f) => f.startsWith('app.log'))
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n'))
      .filter((l) => l !== '');
    expect(all).toHaveLength(20);
  });

  it('discards the oldest generation past maxFiles', () => {
    const path = join(tmpDir(), 'app.log');
    const sink = new RotatingFileSink({ path, maxBytes: 200, maxFiles: 2 });
    for (let i = 0; i < 15; i += 1) {
      sink.write(line(i));
    }
    sink.closeSink();

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    // The bound is what stops an SD card filling up unattended.
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  it('shifts generations so .1 is always the most recent', () => {
    const path = join(tmpDir(), 'app.log');
    const sink = new RotatingFileSink({ path, maxBytes: 200, maxFiles: 3 });
    sink.write(`first${'-'.repeat(200)}\n`);
    sink.write(`second${'-'.repeat(200)}\n`);
    sink.write(`third${'-'.repeat(200)}\n`);
    sink.closeSink();

    expect(readFileSync(`${path}.1`, 'utf8')).toContain('second');
    expect(readFileSync(`${path}.2`, 'utf8')).toContain('first');
  });

  it('appends to an existing file rather than truncating it', () => {
    const path = join(tmpDir(), 'app.log');
    writeFileSync(path, 'previous run\n');
    const sink = new RotatingFileSink({ path });
    sink.write('this run\n');
    sink.closeSink();
    expect(readFileSync(path, 'utf8')).toBe('previous run\nthis run\n');
  });

  it('tracks the live file size', () => {
    const path = join(tmpDir(), 'app.log');
    const sink = new RotatingFileSink({ path });
    sink.write('12345\n');
    expect(sink.currentSize).toBe(6);
    sink.closeSink();
  });
});

describe('pruneRotatedLogs', () => {
  const ageFile = (path: string, days: number): void => {
    const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    utimesSync(path, when, when);
  };

  it('removes generations older than the retention window', () => {
    const dir = tmpDir();
    const path = join(dir, 'app.log');
    writeFileSync(path, 'live\n');
    writeFileSync(`${path}.1`, 'recent\n');
    writeFileSync(`${path}.2`, 'old\n');
    ageFile(`${path}.2`, 40);

    const removed = pruneRotatedLogs(path, 30);

    expect(removed).toEqual([`${path}.2`]);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(false);
  });

  it('never removes the live file, however old it is', () => {
    const dir = tmpDir();
    const path = join(dir, 'app.log');
    writeFileSync(path, 'live\n');
    ageFile(path, 400);

    pruneRotatedLogs(path, 30);
    expect(existsSync(path)).toBe(true);
  });

  it('leaves unrelated files alone', () => {
    const dir = tmpDir();
    const path = join(dir, 'app.log');
    writeFileSync(path, 'live\n');
    writeFileSync(join(dir, 'sync.log.1'), 'other\n');
    writeFileSync(join(dir, 'notes.txt'), 'keep\n');
    ageFile(join(dir, 'sync.log.1'), 90);
    ageFile(join(dir, 'notes.txt'), 90);

    pruneRotatedLogs(path, 30);

    expect(existsSync(join(dir, 'sync.log.1'))).toBe(true);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });

  it('is a no-op for a directory that does not exist', () => {
    expect(pruneRotatedLogs(join(tmpDir(), 'absent', 'app.log'), 30)).toEqual([]);
  });
});
