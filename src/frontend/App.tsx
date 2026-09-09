import { type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { FullPageSpinner } from './components/ui/Spinner';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { SetupProvider, useSetupStatus } from './hooks/useSetupStatus';
import { ConfigPage } from './pages/ConfigPage';
import { Dashboard } from './pages/Dashboard';
import { FilesBrowserPage } from './pages/FilesBrowserPage';
import { LocksConflictsPage } from './pages/LocksConflictsPage';
import { Login } from './pages/Login';
import { Logs } from './pages/Logs';
import { Machines } from './pages/Machines';
import { MonitoringPage } from './pages/MonitoringPage';
import { Scheduling } from './pages/Scheduling';
import { Setup } from './pages/Setup';
import { SystemUpdates } from './pages/SystemUpdates';
import { Versions } from './pages/Versions';

const SETUP_PATH = '/setup';

/** Redirects to `/login` when there is no session, preserving the intended route (T32's AC). */
function RequireAuth({ children }: { readonly children: ReactNode }): JSX.Element {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <FullPageSpinner />;
  }
  if (session === undefined) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }
  return <Layout>{children}</Layout>;
}

/**
 * Sends every route to the wizard until setup is finished, and keeps it out of reach
 * afterwards.
 *
 * This sits above the auth guard rather than beside it: before the wizard runs there is
 * no password to sign in with, so `/login` is a dead end and redirecting there would
 * strand the operator. It renders nothing of its own once setup is complete.
 */
function SetupGate({ children }: { readonly children: ReactNode }): JSX.Element {
  const { status, loading } = useSetupStatus();
  const location = useLocation();

  if (loading) {
    return <FullPageSpinner />;
  }

  const onSetupRoute = location.pathname === SETUP_PATH;
  const pending = status !== undefined && !status.completed;

  if (pending && !onSetupRoute) {
    return <Navigate to={SETUP_PATH} replace />;
  }
  if (!pending && onSetupRoute) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route path={SETUP_PATH} element={<Setup />} />
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/locks"
        element={
          <RequireAuth>
            <LocksConflictsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/machines"
        element={
          <RequireAuth>
            <Machines />
          </RequireAuth>
        }
      />
      <Route
        path="/files"
        element={
          <RequireAuth>
            <FilesBrowserPage />
          </RequireAuth>
        }
      />
      <Route
        path="/monitoring"
        element={
          <RequireAuth>
            <MonitoringPage />
          </RequireAuth>
        }
      />
      <Route
        path="/versions"
        element={
          <RequireAuth>
            <Versions />
          </RequireAuth>
        }
      />
      <Route
        path="/scheduling"
        element={
          <RequireAuth>
            <Scheduling />
          </RequireAuth>
        }
      />
      <Route
        path="/config"
        element={
          <RequireAuth>
            <ConfigPage />
          </RequireAuth>
        }
      />
      <Route
        path="/logs"
        element={
          <RequireAuth>
            <Logs />
          </RequireAuth>
        }
      />
      <Route
        path="/system-updates"
        element={
          <RequireAuth>
            <SystemUpdates />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <SetupProvider>
          <AuthProvider>
            <SetupGate>
              <AppRoutes />
            </SetupGate>
          </AuthProvider>
        </SetupProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
