import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpDbs, tmpDir } from '../../../tests/support/tmp-db';
import {
  decryptSecret,
  encryptSecret,
  generateSecretKey,
  isSecretEnvelope,
  loadSecretKey,
  parseSecretKey,
  SecretError,
  secretsEqual,
  writeSecretKeyFile,
} from './secrets';

afterEach(() => {
  cleanupTmpDbs();
});

const KEY = generateSecretKey();
const PASSWORD = 'Sup3rGeheim!Passwort-2026';

describe('key material', () => {
  it('generates 32 bytes', () => {
    expect(generateSecretKey()).toHaveLength(32);
  });

  it('generates a different key each time', () => {
    expect(generateSecretKey().equals(generateSecretKey())).toBe(false);
  });

  it('parses a hex-encoded key file', () => {
    const key = generateSecretKey();
    expect(parseSecretKey(Buffer.from(`${key.toString('hex')}\n`)).equals(key)).toBe(true);
  });

  it('parses a raw 32-byte key file', () => {
    const key = generateSecretKey();
    expect(parseSecretKey(key).equals(key)).toBe(true);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => parseSecretKey(Buffer.from('too short'))).toThrow(SecretError);
  });

  it('writes and reads back a key file', () => {
    const path = join(tmpDir(), 'secret.key');
    const written = writeSecretKeyFile(path);
    expect(loadSecretKey(path).equals(written)).toBe(true);
    expect(readFileSync(path, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('explains itself when the key file is missing', () => {
    expect(() => loadSecretKey(join(tmpDir(), 'absent.key'))).toThrow(/created at install time/);
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a password', () => {
    expect(decryptSecret(encryptSecret(PASSWORD, KEY), KEY)).toBe(PASSWORD);
  });

  it('round-trips an empty string', () => {
    expect(decryptSecret(encryptSecret('', KEY), KEY)).toBe('');
  });

  it('round-trips non-ASCII, which AD passwords routinely contain', () => {
    const password = 'Größe-Änderung-Öl-2026-日本語';
    expect(decryptSecret(encryptSecret(password, KEY), KEY)).toBe(password);
  });

  it('never contains the plaintext', () => {
    const envelope = encryptSecret(PASSWORD, KEY);
    expect(envelope).not.toContain(PASSWORD);
    expect(Buffer.from(envelope, 'utf8').includes(PASSWORD)).toBe(false);
  });

  it('produces a different envelope every time for the same input', () => {
    // A deterministic ciphertext would leak that two accounts share a password, and
    // under GCM would be catastrophic — reusing an IV destroys the security of both.
    const a = encryptSecret(PASSWORD, KEY);
    const b = encryptSecret(PASSWORD, KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  it('is recognisable as an envelope', () => {
    expect(isSecretEnvelope(encryptSecret(PASSWORD, KEY))).toBe(true);
    expect(isSecretEnvelope(PASSWORD)).toBe(false);
    expect(isSecretEnvelope('')).toBe(false);
  });

  it('rejects a wrong key rather than returning garbage', () => {
    const envelope = encryptSecret(PASSWORD, KEY);
    expect(() => decryptSecret(envelope, generateSecretKey())).toThrow(SecretError);
  });

  it('rejects a key of the wrong size', () => {
    expect(() => encryptSecret(PASSWORD, Buffer.alloc(16))).toThrow(/32-byte key/);
  });

  it('detects a tampered ciphertext', () => {
    const parts = encryptSecret(PASSWORD, KEY).split(':');
    const ct = Buffer.from(parts[3] ?? '', 'base64');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    parts[3] = ct.toString('base64');
    expect(() => decryptSecret(parts.join(':'), KEY)).toThrow(/tampered/);
  });

  it('detects a tampered authentication tag', () => {
    const parts = encryptSecret(PASSWORD, KEY).split(':');
    const tag = Buffer.from(parts[2] ?? '', 'base64');
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    parts[2] = tag.toString('base64');
    expect(() => decryptSecret(parts.join(':'), KEY)).toThrow(SecretError);
  });

  it.each([
    ['empty', ''],
    ['not an envelope', 'hunter2'],
    ['wrong version', 'v9:AAAA:BBBB:CCCC'],
    ['too few parts', 'v1:AAAA:BBBB'],
    [
      'short iv',
      `v1:${Buffer.alloc(4).toString('base64')}:${Buffer.alloc(16).toString('base64')}:AA`,
    ],
  ])('rejects a malformed envelope (%s)', (_label, envelope) => {
    expect(() => decryptSecret(envelope, KEY)).toThrow(SecretError);
  });

  describe('associated data', () => {
    it('round-trips when the associated data matches', () => {
      const key = 'smb.server.credentials.password';
      expect(decryptSecret(encryptSecret(PASSWORD, KEY, key), KEY, key)).toBe(PASSWORD);
    });

    it('refuses to decrypt an envelope moved to a different config key', () => {
      // Someone with write access to the database must not be able to relocate the
      // AD password ciphertext into a field that is echoed back to them.
      const envelope = encryptSecret(PASSWORD, KEY, 'smb.server.credentials.password');
      expect(() => decryptSecret(envelope, KEY, 'sync.conflictMode')).toThrow(SecretError);
    });

    it('refuses to decrypt without the associated data it was sealed with', () => {
      const envelope = encryptSecret(PASSWORD, KEY, 'smb.server.credentials.password');
      expect(() => decryptSecret(envelope, KEY)).toThrow(SecretError);
    });
  });
});

describe('secretsEqual', () => {
  it('matches identical strings', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
  });

  it('rejects different strings', () => {
    expect(secretsEqual('abc', 'abd')).toBe(false);
  });

  it('rejects strings of different length without throwing', () => {
    expect(secretsEqual('abc', 'abcd')).toBe(false);
    expect(secretsEqual('', 'a')).toBe(false);
  });
});
