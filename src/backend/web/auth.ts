import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';
import { type ApiToken, type SessionInfo, type TokenScope } from '../../shared';
import { type ConfigManager } from '../config/config-manager';
import { type Db, type DbLogger } from '../config/db';
import { secretsEqual } from '../config/secrets';
import { type AuthFailureReason, AuthLogWriter } from '../logging/auth-log';

/**
 * Authentication and sessions (T25).
 *
 * There is exactly one operator account, so this module never manages a `users`
 * table — the password hash is one config flag (`auth.passwordHash`, stored
 * unencrypted: an argon2id hash is already one-way, so it does not belong behind the
 * AES envelope T5 reserves for values that must be recoverable in plaintext) and every
 * session or token below is scoped to that one identity.
 *
 * Three durable stores back everything here, all from schema v1: `sessions` (cookie
 * identity, sliding idle window, absolute cap), `api_tokens` (read-only credentials for
 * monitoring integrations such as PRTG) and the `auth.log` sink Fail2Ban watches
 * (T6/T37) — every failure and lockout is written there via {@link AuthLogWriter} using
 * exactly the reasons its frozen failregex expects.
 */

export const ADMIN_USERNAME = 'admin';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SESSION_COOKIE_BYTES = 32;
const CSRF_TOKEN_BYTES = 32;
const TOKEN_VALUE_BYTES = 32;
const TOKEN_PREFIX = 'tnc_';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super('Invalid username or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class RateLimitedError extends AuthError {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many login attempts; try again later');
    this.name = 'RateLimitedError';
  }
}

export class SessionExpiredError extends AuthError {
  constructor() {
    super('Session is missing or has expired');
    this.name = 'SessionExpiredError';
  }
}

export class InvalidCsrfError extends AuthError {
  constructor() {
    super('CSRF token is missing or does not match the session');
    this.name = 'InvalidCsrfError';
  }
}

export class InvalidTokenError extends AuthError {
  constructor() {
    super('API token is missing, revoked or unknown');
    this.name = 'InvalidTokenError';
  }
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Verified against whenever there is no real hash to check — an unset password, or a
 * username that does not match `ADMIN_USERNAME`. Keeps the cost of a login attempt the
 * same regardless of which of those is true, rather than letting an early return make
 * "no password has been set yet" or "wrong username" distinguishable by timing.
 */
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= argon2Hash(randomBytes(32).toString('hex'));
  return dummyHash;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  csrf_token: string;
}

interface ApiTokenRow {
  id: number;
  name: string;
  token_hash: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly csrfToken: string;
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    ip: row.ip,
    userAgent: row.user_agent,
    csrfToken: row.csrf_token,
  };
}

function toApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    scopes: JSON.parse(row.scopes) as TokenScope[],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

// ---------------------------------------------------------------------------
// Login input/output
// ---------------------------------------------------------------------------

export interface LoginInput {
  readonly username: string;
  readonly password: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface LoginResult {
  /** The raw, unhashed cookie value — set it once and never persist it yourself. */
  readonly cookieValue: string;
  readonly session: SessionRecord;
}

export interface CreateTokenResult {
  readonly token: ApiToken;
  /** The raw value, shown exactly once — only its sha256 is stored. */
  readonly value: string;
}

export interface AuthManagerOptions {
  readonly db: Db;
  readonly config: ConfigManager;
  readonly logger?: DbLogger;
  /** Defaults to a real writer at the T6 default path; pass one to redirect it in tests. */
  readonly authLog?: AuthLogWriter;
  readonly now?: () => number;
}

const PASSWORD_HASH_FLAG = 'auth.passwordHash';

export class AuthManager {
  private readonly db: Db;
  private readonly config: ConfigManager;
  private readonly logger: DbLogger | undefined;
  private readonly authLog: AuthLogWriter;
  private readonly now: () => number;
  private readonly attempts = new Map<string, { count: number; windowStart: number }>();

  constructor(options: AuthManagerOptions) {
    this.db = options.db;
    this.config = options.config;
    this.logger = options.logger;
    this.authLog = options.authLog ?? new AuthLogWriter();
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // -------------------------------------------------------------------------
  // Password
  // -------------------------------------------------------------------------

  hasPassword(): boolean {
    return this.config.getFlag<string | null>(PASSWORD_HASH_FLAG, null) !== null;
  }

  /** Sets (or replaces) the admin password and revokes every existing session. */
  async setPassword(password: string): Promise<void> {
    const hashed = await argon2Hash(password);
    this.config.setFlag(PASSWORD_HASH_FLAG, hashed);
    this.revokeAllSessions();
  }

  /** Verifies the current password, then replaces it. Throws `InvalidCredentialsError`
   * if `currentPassword` is wrong — the schema-level "must differ from current" rule
   * is enforced by `changePasswordRequestSchema` before this is ever called. */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (!(await this.verifyPassword(currentPassword))) {
      throw new InvalidCredentialsError();
    }
    await this.setPassword(newPassword);
  }

