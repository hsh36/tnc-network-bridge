import { existsSync, statSync } from 'node:fs';
import { get } from 'node:https';
import { join } from 'node:path';
import { type TLSSocket } from 'node:tls';
import { pki } from 'node-forge';
import { cleanupTmpDbs, tmpDir } from '../../../tests/support/tmp-db';
import {
  CertificateError,
  HttpsServerManager,
  defaultSubjectAltNames,
  describeCertificate,
  ensureCertificate,
  generateSelfSignedCertificate,
  loadCertificateMaterial,
  saveCertificateMaterial,
  validateCertificateMaterial,
  type CertificateMaterial,
} from './https-setup';

afterEach(() => {
  cleanupTmpDbs();
});

describe('defaultSubjectAltNames', () => {
  it('always includes localhost and the loopback addresses', () => {
    const sans = defaultSubjectAltNames();
    expect(sans).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1']));
  });

  it('includes an explicit hostname when given', () => {
    expect(defaultSubjectAltNames('bridge.local')).toContain('bridge.local');
  });
});

describe('generateSelfSignedCertificate', () => {
  it('produces a certificate and key that parse and match each other', () => {
    const material = generateSelfSignedCertificate({ commonName: 'bridge.local' });
    const result = validateCertificateMaterial(material);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('marks the certificate as self-signed with the requested common name', () => {
    const material = generateSelfSignedCertificate({ commonName: 'bridge.local' });
    const info = describeCertificate(material.certPem);
    expect(info.selfSigned).toBe(true);
    expect(info.subject).toContain('bridge.local');
    expect(info.subjectAltNames).toEqual(expect.arrayContaining(['bridge.local', 'localhost']));
  });

  it('honours the requested validity period', () => {
    const material = generateSelfSignedCertificate({ validityYears: 5 });
    const info = describeCertificate(material.certPem);
    expect(info.daysUntilExpiry).toBeGreaterThan(4 * 365);
    expect(info.daysUntilExpiry).toBeLessThanOrEqual(5 * 365 + 1);
  });

  it('includes additional SANs beyond the automatic set', () => {
    const material = generateSelfSignedCertificate({ additionalSans: ['programs.example.org'] });
    const info = describeCertificate(material.certPem);
    expect(info.subjectAltNames).toContain('programs.example.org');
  });
});

describe('describeCertificate', () => {
  it('throws a CertificateError for unparsable input', () => {
    expect(() => describeCertificate('not a certificate')).toThrow(CertificateError);
  });
});

/**
 * Builds an already-expired self-signed certificate directly with node-forge.
 *
 * `selfsigned.generate()` cannot do this: it runs its own internal chain
 * verification before returning, which rejects a certificate whose `notAfter` is
 * already in the past. That refusal is a fine thing for it to do when *generating*
 * fresh certificates — but `validateCertificateMaterial` also has to catch an
 * already-expired certificate handed to it from elsewhere (a custom upload), so that
 * path needs a fixture selfsigned itself will not produce.
 */
function buildExpiredCertificate(): { certPem: string; keyPem: string } {
  const keys = pki.rsa.generateKeyPair(1024);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 800 * 86_400_000);
  cert.validity.notAfter = new Date(Date.now() - 400 * 86_400_000);
  const attrs = [{ name: 'commonName', value: 'expired.local' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  return { certPem: pki.certificateToPem(cert), keyPem: pki.privateKeyToPem(keys.privateKey) };
}

describe('validateCertificateMaterial', () => {
  it('reports a mismatched key without touching disk', () => {
    const a = generateSelfSignedCertificate({ commonName: 'a.local' });
    const b = generateSelfSignedCertificate({ commonName: 'b.local' });
    const result = validateCertificateMaterial({ certPem: a.certPem, keyPem: b.keyPem });

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'keyPem')).toBe(true);
  });

  it('reports a malformed certificate', () => {
    const material = generateSelfSignedCertificate();
    const result = validateCertificateMaterial({ certPem: 'garbage', keyPem: material.keyPem });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.path).toBe('certPem');
  });

  it('reports an expired certificate', () => {
    const expired = buildExpiredCertificate();
    const result = validateCertificateMaterial(expired);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('expired'))).toBe(true);
  });

  it('does not return certificate info when the certificate itself is invalid', () => {
    const material = generateSelfSignedCertificate();
    const result = validateCertificateMaterial({ certPem: 'garbage', keyPem: material.keyPem });
    expect(result.info).toBeUndefined();
  });
});

