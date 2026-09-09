import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PRODUCT_NAME } from '../../shared';
import { ApiError } from '../lib/api-client';
import { useAuth } from '../hooks/useAuth';
import { useTranslation } from '../hooks/useTranslation';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { Input } from '../components/ui/Input';

interface LocationState {
  readonly from?: string;
}

export function Login(): JSX.Element {
  const t = useTranslation('auth');
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    setError(undefined);
    setSubmitting(true);
    void login(username, password)
      .then(() => {
        const state = location.state as LocationState | null;
        void navigate(state?.from ?? '/', { replace: true });
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : t('connection_error'));
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-subtle px-4 dark:bg-surface-dark">
      <Card className="w-full max-w-sm">
        <CardBody className="flex flex-col gap-4">
          <div className="text-center">
            <span className="text-3xl" aria-hidden="true">
              🌉
            </span>
            <h1 className="mt-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
              {PRODUCT_NAME}
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('manage_bridge')}</p>
          </div>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Input
              id="username"
              label={t('username')}
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
            <Input
              id="password"
              label={t('password')}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              error={error}
            />
            <Button type="submit" loading={submitting} className="mt-1">
              {t('sign_in')}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
