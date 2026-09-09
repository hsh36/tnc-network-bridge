import { type ShareSmbVersion } from '../../shared';
import { useTranslation } from '../hooks/useTranslation';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Checkbox, Input, Select } from './ui/Input';

/**
 * The two ends of a share, side by side.
 *
 * A share is a pairing, not a single thing: an export on the corporate server, and a
 * name the machines see on the SMB1 side. The form said so nowhere — it exposed the
 * server path and nothing about what the TNC end looks like — so an operator could not
 * tell which of the two a given field belonged to.
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

export function ShareSides({
  value,
  onChange,
  nameEditable,
  errors = {},
  passwordStored = false,
}: ShareSidesProps): JSX.Element {
  const t = useTranslation('shares');

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
        </CardBody>
      </Card>
    </div>
  );
}
