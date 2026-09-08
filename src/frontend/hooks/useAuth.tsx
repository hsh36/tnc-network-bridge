import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { type SessionInfo } from '../../shared';
import { api, ApiError, setCsrfToken, UnauthenticatedError } from '../lib/api-client';

/**
 * Session state for the whole app (T32's auth guard).
 *
 * The CSRF token lives only in memory (`setCsrfToken`, in the API client module) —
 * never in `localStorage` — and is refreshed from every response that carries a fresh
 * `SessionInfo`, matching the double-submit scheme T28 implements server-side.
 */

interface AuthContextValue {
  readonly session: SessionInfo | undefined;
  readonly loading: boolean;
  readonly login: (username: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<SessionInfo>();
  const [loading, setLoading] = useState(true);

  const applySession = useCallback((info: SessionInfo) => {
    setSession(info);
    setCsrfToken(info.csrfToken);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const info = await api('auth.session');
      applySession(info);
    } catch (err) {
      if (err instanceof UnauthenticatedError || err instanceof ApiError) {
        setSession(undefined);
        setCsrfToken(undefined);
      } else {
        throw err;
      }
    } finally {
      setLoading(false);
    }
  }, [applySession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      const info = await api('auth.login', { body: { username, password } });
      applySession(info);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await api('auth.logout');
    } finally {
      setSession(undefined);
      setCsrfToken(undefined);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ session, loading, login, logout, refresh }),
    [session, loading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) {
    throw new Error('useAuth() must be used inside <AuthProvider>');
  }
  return ctx;
}
