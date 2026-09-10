import { X509Certificate, createPrivateKey } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type RequestListener } from 'node:http';
import { createServer, type Server, type ServerOptions } from 'node:https';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import selfsigned from 'selfsigned';
import { type CertificateInfo, type TlsVersion } from '../../shared';

/**
 * HTTPS and certificate management (T25).
 *
 * The management interface is HTTPS-only (ARCHITECTURE §5) and an operator must be
 * able to get a working, trusted-enough certificate on a device with no internet
 * access and no existing PKI — hence self-signed generation as the default path, with
 * a fully-validated custom import for sites that have their own CA.
 *
 * Certificate generation uses `selfsigned` (pure JS, backed by node-forge) rather than
 * shelling out to the system `openssl` binary: it keeps certificate creation working
 * identically in tests, in CI, and on the arm64 target without depending on whatever
 * OpenSSL happens to be installed, and it means T9's "no native compilation on the Pi"
 * rule is never at risk from this module.
 */

export const DEFAULT_TLS_DIR = '/etc/tnc-bridge/tls';

export class CertificateError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CertificateError';
  }
}

export interface CertificateMaterial {
  readonly certPem: string;
  readonly keyPem: string;
  readonly chainPem?: string;
}

export interface GenerateSelfSignedOptions {
  /** Primary subject / first DNS SAN. Defaults to the device hostname. */
  readonly commonName?: string;
  readonly validityYears?: number;
  /** Extra hostnames or IPs beyond the automatic set (hostname, interfaces, localhost). */
  readonly additionalSans?: readonly string[];
  readonly keyBits?: number;
}

/** Distinguishes an IP SAN (encoded as `iPAddress`) from a DNS SAN (encoded as `dNSName`). */
const isIpLike = (value: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');

/**
 * Every address this device could plausibly be reached on, plus `localhost`. Automatic
 * — an operator who adds a second NIC should not also have to remember to regenerate
 * the certificate before that interface's address stops matching it.
 */
export function defaultSubjectAltNames(hostname?: string): string[] {
  const names = new Set<string>(['localhost', '127.0.0.1', '::1']);
  if (hostname !== undefined && hostname.length > 0) {
    names.add(hostname);
  }
  for (const addresses of Object.values(networkInterfaces())) {
    for (const addr of addresses ?? []) {
      if (!addr.internal) {
        names.add(addr.address);
      }
    }
  }
  return [...names];
}

function toForgeAltNames(
  names: readonly string[],
): { type: number; value?: string; ip?: string }[] {
  return names.map((name) => (isIpLike(name) ? { type: 7, ip: name } : { type: 2, value: name }));
}

/** Generates a fresh self-signed certificate and its private key. */
export function generateSelfSignedCertificate(
  options: GenerateSelfSignedOptions = {},
): CertificateMaterial {
  const commonName = options.commonName ?? 'tnc-network-bridge.local';
  const sans = [
    ...new Set([commonName, ...defaultSubjectAltNames(), ...(options.additionalSans ?? [])]),
  ];

  const pems = selfsigned.generate([{ name: 'commonName', value: commonName }], {
    days: Math.round((options.validityYears ?? 10) * 365),
    keySize: options.keyBits ?? 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: toForgeAltNames(sans) },
    ],
  });

  return { certPem: pems.cert, keyPem: pems.private };
}

// ---------------------------------------------------------------------------
// Inspection and validation
// ---------------------------------------------------------------------------

/** Parses a PEM certificate into the shape the API and UI show as `certificates.get`. */
export function describeCertificate(certPem: string): CertificateInfo {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch (err) {
    throw new CertificateError('Could not parse the certificate', err);
  }

  const notBefore = Math.floor(new Date(cert.validFrom).getTime() / 1000);
  const notAfter = Math.floor(new Date(cert.validTo).getTime() / 1000);
  const keyDetails = cert.publicKey.asymmetricKeyDetails;

  return {
    subject: cert.subject.replace(/\n/g, ', '),
    issuer: cert.issuer.replace(/\n/g, ', '),
    serialNumber: cert.serialNumber,
    notBefore,
    notAfter,
    fingerprintSha256: cert.fingerprint256,
    subjectAltNames: parseSanString(cert.subjectAltName ?? ''),
    selfSigned: cert.issuer === cert.subject,
    keyType: cert.publicKey.asymmetricKeyType ?? 'unknown',
    keyBits: keyDetails?.modulusLength ?? null,
    daysUntilExpiry: Math.floor((notAfter - Math.floor(Date.now() / 1000)) / 86_400),
  };
}

