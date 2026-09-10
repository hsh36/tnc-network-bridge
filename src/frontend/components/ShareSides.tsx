import { useState } from 'react';

import { type ShareSmbVersion } from '../../shared';
import { useTranslation } from '../hooks/useTranslation';
import { ApiError, api } from '../lib/api-client';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Checkbox, Input, Select } from './ui/Input';

/**
 * The two ends of a share, side by side.
 *
 * A share is a pairing, not a single thing: an export on the corporate server, and a
 * name the machines see on the SMB1 side. Each end now carries its own credentials,
 * because they are credentials in opposite directions — one reaches the file server,
 * one lets a shop-floor control in — and conflating them is how a service account's
 * password ends up on a machine.
 *
 * Everything that has a working default sits behind "Advanced". The two things an
 * operator must decide are the server path and the share name; making them scroll past
 * a dialect selector to reach the field they came for is how a create dialog gets
 * abandoned.
 *
 * Shared by the create dialog and the settings dialog so the two cannot drift.
 */

export interface ShareSidesValue {
  readonly name: string;
  readonly serverUnc: string;
  readonly smbDomain: string;
  readonly smbUser: string;
  readonly smbPassword: string;
  readonly smbVersion: ShareSmbVersion;
  readonly smbSeal: boolean;
  readonly tncGuestOk: boolean;
  readonly tncUser: string;
  readonly tncPassword: string;
}

export interface ShareSidesProps {
  readonly value: ShareSidesValue;
  readonly onChange: (patch: Partial<ShareSidesValue>) => void;
  /** The name owns the mount point, the cache path and the Samba section, so it is
   * settable only at creation; renaming is delete-and-recreate. */
  readonly nameEditable: boolean;
  readonly errors?: Record<string, string>;
  /** True once a password is stored, so the field can offer "leave unchanged". */
  readonly passwordStored?: boolean;
}

/**
 * A section folded away until asked for.
 *
 * `<details>` rather than state and a chevron: it is keyboard-accessible, it survives
 * a re-render without a hook, and the browser already knows how to draw it.
 */
function Advanced({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <details className="rounded-md border border-border dark:border-border-dark">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-300">
        {title}
      </summary>
      <div className="flex flex-col gap-4 border-t border-border p-3 dark:border-border-dark">
        {children}
      </div>
    </details>
  );
}

