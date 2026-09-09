import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { type SetupStatus } from '../../shared';
import { api } from '../lib/api-client';

/**
 * Whether the first-run wizard still has to run.
 *
 * `setup.status` is a public endpoint precisely so this can be answered before there is
 * a session — the whole point of the wizard is that no password exists yet.
 *
 * A failed fetch resolves to "completed". Guessing the other way would trap an operator
 * in the wizard whenever the request happened to fail, and the wizard is the one screen
 * that hands out the admin password; a transient network error must not be a route to it.
 */

interface SetupContextValue {
  readonly status: SetupStatus | undefined;
  readonly loading: boolean;
  /** Re-reads the status. Called once the wizard finishes so the gate reopens the app. */
  readonly refresh: () => Promise<void>;
}

const SetupContext = createContext<SetupContextValue | undefined>(undefined);

const COMPLETED: SetupStatus = {
  completed: true,
  currentStep: 'review',
  completedSteps: [],
};

export function SetupProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<SetupStatus>();
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api('setup.status'));
    } catch {
      setStatus(COMPLETED);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SetupContextValue>(
    () => ({ status, loading, refresh }),
    [status, loading, refresh],
  );

  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
}

export function useSetupStatus(): SetupContextValue {
  const ctx = useContext(SetupContext);
  if (ctx === undefined) {
    throw new Error('useSetupStatus() must be used inside <SetupProvider>');
  }
  return ctx;
}
