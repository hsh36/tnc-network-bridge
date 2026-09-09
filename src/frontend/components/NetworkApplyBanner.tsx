import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../hooks/useTranslation';
import { ApiError, api } from '../lib/api-client';
import { Button } from './ui/Button';

/**
 * The countdown for a network change that has not been confirmed yet.
 *
 * This is the screen an operator reaches *after* losing the connection: new address,
 * fresh certificate warning, fresh login — the session cookie is bound to the host, so
 * none of the old session survives a change of address. It therefore has to work from
 * nothing but a page load, which is why the pending change lives in the database rather
 * than in the memory of the process that may well have been restarted since.
 *
 * Not confirming is a valid answer. If the new configuration is wrong, the operator
 * simply cannot reach this page, the timer runs out, and the bridge comes back on the
 * address they know.
 */
export function NetworkApplyBanner({
  onConfirmed,
}: {
  readonly onConfirmed?: () => void;
}): JSX.Element | null {
  const t = useTranslation('config');
  const [remaining, setRemaining] = useState<number>();
  const [side, setSide] = useState<'lan' | 'tnc'>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const status = await api('network.pending');
      if (status.pending === null || status.secondsRemaining === null) {
        setRemaining(undefined);
        return;
      }
      setRemaining(status.secondsRemaining);
      // The record is keyed by MAC; the side is what the operator thinks in. Only the
      // one they are connected over can produce a pending change, so LAN is the safe
      // assumption when we cannot tell.
      setSide('lan');
    } catch {
      setRemaining(undefined);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (remaining === undefined) {
      return;
    }
    // Counted down locally rather than re-fetched every second: the server is the
    // authority on when the timer expires, but asking it once a second would put the
    // heaviest load on the interface that is least certain to be working.
    const id = setInterval(() => {
      setRemaining((current) => (current === undefined ? undefined : Math.max(0, current - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [remaining === undefined]);

  if (remaining === undefined || side === undefined) {
    return null;
  }

  const confirm = (): void => {
    setError(undefined);
    setBusy(true);
    api('network.confirm', { body: { side } })
      .then(() => {
        setRemaining(undefined);
        onConfirmed?.();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : t('confirm_error'));
      })
      .finally(() => setBusy(false));
  };

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <div className="rounded-md border border-status-warn/40 bg-status-warn/5 px-4 py-3">
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('pending_title')}</p>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {remaining === 0
          ? t('pending_expired')
          : t('pending_body', {
              time: `${String(minutes)}:${seconds.toString().padStart(2, '0')}`,
            })}
      </p>
      {error !== undefined && (
        <p className="mt-2 text-sm text-status-error" role="alert">
          {error}
        </p>
      )}
      <Button className="mt-3 w-fit" loading={busy} disabled={busy} onClick={confirm}>
        {t('confirm_button')}
      </Button>
    </div>
  );
}
