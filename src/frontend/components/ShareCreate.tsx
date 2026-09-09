import { useState } from 'react';

import { useTranslation } from '../hooks/useTranslation';
import { ApiError, api } from '../lib/api-client';
import { ShareSides, type ShareSidesValue } from './ShareSides';
import { Button } from './ui/Button';

/**
 * Creating a share.
 *
 * `+ New Share` used to call an empty handler, so there was no way to make one at all.
 * The dialog asks for both ends because a share is both ends: an export on the server
 * and a name the machines mount. Everything else — sync interval, exclusions,
 * bandwidth — has a working default and belongs in the settings dialog afterwards,
 * where an operator can see the share before tuning it.
 */

const EMPTY: ShareSidesValue = {
  name: '',
  serverUnc: '',
  smbDomain: '',
  smbUser: '',
  smbPassword: '',
  smbVersion: '3.1.1',
  smbSeal: true,
  tncGuestOk: true,
};

export function ShareCreate({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: () => void;
}): JSX.Element {
  const t = useTranslation('shares');
  const [value, setValue] = useState<ShareSidesValue>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const change = (patch: Partial<ShareSidesValue>): void =>
    setValue((current) => ({ ...current, ...patch }));

  const submit = (): void => {
    setError(undefined);
    setSaving(true);
    api('shares.create', {
      body: {
        name: value.name.trim(),
        serverUnc: value.serverUnc.trim(),
        // Empty is not the same as unset here: the schema takes null to mean "no
        // per-share account", which is what makes the global one apply.
        smbDomain: value.smbDomain.trim() === '' ? null : value.smbDomain.trim(),
        smbUser: value.smbUser.trim() === '' ? null : value.smbUser.trim(),
        ...(value.smbPassword === '' ? {} : { smbPassword: value.smbPassword }),
        smbVersion: value.smbVersion,
        smbSeal: value.smbSeal,
        tncGuestOk: value.tncGuestOk,
      },
    })
      .then(() => {
        onCreated();
        onClose();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : t('create_error'));
      })
      .finally(() => setSaving(false));
  };

  const incomplete = value.name.trim() === '' || value.serverUnc.trim() === '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-white dark:bg-surface-dark">
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-white p-6 dark:border-border-dark dark:bg-surface-dark">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {t('create_title')}
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('create_subtitle')}</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            aria-label={t('close')}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-6 p-6">
          {error !== undefined && (
            <div className="rounded-md border border-status-error/20 bg-status-error/10 p-3">
              <p className="text-sm text-status-error" role="alert">
                {error}
              </p>
            </div>
          )}

          <ShareSides value={value} onChange={change} nameEditable />

          <div className="flex items-center gap-3">
            <Button onClick={submit} loading={saving} disabled={incomplete || saving}>
              {t('create_button')}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
