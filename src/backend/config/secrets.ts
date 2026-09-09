import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * AES-256-GCM envelope encryption for secrets at rest (ARCHITECTURE §5.5).
 *
 * The threat this addresses is narrow and worth stating plainly: it stops an AD
 * service-account password from sitting in cleartext in a database file that gets
 * copied off the device, backed up, or attached to a support ticket. It does not
 * defend against an attacker who is already root on the bridge — that attacker can
 * read the key. Privilege separation (T7) is what limits *that* exposure; this is
 * what limits the exposure of the database file itself.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits is the GCM-native nonce length; anything else forces an internal rehash. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 'v1';

export const DEFAULT_SECRET_KEY_PATH = '/etc/tnc-bridge/secret.key';

export class SecretError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SecretError';
  }
}

/** 32 random bytes from the kernel CSPRNG, hex-encoded for a human-readable key file. */
export function generateSecretKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Reads the key from disk.
 *
 * The file is written by the installer as `0600 tncbridge:tncbridge` — owned by the
 * service account, because the check below leaves no group bit for it to read through.
 * If the mode is wider than that on Linux this throws rather than warns: a
 * world-readable key is indistinguishable from no encryption at all, and silently
 * continuing would leave the operator believing their credentials are protected.
 */
export function loadSecretKey(path: string = DEFAULT_SECRET_KEY_PATH): Buffer {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    throw new SecretError(
      `Cannot read the secret key at ${path}. It is created at install time; ` +
        `without it, stored credentials cannot be decrypted.`,
      err,
    );
  }

  assertKeyFilePermissions(path);
  return parseSecretKey(raw, path);
}

function assertKeyFilePermissions(path: string): void {
  // Windows reports a synthesised mode, so the check would be meaningless there.
  if (process.platform !== 'linux') {
    return;
  }
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new SecretError(
      `The secret key at ${path} has mode ${mode.toString(8).padStart(4, '0')}. ` +
        `It must not be readable by group or other; run: chmod 0600 ${path}`,
    );
  }
}

/** Accepts either 64 hex characters or 32 raw bytes. */
export function parseSecretKey(raw: Buffer, source = '<buffer>'): Buffer {
  const text = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return Buffer.from(text, 'hex');
  }
  if (raw.length === KEY_BYTES) {
    return Buffer.from(raw);
  }
  throw new SecretError(
    `The secret key in ${source} is malformed: expected 64 hex characters or ` +
      `${KEY_BYTES} raw bytes, found ${raw.length} bytes.`,
  );
}

/** Writes a key file with the correct mode, creating the directory if needed. */
export function writeSecretKeyFile(path: string, key: Buffer = generateSecretKey()): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new SecretError(`A secret key must be exactly ${KEY_BYTES} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  writeFileSync(path, `${key.toString('hex')}\n`, { mode: 0o600 });
  if (process.platform === 'linux') {
    // writeFileSync's mode is masked by the process umask; chmod is not.
    chmodSync(path, 0o600);
  }
  return key;
}

/**
 * Encrypts a secret into a self-describing envelope: `v1:<iv>:<tag>:<ciphertext>`.
 *
 * `aad` binds the ciphertext to where it is stored — in practice the config key. That
 * makes a copied envelope useless anywhere else: someone with write access to the
 * database cannot move the AD password ciphertext into a field that gets echoed back,
 * because authentication fails when the associated data does not match.
 */
export function encryptSecret(plaintext: string, key: Buffer, aad?: string): string {
  assertKeyLength(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypts an envelope, verifying the authentication tag.
 *
 * Any tampering — with the ciphertext, the tag, or the associated data — surfaces as
 * a thrown SecretError rather than as plausible-looking garbage.
 */
export function decryptSecret(envelope: string, key: Buffer, aad?: string): string {
  assertKeyLength(key);
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new SecretError('Malformed secret envelope');
  }
  const [, ivB64 = '', tagB64 = '', ctB64 = ''] = parts;

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretError('Malformed secret envelope');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    if (aad !== undefined) {
      decipher.setAAD(Buffer.from(aad, 'utf8'));
    }
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new SecretError(
      'Could not decrypt a stored secret. The secret key may have been replaced, ' +
        'or the stored value tampered with.',
      err,
    );
  }
}

/** True when a stored value looks like an envelope this module produced. */
export function isSecretEnvelope(value: string): boolean {
  return value.startsWith(`${ENVELOPE_VERSION}:`) && value.split(':').length === 4;
}

/** Constant-time comparison, for anywhere a secret is checked against user input. */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new SecretError(`AES-256 requires a ${KEY_BYTES}-byte key, got ${key.length}`);
  }
}
