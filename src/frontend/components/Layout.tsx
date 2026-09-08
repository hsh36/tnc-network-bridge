import { type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { PRODUCT_NAME } from '../../shared';
import { useAuth } from '../hooks/useAuth';
import { Button } from './ui/Button';
import { ThemeToggle } from './ui/ThemeToggle';
import { cn } from './ui/cn';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/locks', label: 'Locks' },
  { to: '/machines', label: 'Machines' },
  { to: '/files', label: 'Files' },
  { to: '/monitoring', label: 'Monitoring' },
  { to: '/versions', label: 'Versions' },
  { to: '/scheduling', label: 'Scheduling' },
  { to: '/system-updates', label: 'Updates' },
  { to: '/config', label: 'Configuration' },
  { to: '/logs', label: 'Logs' },
] as const;

export function Layout({ children }: { readonly children: ReactNode }): JSX.Element {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = (): void => {
    void logout().then(() => navigate('/login', { replace: true }));
  };

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-border bg-white md:w-56 md:border-b-0 md:border-r dark:border-border-dark dark:bg-surface-dark-subtle">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="text-lg" aria-hidden="true">
            🌉
          </span>
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {PRODUCT_NAME}
          </span>
        </div>
        <nav className="flex flex-1 flex-row gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              className={({ isActive }) =>
                cn(
                  'whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 dark:border-border-dark">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-slate-700 dark:text-slate-300">
              {session?.username ?? '—'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              Log out
            </Button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
    </div>
  );
}
