import { useCallback, useEffect, useState } from 'react';

import { API_BASE_PATH, type CertificateInfo } from '../../shared';
import { useTranslation } from '../hooks/useTranslation';
import { ApiError, api } from '../lib/api-client';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Input, Textarea } from './ui/Input';

/**
 * The TLS certificate the admin interface itself is served with.
 *
 * Both actions replace the certificate of the page the operator is looking at, so the
 * browser drops the connection mid-response and reconnects on the new one. That is
 * expected and unavoidable — it is said plainly in the UI rather than left to look like
 * a crash, and it is why the backend validates and hot-swaps before it writes anything.
 */

const DAYS_SOON = 30;

function expiryTone(days: number): 'ok' | 'warn' | 'error' {
  if (days <= 0) return 'error';
  return days <= DAYS_SOON ? 'warn' : 'ok';
}

export function CertificateManager(): JSX.Element {
  const t = useTranslation('security');
  const [info, setInfo] = useState<CertificateInfo>();
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<'regenerate' | 'upload'>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const [showUpload, setShowUpload] = useState(false);
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [chainPem, setChainPem] = useState('');
  const [sans, setSans] = useState('');
  const [validityYears, setValidityYears] = useState(10);

  const load = useCallback(async () => {
    try {
      setInfo(await api('certificates.get'));
      setMissing(false);
    } catch (err) {
      // 404 is a state, not a failure: a bridge whose certificate has been removed
      // should offer to make one, not show a red banner.
      if (err instanceof ApiError && err.status === 404) {
        setInfo(undefined);
        setMissing(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : t('load_error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const finish = (next: CertificateInfo): void => {
    setInfo(next);
    setMissing(false);
    setNotice(t('replaced_notice'));
    setShowUpload(false);
    setCertPem('');
    setKeyPem('');
    setChainPem('');
  };

  const fail = (err: unknown): void => {
    // The backend guarantees nothing changed on a rejection, so the message can say so
    // without hedging.
    setError(err instanceof ApiError ? err.message : t('install_error'));
  };

  const regenerate = (): void => {
    setError(undefined);
    setNotice(undefined);
    setBusy('regenerate');
    api('certificates.regenerate', {
      body: {
        validityYears,
        additionalSans: sans
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      },
    })
      .then(finish)
      .catch(fail)
      .finally(() => setBusy(undefined));
  };

  const upload = (): void => {
    setError(undefined);
    setNotice(undefined);
    setBusy('upload');
    api('certificates.upload', {
      body: {
        certPem,
        keyPem,
        ...(chainPem.trim() === '' ? {} : { chainPem }),
      },
    })
      .then(finish)
      .catch(fail)
      .finally(() => setBusy(undefined));
  };

  return (
    <Card>
      <CardHeader title={t('certificate_title')} subtitle={t('certificate_subtitle')} />
      <CardBody className="flex flex-col gap-4">
        {info !== undefined && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Field label={t('cert_subject')} value={info.subject} />
            <Field label={t('cert_issuer')} value={info.issuer} />
            <Field
              label={t('cert_expires')}
              value={
                <span className="flex items-center gap-2">
                  {new Date(info.notAfter * 1000).toLocaleDateString()}
                  <Badge tone={expiryTone(info.daysUntilExpiry)}>
                    {info.daysUntilExpiry <= 0
                      ? t('cert_expired')
                      : t('cert_days_left', { days: info.daysUntilExpiry })}
                  </Badge>
                </span>
              }
            />
            <Field
              label={t('cert_type')}
              value={info.selfSigned ? t('cert_self_signed') : t('cert_ca_signed')}
            />
            <Field
              label={t('cert_sans')}
              value={info.subjectAltNames.join(', ')}
              className="sm:col-span-2"
            />
            <Field
              label={t('cert_fingerprint')}
              value={<span className="font-mono text-xs">{info.fingerprintSha256}</span>}
              className="sm:col-span-2"
            />
          </dl>
        )}

        {missing && <p className="text-sm text-slate-600 dark:text-slate-400">{t('cert_none')}</p>}

        <p className="rounded-md border border-status-warn/40 bg-status-warn/5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300">
          {t('reconnect_warning')}
        </p>

        {notice !== undefined && (
          <p className="text-sm text-status-ok" role="status">
            {notice}
          </p>
        )}
        {error !== undefined && (
          <p className="text-sm text-status-error" role="alert">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3 border-t border-border pt-4 dark:border-border-dark">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('self_signed_title')}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('self_signed_hint')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              id="certValidity"
              label={t('validity_years')}
              type="number"
              min={1}
              max={20}
              value={validityYears}
              onChange={(e) => setValidityYears(Number(e.target.value))}
            />
            <Input
              id="certSans"
              label={t('additional_sans')}
              hint={t('additional_sans_hint')}
              value={sans}
              onChange={(e) => setSans(e.target.value)}
            />
          </div>
          <Button
            className="w-fit"
            loading={busy === 'regenerate'}
            disabled={busy !== undefined}
            onClick={regenerate}
          >
            {t('regenerate_button')}
          </Button>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-4 dark:border-border-dark">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('download_title')}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('download_hint')}</p>
          {/*
            A plain link, not an api() call. The browser has the session cookie and knows
            how to save a file; routing the bytes through fetch and a blob would add a
            copy in memory and a second way for it to go wrong.
          */}
          <a
            className="w-fit rounded-md border border-border px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 dark:border-border-dark dark:text-slate-100 dark:hover:bg-slate-800"
            href={`${API_BASE_PATH}/certificates/download`}
            download="tnc-bridge-cert.pem"
          >
            {t('download_button')}
          </a>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-4 dark:border-border-dark">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('upload_title')}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('upload_hint')}</p>
          {showUpload ? (
            <>
              <Textarea
                id="certPem"
                label={t('cert_pem')}
                rows={6}
                className="font-mono text-xs"
                placeholder="-----BEGIN CERTIFICATE-----"
                value={certPem}
                onChange={(e) => setCertPem(e.target.value)}
              />
              <Textarea
                id="keyPem"
                label={t('key_pem')}
                rows={6}
                className="font-mono text-xs"
                placeholder="-----BEGIN PRIVATE KEY-----"
                value={keyPem}
                onChange={(e) => setKeyPem(e.target.value)}
              />
              <Textarea
                id="chainPem"
                label={t('chain_pem')}
                hint={t('chain_pem_hint')}
                rows={4}
                className="font-mono text-xs"
                value={chainPem}
                onChange={(e) => setChainPem(e.target.value)}
              />
              <div className="flex items-center gap-3">
                <Button
                  className="w-fit"
                  loading={busy === 'upload'}
                  disabled={busy !== undefined || certPem.trim() === '' || keyPem.trim() === ''}
                  onClick={upload}
                >
                  {t('install_button')}
                </Button>
                <Button variant="ghost" className="w-fit" onClick={() => setShowUpload(false)}>
                  {t('cancel_button')}
                </Button>
              </div>
            </>
          ) : (
            <Button variant="ghost" className="w-fit" onClick={() => setShowUpload(true)}>
              {t('upload_button')}
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function Field({
  label,
  value,
  className,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={className}>
      <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  );
}
