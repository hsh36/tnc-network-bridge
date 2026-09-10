import { useEffect, useState } from 'react';

import { type SmbConfig } from '../../shared';
import { useTranslation } from '../hooks/useTranslation';
import { ApiError, api } from '../lib/api-client';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Checkbox, Input, Select } from './ui/Input';

/**
 * The Samba settings that cannot be per-share, shown where they belong.
 *
 * These four were asked for in the share dialog, and they cannot go there: `workgroup`,
 * `dos charset`, `ntlm auth` and the protocol range are `[global]` parameters in
 * smb.conf. Samba reads one value per server, not one per stanza — putting them in the
 * share dialog would mean four shares each showing a setting that silently applies to
 * all of them, and whichever was saved last would win.
 *
 * So they sit in the TNC zone of the network page instead, next to the SMB server name,
 * which is the other thing that describes the machine-facing side as a whole. The share
 * dialog keeps only what is genuinely per share: who may connect to it, and with what
 * password.
 *
 * Everything here describes the TNC leg, so it is folded away by default — a shop that
 * accepts the defaults never needs to open it.
 */
export function TncSmbGlobals(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<SmbConfig>();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api('config.get', { params: { section: 'smb' } })
      .then((data) => setForm(data as unknown as SmbConfig))
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : t('load_error'));
      });
  }, [t]);

  if (form === undefined) {
    return <p className="text-xs text-slate-500 dark:text-slate-400">{t('loading')}</p>;
  }

  const setTnc = (patch: Partial<SmbConfig['tnc']>): void => {
    setForm({ ...form, tnc: { ...form.tnc, ...patch } });
    setDirty(true);
    setSaved(false);
  };

  const save = (): void => {
    setSaving(true);
    setError(undefined);
    api('config.update', { params: { section: 'smb' }, body: form })
      .then((data) => {
        setForm(data as unknown as SmbConfig);
        setDirty(false);
        setSaved(true);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : t('save_error'));
      })
      .finally(() => setSaving(false));
  };

  return (
    <details className="rounded-md border border-border dark:border-border-dark">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-300">
        {t('tnc_smb_title')}
      </summary>
      <div className="flex flex-col gap-4 border-t border-border p-3 dark:border-border-dark">
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('tnc_smb_hint')}</p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            id="tncMinProtocol"
            label={t('minimum_protocol')}
            value={form.tnc.minProtocol}
            onChange={(e) => setTnc({ minProtocol: e.target.value as 'NT1' | 'SMB2' | 'SMB3' })}
          >
            <option value="NT1">NT1 (SMB 1)</option>
            <option value="SMB2">SMB 2</option>
            <option value="SMB3">SMB 3</option>
          </Select>
          <Select
            id="tncMaxProtocol"
            label={t('maximum_protocol')}
            value={form.tnc.maxProtocol}
            onChange={(e) => setTnc({ maxProtocol: e.target.value as 'NT1' | 'SMB2' | 'SMB3' })}
          >
            <option value="NT1">NT1 (SMB 1)</option>
            <option value="SMB2">SMB 2</option>
            <option value="SMB3">SMB 3</option>
          </Select>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            id="tncWorkgroup"
            label={t('workgroup')}
            hint={t('workgroup_hint')}
            value={form.tnc.workgroup}
            onChange={(e) => setTnc({ workgroup: e.target.value })}
          />
          <Input
            id="tncDosCharset"
            label={t('dos_charset')}
            hint={t('dos_charset_hint')}
            value={form.tnc.dosCharset}
            onChange={(e) => setTnc({ dosCharset: e.target.value })}
          />
        </div>

        <Checkbox
          id="tncNtlmAuth"
          label={t('enable_ntlm')}
          checked={form.tnc.ntlmAuth}
          onChange={(e) => setTnc({ ntlmAuth: e.target.checked })}
        />

        <div className="flex items-center gap-3">
          <Button size="sm" className="w-fit" loading={saving} disabled={!dirty} onClick={save}>
            {t('save_button')}
          </Button>
          {saved && <Badge tone="ok">{t('saved_message')}</Badge>}
        </div>

        {error !== undefined && (
          <p className="text-sm text-status-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
