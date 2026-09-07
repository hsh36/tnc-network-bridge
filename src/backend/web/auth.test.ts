import { join } from 'node:path';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { ConfigManager } from '../config/config-manager';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { generateSecretKey } from '../config/secrets';
import { AuthLogWriter } from '../logging/auth-log';
import {
  ADMIN_USERNAME,
  AuthManager,
  InvalidCredentialsError,
  InvalidCsrfError,
  InvalidTokenError,
  RateLimitedError,
  SessionExpiredError,
} from './auth';

const PASSWORD = 'Sup3rGeheim!Passwort-2026';

let db: Db;
let config: ConfigManager;
let auth: AuthManager;
let clockSeconds: number;

const loginInput = (overrides: Partial<{ username: string; password: string }> = {}) => ({
  username: ADMIN_USERNAME,
  password: PASSWORD,
  ip: '192.168.1.50',
  userAgent: 'jest',
  ...overrides,
});

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = ConfigManager.create({ db, secretKey: generateSecretKey() });
  clockSeconds = 1_700_000_000;
  auth = new AuthManager({
    db,
    config,
    authLog: new AuthLogWriter(join(tmpDir(), 'auth.log')),
    now: () => clockSeconds,
  });
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('password lifecycle', () => {
  it('has no password until one is set', () => {
    expect(auth.hasPassword()).toBe(false);
  });

  it('accepts a matching password after it is set', async () => {
    await auth.setPassword(PASSWORD);
    expect(auth.hasPassword()).toBe(true);
    await expect(auth.login(loginInput())).resolves.toBeDefined();
  });

  it('rejects login before any password has been set, without throwing internally', async () => {
    await expect(auth.login(loginInput())).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('rejects the wrong password', async () => {
    await auth.setPassword(PASSWORD);
    await expect(
      auth.login(loginInput({ password: 'wrong-password-entirely' })),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('rejects the wrong username even with the right password', async () => {
    await auth.setPassword(PASSWORD);
    await expect(auth.login(loginInput({ username: 'someone-else' }))).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it('revokes every existing session when the password is changed', async () => {
    await auth.setPassword(PASSWORD);
    const { cookieValue } = await auth.login(loginInput());
    expect(() => auth.validateSession(cookieValue)).not.toThrow();

    await auth.setPassword('AnotherLong3rPassword!!');
    expect(() => auth.validateSession(cookieValue)).toThrow(SessionExpiredError);
  });
});

describe('sessions', () => {
  beforeEach(async () => {
    await auth.setPassword(PASSWORD);
  });

  it('issues a session on successful login', async () => {
    const { cookieValue, session } = await auth.login(loginInput());
    expect(cookieValue).toHaveLength(43); // base64url of 32 random bytes, no padding
    expect(session.csrfToken).toHaveLength(64);
    expect(session.expiresAt).toBeGreaterThan(session.createdAt);
  });

  it('validates a live session and slides the idle window forward', async () => {
    const { cookieValue } = await auth.login(loginInput());
    clockSeconds += 60;
    const record = auth.validateSession(cookieValue);
    expect(record.lastSeenAt).toBe(clockSeconds);
  });

  it('rejects an unknown cookie value', () => {
    expect(() => auth.validateSession('not-a-real-cookie')).toThrow(SessionExpiredError);
  });

  it('expires a session after the idle timeout with no activity', async () => {
    const { cookieValue } = await auth.login(loginInput());
    const idleMin = config.get('security').sessionIdleMin;
    clockSeconds += idleMin * 60 + 1;
    expect(() => auth.validateSession(cookieValue)).toThrow(SessionExpiredError);
  });

  it('does not expire a session that is repeatedly used within the idle window', async () => {
    const { cookieValue } = await auth.login(loginInput());
    const idleMin = config.get('security').sessionIdleMin;
    for (let i = 0; i < 5; i += 1) {
      clockSeconds += Math.floor((idleMin * 60) / 2);
      expect(() => auth.validateSession(cookieValue)).not.toThrow();
    }
  });

  it('expires a session at the absolute cap even with continuous activity', async () => {
    const { cookieValue } = await auth.login(loginInput());
    const security = config.get('security');
    // Touch it just inside the idle window each time, but cross the absolute cap.
    const step = security.sessionIdleMin * 60 - 5;
    let elapsed = 0;
    while (elapsed < security.sessionAbsoluteH * 3600) {
      clockSeconds += step;
      elapsed += step;
    }
    expect(() => auth.validateSession(cookieValue)).toThrow(SessionExpiredError);
  });

  it('logs out, after which the cookie is no longer valid', async () => {
    const { cookieValue } = await auth.login(loginInput());
    auth.logout(cookieValue);
    expect(() => auth.validateSession(cookieValue)).toThrow(SessionExpiredError);
  });

  it('reflects setupRequired from the setup.completed flag', async () => {
    const { session } = await auth.login(loginInput());
    expect(auth.toSessionInfo(session).setupRequired).toBe(true);

    config.setFlag('setup.completed', true);
    expect(auth.toSessionInfo(session).setupRequired).toBe(false);
  });

  it('prunes sessions past their absolute expiry', async () => {
    const { session } = await auth.login(loginInput());
    clockSeconds = session.expiresAt + 1;
    expect(auth.pruneExpiredSessions()).toBe(1);
    expect(auth.pruneExpiredSessions()).toBe(0);
  });
});

describe('CSRF', () => {
  beforeEach(async () => {
    await auth.setPassword(PASSWORD);
  });

  it('accepts the session csrf token', async () => {
    const { session } = await auth.login(loginInput());
    expect(() => auth.verifyCsrf(session, session.csrfToken)).not.toThrow();
  });

  it('rejects a missing or mismatched token', async () => {
    const { session } = await auth.login(loginInput());
    expect(() => auth.verifyCsrf(session, undefined)).toThrow(InvalidCsrfError);
    expect(() => auth.verifyCsrf(session, 'wrong-token')).toThrow(InvalidCsrfError);
  });
});

describe('rate limiting', () => {
  beforeEach(async () => {
    await auth.setPassword(PASSWORD);
  });

  it('locks out after the configured number of failed attempts from one IP', async () => {
    const max = config.get('security').loginMaxAttempts;
    for (let i = 0; i < max; i += 1) {
      await expect(auth.login(loginInput({ password: 'wrong' }))).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    }
    await expect(auth.login(loginInput())).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('does not rate-limit a different IP', async () => {
    const max = config.get('security').loginMaxAttempts;
    for (let i = 0; i < max; i += 1) {
      await expect(
        auth.login({ ...loginInput({ password: 'wrong' }), ip: '10.0.0.1' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    }
    await expect(auth.login({ ...loginInput(), ip: '10.0.0.2' })).resolves.toBeDefined();
  });

  it('clears the attempt count on a successful login', async () => {
    const max = config.get('security').loginMaxAttempts;
    for (let i = 0; i < max - 1; i += 1) {
      await expect(auth.login(loginInput({ password: 'wrong' }))).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    }
    await expect(auth.login(loginInput())).resolves.toBeDefined();
    // Immediately after a successful login the counter should be reset, not sitting
    // one attempt away from the limit.
    await expect(auth.login(loginInput({ password: 'wrong' }))).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});

describe('API tokens', () => {
  it('creates a token, validates it, and tracks last use', () => {
    const { token, value } = auth.createToken('prtg', ['read']);
    expect(value.startsWith('tnc_')).toBe(true);
    expect(token.lastUsedAt).toBeNull();

    const validated = auth.validateToken(value);
    expect(validated.id).toBe(token.id);
    expect(validated.lastUsedAt).not.toBeNull();
  });

  it('rejects an unknown token value', () => {
    expect(() => auth.validateToken('tnc_does-not-exist')).toThrow(InvalidTokenError);
  });

  it('rejects a revoked token', () => {
    const { token, value } = auth.createToken('prtg', ['read']);
    auth.revokeToken(token.id);
    expect(() => auth.validateToken(value)).toThrow(InvalidTokenError);
  });

  it('lists tokens newest first', () => {
    auth.createToken('first', ['read']);
    auth.createToken('second', ['read']);
    const names = auth.listTokens().map((t) => t.name);
    expect(names).toEqual(['second', 'first']);
  });
});