describe('save / load / ensure certificate material', () => {
  it('round-trips certificate material through disk', () => {
    const dir = join(tmpDir(), 'tls');
    const material = generateSelfSignedCertificate();
    saveCertificateMaterial(dir, material);

    const loaded = loadCertificateMaterial(dir);
    expect(loaded.certPem).toBe(material.certPem);
    expect(loaded.keyPem).toBe(material.keyPem);
    expect(loaded.chainPem).toBeUndefined();
  });

  it('persists a supplied chain alongside cert and key', () => {
    const dir = join(tmpDir(), 'tls');
    const material: CertificateMaterial = {
      ...generateSelfSignedCertificate(),
      chainPem: generateSelfSignedCertificate().certPem,
    };
    saveCertificateMaterial(dir, material);
    expect(loadCertificateMaterial(dir).chainPem).toBe(material.chainPem);
  });

  it('writes the private key with owner-only permissions on Linux', () => {
    const dir = join(tmpDir(), 'tls');
    saveCertificateMaterial(dir, generateSelfSignedCertificate());
    if (process.platform === 'linux') {
      const mode = statSync(join(dir, 'key.pem')).mode & 0o777;
      expect(mode).toBe(0o600);
    } else {
      expect(existsSync(join(dir, 'key.pem'))).toBe(true);
    }
  });

  it('throws a CertificateError when no material has been saved', () => {
    const dir = join(tmpDir(), 'empty-tls');
    expect(() => loadCertificateMaterial(dir)).toThrow(CertificateError);
  });

  it('generates and persists on first call, then reuses the same material', () => {
    const dir = join(tmpDir(), 'tls');
    const first = ensureCertificate(dir, { commonName: 'bridge.local' });
    const second = ensureCertificate(dir, { commonName: 'ignored-once-a-cert-exists.local' });
    expect(second.certPem).toBe(first.certPem);
  });
});

describe('HttpsServerManager', () => {
  it('serves over TLS with the configured certificate', async () => {
    const material = generateSelfSignedCertificate({ commonName: 'localhost' });
    const manager = HttpsServerManager.create(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      },
      { material },
    );

    await manager.listen(0, '127.0.0.1');
    const address = manager.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a bound TCP address');
    }

    try {
      const body = await new Promise<string>((resolve, reject) => {
        get(
          { host: '127.0.0.1', port: address.port, path: '/', rejectUnauthorized: false },
          (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => (data += chunk.toString()));
            res.on('end', () => resolve(data));
          },
        ).on('error', reject);
      });
      expect(body).toBe('ok');
    } finally {
      await manager.close();
    }
  });

  it('rejects a certificate/key pair that do not match', () => {
    const a = generateSelfSignedCertificate({ commonName: 'a.local' });
    const b = generateSelfSignedCertificate({ commonName: 'b.local' });
    expect(() =>
      HttpsServerManager.create((_req, res) => res.end(), {
        material: { certPem: a.certPem, keyPem: b.keyPem },
      }),
    ).toThrow(CertificateError);
  });

  it('hot-swaps the serving certificate without restarting the listener', async () => {
    const first = generateSelfSignedCertificate({ commonName: 'localhost' });
    const second = generateSelfSignedCertificate({ commonName: 'localhost' });
    const manager = HttpsServerManager.create((_req, res) => res.end('ok'), { material: first });
    await manager.listen(0, '127.0.0.1');
    const address = manager.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a bound TCP address');
    }

    manager.reload(second);

    try {
      const fingerprint = await new Promise<string | undefined>((resolve, reject) => {
        get(
          { host: '127.0.0.1', port: address.port, path: '/', rejectUnauthorized: false },
          (res) => {
            const socket = res.socket as TLSSocket;
            resolve(socket.getPeerCertificate().fingerprint256);
            res.resume();
          },
        ).on('error', reject);
      });
      expect(fingerprint).toBe(describeCertificate(second.certPem).fingerprintSha256);
    } finally {
      await manager.close();
    }
  });
});