export function ShareSides({
  value,
  onChange,
  nameEditable,
  errors = {},
  passwordStored = false,
}: ShareSidesProps): JSX.Element {
  const t = useTranslation('shares');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string }>();

  const test = (): void => {
    setTestResult(undefined);
    setTesting(true);
    api('config.testSmb', {
      body: {
        unc: value.serverUnc.trim(),
        ...(value.smbDomain.trim() === '' ? {} : { domain: value.smbDomain.trim() }),
        ...(value.smbUser.trim() === '' ? {} : { username: value.smbUser.trim() }),
        ...(value.smbPassword === '' ? {} : { password: value.smbPassword }),
        smbVersion: value.smbVersion,
        seal: value.smbSeal,
      },
    })
      .then((result) => {
        setTestResult({
          ok: result.success,
          // The tester classifies the failure into something actionable rather than
          // passing smbclient's output through, and it already speaks both languages.
          message: result.success
            ? t('test_ok', { dialect: result.dialect ?? '?' })
            : [result.message.de, result.remediation?.de].filter(Boolean).join(' '),
        });
      })
      .catch((err: unknown) => {
        setTestResult({
          ok: false,
          message: err instanceof ApiError ? err.message : t('test_error'),
        });
      })
      .finally(() => setTesting(false));
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title={t('lan_side')} subtitle={t('lan_side_hint')} />
        <CardBody className="flex flex-col gap-4">
          <Input
            id="shareServerUnc"
            label={t('server_unc')}
            hint={t('server_unc_hint')}
            placeholder="//fileserver/cnc$/programs"
            value={value.serverUnc}
            onChange={(e) => onChange({ serverUnc: e.target.value })}
            error={errors.serverUnc}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              id="shareSmbDomain"
              label={t('smb_domain')}
              value={value.smbDomain}
              onChange={(e) => onChange({ smbDomain: e.target.value })}
            />
            <Input
              id="shareSmbUser"
              label={t('smb_user')}
              value={value.smbUser}
              onChange={(e) => onChange({ smbUser: e.target.value })}
            />
          </div>
          <Input
            id="shareSmbPassword"
            label={t('smb_password')}
            type="password"
            autoComplete="new-password"
            // Empty means "use the global service account", which is a different thing
            // from "unchanged" — the hint has to distinguish them or an operator
            // clearing the field would not know which they were doing.
            hint={passwordStored ? t('smb_password_stored') : t('smb_password_hint')}
            value={value.smbPassword}
            onChange={(e) => onChange({ smbPassword: e.target.value })}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="secondary"
              className="w-fit"
              loading={testing}
              disabled={value.serverUnc.trim() === '' || testing}
              onClick={test}
            >
              {t('test_button')}
            </Button>
            {testResult && (
              <Badge tone={testResult.ok ? 'ok' : 'error'}>
                {testResult.ok ? t('test_reachable') : t('test_failed')}
              </Badge>
            )}
          </div>
          {testResult && (
            <p
              className={
                testResult.ok
                  ? 'text-xs text-slate-600 dark:text-slate-400'
                  : 'text-xs text-status-error'
              }
              role="status"
            >
              {testResult.message}
            </p>
          )}
          {/* The probe lists and connects; it does not write. This runs against a live
              production share from a form the operator may still be typing into. */}
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('test_hint')}</p>

          <Advanced title={t('advanced')}>
            <Select
              id="shareSmbVersion"
              label={t('smb_version')}
              value={value.smbVersion}
              onChange={(e) => onChange({ smbVersion: e.target.value as ShareSmbVersion })}
            >
              <option value="3.1.1">SMB 3.1.1</option>
              <option value="3.0">SMB 3.0</option>
              <option value="2.1">SMB 2.1</option>
            </Select>
            <Checkbox
              id="shareSmbSeal"
              label={t('smb_seal')}
              checked={value.smbSeal}
              onChange={(e) => onChange({ smbSeal: e.target.checked })}
            />
          </Advanced>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('tnc_side')} subtitle={t('tnc_side_hint')} />
        <CardBody className="flex flex-col gap-4">
          <Input
            id="shareName"
            label={t('share_name')}
            hint={nameEditable ? t('share_name_hint') : t('share_name_locked')}
            placeholder="programs"
            value={value.name}
            disabled={!nameEditable}
            onChange={(e) => onChange({ name: e.target.value })}
            error={errors.name}
          />
          {value.name !== '' && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('tnc_path_preview', { name: value.name })}
            </p>
          )}

          <Checkbox
            id="shareTncGuestOk"
            label={t('tnc_guest_ok')}
            checked={value.tncGuestOk}
            onChange={(e) => onChange({ tncGuestOk: e.target.checked })}
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('tnc_guest_ok_hint')}</p>

          {/* Shown only when guest access is off, because `valid users` alongside
              `guest ok = yes` is a contradiction Samba resolves in favour of the guest —
              the account would be silently decorative. */}
          {!value.tncGuestOk && (
            <>
              <Input
                id="shareTncUser"
                label={t('tnc_user')}
                hint={t('tnc_user_hint')}
                autoComplete="off"
                value={value.tncUser}
                onChange={(e) => onChange({ tncUser: e.target.value })}
                error={errors.tncUser}
              />
              <Input
                id="shareTncPassword"
                label={t('tnc_password')}
                type="password"
                autoComplete="new-password"
                hint={passwordStored ? t('tnc_password_stored') : t('tnc_password_hint')}
                value={value.tncPassword}
                onChange={(e) => onChange({ tncPassword: e.target.value })}
              />
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
