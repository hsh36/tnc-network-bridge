import { type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { FullPageSpinner } from './components/ui/Spinner';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ConfigPage } from './pages/ConfigPage';
import { Dashboard } from './pages/Dashboard';
import { FilesBrowserPage } from './pages/FilesBrowserPage';
import { LocksConflictsPage } from './pages/LocksConflictsPage';
import { Login } from './pages/Login';
import { Logs } from './pages/Logs';
import { Machines } from './pages/Machines';
import { MonitoringPage } from './pages/MonitoringPage';
import { Scheduling } from './pages/Scheduling';
import { SystemUpdates } from './pages/SystemUpdates';
import { Versions } from './pages/Versions';

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

function AppRoutes(): JSX.Element {
  return (
    <Routes>
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
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