function parseSanString(san: string): string[] {
  if (san.trim() === '') {
    return [];
  }
  // Node renders this as "DNS:foo.local, IP Address:127.0.0.1, ..." — strip the labels,
  // the UI shows plain host/IP strings.
  return san.split(',').map((part) => part.replace(/^\s*(DNS|IP Address):/, '').trim());
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: ValidationIssue[];
  readonly info?: CertificateInfo;
}

/**
 * Everything that must hold before a certificate is allowed to become the live one.
 * Called by the upload endpoint (T27) so a bad pair can never lock the operator out of
 * the only management interface (R11) — a failure here changes nothing on disk.
 */
export function validateCertificateMaterial(material: CertificateMaterial): ValidationResult {
  const issues: ValidationIssue[] = [];
  let cert: X509Certificate | undefined;

  try {
    cert = new X509Certificate(material.certPem);
  } catch (err) {
    issues.push({ path: 'certPem', message: `Not a valid certificate: ${messageOf(err)}` });
  }

  let keyOk = false;
  try {
    const key = createPrivateKey(material.keyPem);
    keyOk = key.asymmetricKeyType !== undefined;
  } catch (err) {
    issues.push({ path: 'keyPem', message: `Not a valid private key: ${messageOf(err)}` });
  }

  if (cert !== undefined && keyOk) {
    try {
      if (!cert.checkPrivateKey(createPrivateKey(material.keyPem))) {
        issues.push({ path: 'keyPem', message: 'The private key does not match the certificate' });
      }
    } catch (err) {
      issues.push({
        path: 'keyPem',
        message: `Could not verify the key against the certificate: ${messageOf(err)}`,
      });
    }
  }

  if (cert !== undefined) {
    const now = Date.now();
    if (new Date(cert.validTo).getTime() < now) {
      issues.push({ path: 'certPem', message: `The certificate expired on ${cert.validTo}` });
    }
    if (new Date(cert.validFrom).getTime() > now) {
      issues.push({
        path: 'certPem',
        message: `The certificate is not valid until ${cert.validFrom}`,
      });
    }
  }

  if (material.chainPem !== undefined) {
    try {
      const chain = new X509Certificate(material.chainPem);
      if (cert !== undefined && !chain.checkIssued(cert) && !cert.checkIssued(chain)) {
        issues.push({
          path: 'chainPem',
          message:
            'The supplied chain certificate does not appear to relate to the leaf certificate',
        });
      }
    } catch (err) {
      issues.push({
        path: 'chainPem',
        message: `Not a valid chain certificate: ${messageOf(err)}`,
      });
    }
  }

  const info =
    cert !== undefined && issues.every((i) => i.path !== 'certPem')
      ? describeCertificate(material.certPem)
      : undefined;
  return info === undefined
    ? { ok: issues.length === 0, issues }
    : { ok: issues.length === 0, issues, info };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const fileNames = { cert: 'cert.pem', key: 'key.pem', chain: 'chain.pem' } as const;

export function saveCertificateMaterial(dir: string, material: CertificateMaterial): void {
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  writeFileSync(join(dir, fileNames.cert), material.certPem, { mode: 0o644 });
  writeFileSync(join(dir, fileNames.key), material.keyPem, { mode: 0o600 });
  if (process.platform === 'linux') {
    // writeFileSync's mode is masked by umask; chmod is not (mirrors secrets.ts).
    chmodSync(join(dir, fileNames.key), 0o600);
  }
  if (material.chainPem !== undefined) {
    writeFileSync(join(dir, fileNames.chain), material.chainPem, { mode: 0o644 });
  }
}

export function loadCertificateMaterial(dir: string): CertificateMaterial {
  try {
    const certPem = readFileSync(join(dir, fileNames.cert), 'utf8');
    const keyPem = readFileSync(join(dir, fileNames.key), 'utf8');
    try {
      const chainPem = readFileSync(join(dir, fileNames.chain), 'utf8');
      return { certPem, keyPem, chainPem };
    } catch {
      return { certPem, keyPem };
    }
  } catch (err) {
    throw new CertificateError(`Could not load certificate material from ${dir}`, err);
  }
}

/** Loads the certificate from `dir`, generating and persisting a fresh one if absent. */
export function ensureCertificate(
  dir: string = DEFAULT_TLS_DIR,
  options: GenerateSelfSignedOptions = {},
): CertificateMaterial {
  try {
    return loadCertificateMaterial(dir);
  } catch {
    const material = generateSelfSignedCertificate(options);
    saveCertificateMaterial(dir, material);
    return material;
  }
}

// ---------------------------------------------------------------------------
// The HTTPS server itself
// ---------------------------------------------------------------------------

const MIN_VERSION_MAP: Record<TlsVersion, 'TLSv1.2' | 'TLSv1.3'> = {
  'TLSv1.2': 'TLSv1.2',
  'TLSv1.3': 'TLSv1.3',
};

export interface HttpsServerOptions {
  readonly material: CertificateMaterial;
  /** IMPLEMENTATION_PLAN §6 `security.tlsMin`, default `TLSv1.2`. */
  readonly tlsMin?: TlsVersion;
}

/**
 * Wraps `https.Server` with the one thing plain `https.createServer` cannot do on its
 * own: replace the live certificate without dropping connections or restarting the
 * process, which is what makes `certificates.regenerate` and `certificates.upload"
 * apply immediately (T27's AC).
 */
export class HttpsServerManager {
  private constructor(private readonly httpsServer: Server) {}

  static create(requestListener: RequestListener, options: HttpsServerOptions): HttpsServerManager {
    const server = createServer(buildSecureContext(options), requestListener);
    return new HttpsServerManager(server);
  }

  get server(): Server {
    return this.httpsServer;
  }

  /** Hot-swaps the certificate. Existing connections keep their negotiated session. */
  reload(material: CertificateMaterial, tlsMin?: TlsVersion): void {
    this.httpsServer.setSecureContext(
      buildSecureContext(tlsMin === undefined ? { material } : { material, tlsMin }),
    );
  }

  listen(port: number, host?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.httpsServer.once('error', onError);
      this.httpsServer.listen(port, host, () => {
        this.httpsServer.removeListener('error', onError);
        resolve();
      });
    });
  }

  /**
   * Stops listening and waits for open connections, but not for ever.
   *
   * `server.close()` alone never resolves here. It waits for every existing connection
   * to end, and this server's whole job includes `/events/stream` — an SSE response that
   * is *designed* never to end. One dashboard left open in a browser therefore hung
   * shutdown until systemd's SIGKILL, which on a device that reboots to apply an update
   * means the update looks like a crash.
   *
   * So: stop accepting, drop connections that are idle between requests immediately, and
   * give whatever is mid-response `graceMs` before cutting it. An SSE client treats that
   * as a dropped stream and reconnects, which is what it does after any restart anyway.
   */
  close(graceMs = DEFAULT_CLOSE_GRACE_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpsServer.close((err) => (err ? reject(err) : resolve()));
      this.httpsServer.closeIdleConnections();
      const force = setTimeout(() => {
        this.httpsServer.closeAllConnections();
      }, graceMs);
      // The timer must not be the reason the process stays alive once close resolves.
      force.unref();
    });
  }
}

/** How long a response mid-flight gets before the connection carrying it is cut. */
export const DEFAULT_CLOSE_GRACE_MS = 2000;

/**
 * The options shape accepted by both `https.createServer` and `Server#setSecureContext`
 * — building it once and validating it eagerly (via `createSecureContext`, whose result
 * is otherwise discarded) means a malformed cert/key pair fails here with a clear error
 * rather than surfacing later as an opaque TLS handshake failure.
 */
function buildSecureContext(options: HttpsServerOptions): ServerOptions {
  const minVersion = MIN_VERSION_MAP[options.tlsMin ?? 'TLSv1.2'];
  const context: ServerOptions = {
    cert: options.material.certPem,
    key: options.material.keyPem,
    ca: options.material.chainPem,
    minVersion,
  };
  try {
    createSecureContext(context);
  } catch (err) {
    throw new CertificateError(
      'The certificate/key pair could not be loaded into a TLS context',
      err,
    );
  }
  return context;
}