  private async verifyPassword(password: string): Promise<boolean> {
    const stored = this.config.getFlag<string | null>(PASSWORD_HASH_FLAG, null);
    if (stored === null) {
      await argon2Verify(await getDummyHash(), password);
      return false;
    }
    return argon2Verify(stored, password);
  }

  // -------------------------------------------------------------------------
  // Login / sessions
  // -------------------------------------------------------------------------

  /**
   * Authenticates and opens a session, or throws. Rate limiting, the constant-time
   * password path and the Fail2Ban-facing log line are all handled here so route code
   * never has to remember any of the three.
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const ipKey = input.ip ?? 'unknown';
    this.assertNotRateLimited(ipKey);

    const usernameOk = secretsEqual(input.username, ADMIN_USERNAME);
    const passwordOk = await this.verifyPassword(input.password);

    if (!usernameOk || !passwordOk) {
      this.recordFailure(ipKey);
      this.logFailure(input, usernameOk ? 'invalid_password' : 'unknown_user');
      throw new InvalidCredentialsError();
    }

    this.attempts.delete(ipKey);
    this.authLog.success({ username: ADMIN_USERNAME, ip: ipKey });

    const security = this.config.get('security');
    const cookieValue = randomBytes(SESSION_COOKIE_BYTES).toString('base64url');
    const csrfToken = randomBytes(CSRF_TOKEN_BYTES).toString('hex');
    const createdAt = this.now();
    const expiresAt = createdAt + security.sessionAbsoluteH * 3600;

    this.db.run(
      `INSERT INTO sessions (id, created_at, last_seen_at, expires_at, ip, user_agent, csrf_token)
       VALUES (@id, @createdAt, @createdAt, @expiresAt, @ip, @userAgent, @csrfToken)`,
      {
        id: sha256Hex(cookieValue),
        createdAt,
        expiresAt,
        ip: input.ip,
        userAgent: input.userAgent,
        csrfToken,
      },
    );

    return {
      cookieValue,
      session: {
        id: sha256Hex(cookieValue),
        createdAt,
        lastSeenAt: createdAt,
        expiresAt,
        ip: input.ip,
        userAgent: input.userAgent,
        csrfToken,
      },
    };
  }

  /**
   * Looks up a session by its raw cookie value, enforcing both the sliding idle
   * timeout and the absolute cap, and slides the idle window forward on success.
   * Throws rather than returning `undefined` so a route handler cannot forget to
   * check the result.
   */
  validateSession(cookieValue: string): SessionRecord {
    const id = sha256Hex(cookieValue);
    const row = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = @id', { id });
    const now = this.now();

    if (row === undefined) {
      throw new SessionExpiredError();
    }

    const security = this.config.get('security');
    const idleDeadline = row.last_seen_at + security.sessionIdleMin * 60;
    if (now > idleDeadline || now > row.expires_at) {
      this.db.run('DELETE FROM sessions WHERE id = @id', { id });
      this.authLog.failure({
        username: ADMIN_USERNAME,
        ip: row.ip ?? 'unknown',
        reason: 'session_expired',
      });
      throw new SessionExpiredError();
    }

    this.db.run('UPDATE sessions SET last_seen_at = @now WHERE id = @id', { id, now });
    return toSessionRecord({ ...row, last_seen_at: now });
  }

  /** Double-submit CSRF check for a mutating request. Throws rather than returning a bool. */
  verifyCsrf(session: SessionRecord, presentedToken: string | undefined): void {
    if (presentedToken === undefined || !secretsEqual(presentedToken, session.csrfToken)) {
      this.authLog.failure({
        username: ADMIN_USERNAME,
        ip: session.ip ?? 'unknown',
        reason: 'csrf_invalid',
      });
      throw new InvalidCsrfError();
    }
  }

  toSessionInfo(session: SessionRecord): SessionInfo {
    return {
      username: ADMIN_USERNAME,
      csrfToken: session.csrfToken,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      ip: session.ip,
      setupRequired: !this.config.getFlag<boolean>('setup.completed', false),
    };
  }

