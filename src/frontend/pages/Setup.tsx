import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PRODUCT_NAME } from '../../shared';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { useAuth } from '../hooks/useAuth';
import { useSetupStatus } from '../hooks/useSetupStatus';
import { useTranslation } from '../hooks/useTranslation';
import { ApiError, api } from '../lib/api-client';

/**
 * The first-run wizard.
 *
 * Two things make this screen load-bearing rather than cosmetic. `POST /setup/password`
 * is public by necessity — no password exists yet, so nothing could authenticate the
 * call that creates one — and it stays public until `POST /setup/complete` closes it.
 * Only this wizard ever calls `complete`. Without it the endpoint that sets the admin
 * password would remain open to anyone who can reach the bridge, for the life of the
 * appliance.
 *
 * Steps beyond the password are deliberately not reimplemented here. The backend's
 * `setup.step` enum lists network, credentials and shares, but each of those is already
 * a full editor under Settings, driven by the ordinary config API; a second, thinner
 * copy inside the wizard would be one more place for the two to disagree. The wizard
 * therefore sets the password, closes the public endpoint, and hands over.
 */

/** Mirrors `adminPasswordSchema`; checked here only to answer before a round trip. */
const MIN_PASSWORD_LENGTH = 12;

type Phase = 'password' | 'finish';

export function Setup(): JSX.Element {
  const t = useTranslation('setup');
  const { login } = useAuth();
  const { refresh } = useSetupStatus();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('password');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const handlePassword = (event: FormEvent): void => {
    event.preventDefault();
    setError(undefined);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('password_too_short', { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (password !== confirmation) {
      setError(t('passwords_differ'));
      return;
    }

    setSubmitting(true);
    // Setting the password revokes every existing session, so the sign-in that follows
    // is not a convenience: it is how this browser gets a session at all, and the
    // `complete` call below needs one.
    api('setup.password', { body: { password } })
      .then(() => login('admin', password))
      .then(() => {
        setPassword('');
        setConfirmation('');
        setPhase('finish');
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : t('connection_error'));
      })
      .finally(() => setSubmitting(false));
  };

  const handleFinish = (): void => {
    setError(undefined);
    setSubmitting(true);
    api('setup.complete', { body: {} })
      .then(() => refresh())
      .then(() => navigate('/', { replace: true }))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : t('connection_error'));
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-subtle px-4 dark:bg-surface-dark">
      <Card className="w-full max-w-md">
        <CardBody className="flex flex-col gap-4">
          <div className="text-center">
            <span className="text-3xl" aria-hidden="true">
              🌉
            </span>
            <h1 className="mt-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
              {PRODUCT_NAME}
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {phase === 'password' ? t('subtitle') : t('finish_subtitle')}
            </p>
          </div>

          {phase === 'password' ? (
            <form onSubmit={handlePassword} className="flex flex-col gap-3">
              <p className="text-sm text-slate-600 dark:text-slate-400">{t('password_intro')}</p>
              <Input
                id="setup-password"
                label={t('new_password')}
                type="password"
                autoComplete="new-password"
                autoFocus
                hint={t('password_hint', { min: MIN_PASSWORD_LENGTH })}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Input
                id="setup-password-confirm"
                label={t('confirm_password')}
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                required
                error={error}
              />
              <Button type="submit" loading={submitting} className="mt-1">
                {t('set_password')}
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-slate-600 dark:text-slate-400">{t('finish_intro')}</p>
              <p className="text-sm text-slate-600 dark:text-slate-400">{t('finish_next')}</p>
              {error !== undefined && (
                <p className="text-xs text-status-error" role="alert">
                  {error}
                </p>
              )}
              <Button type="button" loading={submitting} onClick={handleFinish} className="mt-1">
                {t('finish')}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
