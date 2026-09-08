import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setCsrfToken, UnauthenticatedError } from './api-client';

/**
 * The typed client is the one place every page in this app talks to the backend, so
 * its envelope handling, CSRF header injection and error mapping are worth testing in
 * isolation rather than only incidentally through page tests.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api()', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    setCsrfToken(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the unwrapped data on a successful envelope', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ ok: true, data: { username: 'admin', csrfToken: 'x', createdAt: 0, expiresAt: 0, ip: null, setupRequired: false } }),
    );
    const data = await api('auth.session');
    expect(data.username).toBe('admin');
  });

  it('builds path params and query strings into the URL', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true, data: { items: [], total: 0, limit: 50, offset: 0 } }));
    await api('locks.list', { query: { limit: 50, offset: 0, includeReleased: true } });
    const calledUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/api/v1/locks');
    expect(calledUrl).toContain('includeReleased=true');
  });

  it('sends the CSRF header on a mutating endpoint once a token is set', async () => {
    setCsrfToken('csrf-value');
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true, data: { acknowledged: true } }));
    await api('auth.logout');
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('csrf-value');
  });

  it('omits the CSRF header for a non-mutating endpoint', async () => {
    setCsrfToken('csrf-value');
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true, data: { items: [], total: 0, limit: 50, offset: 0 } }));
    await api('locks.list', { query: {} });
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBeUndefined();
  });

  it('throws ApiError with the server-provided code and message on failure', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'bad input' } }, 400),
    );
    await expect(api('auth.login', { body: { username: '', password: '' } })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'bad input',
    });
  });

  it('throws UnauthenticatedError specifically on a 401', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'no session' } }, 401),
    );
    await expect(api('auth.session')).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('falls back to a generic ApiError when the response body is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('not json', { status: 500 }));
    await expect(api('auth.session')).rejects.toBeInstanceOf(ApiError);
  });
});