  logout(cookieValue: string): void {
    const id = sha256Hex(cookieValue);
    const row = this.db.get<SessionRow>('SELECT ip FROM sessions WHERE id = @id', { id });
    this.db.run('DELETE FROM sessions WHERE id = @id', { id });
    if (row !== undefined) {
      this.authLog.logout({ username: ADMIN_USERNAME, ip: row.ip ?? 'unknown' });
    }
  }

  /** Called after a password change — every other session must stop working immediately. */
  revokeAllSessions(): number {
    const result = this.db.run('DELETE FROM sessions');
    return result.changes;
  }

  /** Sweeps rows past their absolute expiry. Sessions past only the idle window are
   * left for {@link validateSession} to reap lazily on next use — no clock is running
   * just to delete a row nobody is trying to use anyway. */
  pruneExpiredSessions(): number {
    const result = this.db.run('DELETE FROM sessions WHERE expires_at <= @now', {
      now: this.now(),
    });
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // API tokens
  // -------------------------------------------------------------------------

  createToken(name: string, scopes: readonly TokenScope[]): CreateTokenResult {
    const value = `${TOKEN_PREFIX}${randomBytes(TOKEN_VALUE_BYTES).toString('base64url')}`;
    const createdAt = this.now();
    const result = this.db.run(
      `INSERT INTO api_tokens (name, token_hash, scopes, created_at) VALUES (@name, @hash, @scopes, @createdAt)`,
      { name, hash: sha256Hex(value), scopes: JSON.stringify(scopes), createdAt },
    );
    const row = this.db.get<ApiTokenRow>('SELECT * FROM api_tokens WHERE id = @id', {
      id: Number(result.lastInsertRowid),
    });
    if (row === undefined) {
      throw new AuthError('API token row disappeared immediately after insert');
    }
    return { token: toApiToken(row), value };
  }

  listTokens(): ApiToken[] {
    return this.db
      .all<ApiTokenRow>('SELECT * FROM api_tokens ORDER BY created_at DESC, id DESC')
      .map(toApiToken);
  }

  revokeToken(id: number): void {
    this.db.run('UPDATE api_tokens SET revoked_at = @now WHERE id = @id AND revoked_at IS NULL', {
      id,
      now: this.now(),
    });
  }

  /** Validates a bearer/API-key value and records its use. Read-only by construction
   * (every stored scope list is `['read']` today — see {@link TokenScope}). */
  validateToken(rawValue: string): ApiToken {
    const row = this.db.get<ApiTokenRow>(
      'SELECT * FROM api_tokens WHERE token_hash = @hash AND revoked_at IS NULL',
      { hash: sha256Hex(rawValue) },
    );
    if (row === undefined) {
      this.authLog.failure({ username: ADMIN_USERNAME, ip: 'unknown', reason: 'invalid_token' });
      throw new InvalidTokenError();
    }
    this.db.run('UPDATE api_tokens SET last_used_at = @now WHERE id = @id', {
      id: row.id,
      now: this.now(),
    });
    return toApiToken({ ...row, last_used_at: this.now() });
  }

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  private assertNotRateLimited(ipKey: string): void {
    const nowMs = Date.now();
    const entry = this.attempts.get(ipKey);
    if (entry === undefined || nowMs - entry.windowStart > LOGIN_WINDOW_MS) {
      return;
    }
    const max = this.config.get('security').loginMaxAttempts;
    if (entry.count >= max) {
      const retryAfterSeconds = Math.ceil((entry.windowStart + LOGIN_WINDOW_MS - nowMs) / 1000);
      this.authLog.lockout({ username: ADMIN_USERNAME, ip: ipKey });
      throw new RateLimitedError(Math.max(retryAfterSeconds, 1));
    }
  }

  private recordFailure(ipKey: string): void {
    const nowMs = Date.now();
    const entry = this.attempts.get(ipKey);
    if (entry === undefined || nowMs - entry.windowStart > LOGIN_WINDOW_MS) {
      this.attempts.set(ipKey, { count: 1, windowStart: nowMs });
      return;
    }
    entry.count += 1;
  }

  private logFailure(input: LoginInput, reason: AuthFailureReason): void {
    this.authLog.failure({ username: input.username, ip: input.ip ?? 'unknown', reason });
    this.logger?.warn({ ip: input.ip, reason }, 'login attempt rejected');
  }
}
