import { useCallback, useEffect, useState } from 'react';
import {
  type ConflictMode,
  type DhcpConfig,
  type InterfaceDiscovery,
  type LoggingConfig,
  type LockingConfig,
  type MonitoringConfig,
  type NetworkConfig,
  type NetworkSide,
  type SecurityConfig,
  type SyncConfig,
  type UpdatesConfig,
  type VersioningConfig,
  configSectionSchemas,
} from '../../shared';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Checkbox, Input, Select } from '../components/ui/Input';
import { TncSmbGlobals } from '../components/TncSmbGlobals';
import { Tabs } from '../components/ui/Tabs';
import { FullPageSpinner } from '../components/ui/Spinner';
import { CertificateManager } from '../components/CertificateManager';
import { SharesSection } from '../components/SharesSection';
import { useTranslation } from '../hooks/useTranslation';
import { api, ApiError } from '../lib/api-client';

/**
 * A per-section save form with Zod validation, unsaved-changes guard, and
 * test connectivity buttons. Replaces the simpler previous implementation with
 * full T47 scope: network, SMB, AD, sync, locking, versioning, security, updates,
 * logging, monitoring, plus test/connection features.
 */

function useSaveBanner(t: ReturnType<typeof useTranslation>): {
  readonly banner: JSX.Element | null;
  readonly onSaved: () => void;
  readonly onError: (err: unknown) => void;
} {
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' }>();
  useEffect(() => {
    if (message === undefined) return;
    const id = setTimeout(() => setMessage(undefined), 4000);
    return () => clearTimeout(id);
  }, [message]);
  return {
    banner:
      message === undefined ? null : (
        <p
          className={message.tone === 'ok' ? 'text-sm text-status-ok' : 'text-sm text-status-error'}
        >
          {message.text}
        </p>
      ),
    onSaved: () => setMessage({ text: t('saved_message'), tone: 'ok' }),
    onError: (err) =>
      setMessage({
        text: err instanceof ApiError ? err.message : t('save_error'),
        tone: 'error',
      }),
  };
}

/**
 * Validates a config section against its schema and returns validation errors.
 * Returns empty object if valid.
 */
function validateConfigSection<K extends keyof typeof configSectionSchemas>(
  section: K,
  data: unknown,
): Record<string, string> {
  const schema = configSectionSchemas[section];
  const result = schema.safeParse(data);
  if (result.success) return {};

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join('.');
    errors[path || section] = issue.message;
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Network Settings
// ---------------------------------------------------------------------------

/**
 * One side of the bridge, rendered identically for LAN and TNC.
 *
 * A single component rather than two: the sides differ in which network they face, not
 * in what an operator can set, and two near-copies would drift the moment one gained a
 * field. The differences that are real — the TNC side needs no gateway, because this
 * bridge is the gateway there — are the only things branched on.
 */
function NetworkSideFields({
  side,
  value,
  interfaces,
  errors,
  onChange,
}: {
  readonly side: 'lan' | 'tnc';
  readonly value: NetworkSide;
  readonly interfaces: readonly InterfaceDiscovery[];
  readonly errors: Record<string, string>;
  readonly onChange: (next: NetworkSide) => void;
}): JSX.Element {
  const t = useTranslation('config');
  const set = (patch: Partial<NetworkSide>): void => onChange({ ...value, ...patch });
  const err = (field: string): string | undefined => errors[`${side}.${field}`];

  // An interface configured before the NIC was swapped is no longer in the list.
  // Offering it anyway keeps the form honest about what is stored, rather than silently
  // rebinding the side to whichever card happens to sort first.
  const known = interfaces.some((i) => i.name === value.interface);

  return (
    <div className="flex flex-col gap-4">
      <Select
        id={`${side}Interface`}
        label={t('interface_label')}
        value={value.interface}
        onChange={(e) => set({ interface: e.target.value })}
        error={err('interface')}
      >
        {!known && <option value={value.interface}>{value.interface}</option>}
        {interfaces.map((i) => (
          <option key={i.mac} value={i.name}>
            {i.name} — {i.state === 'up' ? t('link_up') : t('link_down')}
            {i.speedMbps === null ? '' : ` · ${String(i.speedMbps)} Mbit/s`}
            {i.driver === null ? '' : ` · ${i.driver}`}
          </option>
        ))}
      </Select>

      {/* Per side because these are two different names, not one setting shown twice:
          on the LAN it is the machine's own hostname, on the TNC side it is the SMB
          server name the machines dial. */}
      <Input
        id={`${side}Hostname`}
        label={side === 'lan' ? t('lan_hostname') : t('tnc_hostname')}
        hint={side === 'lan' ? t('lan_hostname_hint') : t('tnc_hostname_hint')}
        placeholder={t('hostname_placeholder')}
        value={value.hostname}
        onChange={(e) => set({ hostname: e.target.value })}
        error={err('hostname')}
      />

      <Select
        id={`${side}Method`}
        label={t('addressing')}
        value={value.method}
        onChange={(e) => set({ method: e.target.value as NetworkSide['method'] })}
        error={err('method')}
      >
        <option value="dhcp">DHCP</option>
        <option value="static">{t('static')}</option>
      </Select>

      {value.method === 'static' && (
        <>
          <Input
            id={`${side}Address`}
            label={t('address_cidr')}
            placeholder="192.168.1.10/24"
            value={value.address ?? ''}
            onChange={(e) => set({ address: e.target.value === '' ? undefined : e.target.value })}
            error={err('address')}
          />
          {side === 'lan' && (
            <Input
              id={`${side}Gateway`}
              label={t('gateway')}
              placeholder="192.168.1.1"
              value={value.gateway ?? ''}
              onChange={(e) => set({ gateway: e.target.value === '' ? undefined : e.target.value })}
              error={err('gateway')}
            />
          )}
          {/* LAN only. The machine segment is self-contained — a TNC reaches the
              bridge by address and has nothing to resolve — so a resolver here could
              only mislead. The schema refuses one too, rather than trusting the form. */}
          {side === 'lan' && (
            <>
              <Input
                id={`${side}Dns1`}
                label={t('dns_primary')}
                value={value.dns[0] ?? ''}
                onChange={(e) => set({ dns: joinDns(e.target.value, value.dns[1]) })}
                error={err('dns')}
              />
              <Input
                id={`${side}Dns2`}
                label={t('dns_secondary')}
                value={value.dns[1] ?? ''}
                onChange={(e) => set({ dns: joinDns(value.dns[0], e.target.value) })}
              />
            </>
          )}
        </>
      )}

      <Input
        id={`${side}Vlan`}
        label={t('vlan_id')}
        hint={t('vlan_hint')}
        type="number"
        min={1}
        max={4094}
        value={value.vlan ?? ''}
        onChange={(e) => set({ vlan: e.target.value === '' ? null : Number(e.target.value) })}
        error={err('vlan')}
      />

      <Input
        id={`${side}Mtu`}
        label={t('mtu_bytes')}
        type="number"
        min={576}
        max={9000}
        value={value.mtu}
        onChange={(e) => set({ mtu: Number(e.target.value) })}
        error={err('mtu')}
      />

      <Checkbox
        id={`${side}Ipv6`}
        label={t('enable_ipv6')}
        checked={value.ipv6}
        onChange={(e) => set({ ipv6: e.target.checked })}
      />
    </div>
  );
}

/**
 * Keeps the two resolver inputs as one ordered array without letting an empty primary
 * leave a hole: `['', '9.9.9.9']` would fail validation on a field the operator never
 * touched.
 */
function joinDns(primary: string | undefined, secondary: string | undefined): string[] {
  return [primary ?? '', secondary ?? ''].map((s) => s.trim()).filter((s) => s !== '');
}

function NetworkSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<NetworkConfig>();
  const [saved, setSaved] = useState<NetworkConfig>();
  const [interfaces, setInterfaces] = useState<InterfaceDiscovery[]>([]);
  const [busy, setBusy] = useState<'lan' | 'tnc'>();
  const [applyingLan, setApplyingLan] = useState(false);
  const [notice, setNotice] = useState<{ side: 'lan' | 'tnc'; text: string }>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  /**
   * Re-reads the live interface list.
   *
   * Called after every apply, not only on mount. The drift banner compares the stored
   * configuration against the addresses actually on the NIC, and those addresses are
   * exactly what an apply changes — reading them once meant a successful apply left the
   * warning on screen next to a green "applied", which is a worse lie than the one the
   * banner exists to catch.
   *
   * A failure here is not fatal: the picker falls back to showing the stored name, so
   * the section still works on a host whose sysfs cannot be read.
   */
  const loadInterfaces = useCallback(
    () =>
      api('network.interfaces')
        .then((data) => setInterfaces(data.interfaces.map((entry) => entry.discovery)))
        .catch(() => setInterfaces([])),
    [],
  );

  useEffect(() => {
    void api('config.get', { params: { section: 'network' } }).then((data) => {
      setForm(data as NetworkConfig);
      setSaved(data as NetworkConfig);
    });
    void loadInterfaces();
  }, [loadInterfaces]);

  // Dirtiness is per side now, because the buttons are: one zone must not be greyed out
  // because the other has unsaved edits.
  const dirty = (side: 'lan' | 'tnc'): boolean =>
    form !== undefined &&
    saved !== undefined &&
    JSON.stringify(form[side]) !== JSON.stringify(saved[side]);

  /**
   * Is what is stored for this side actually on the interface?
   *
   * A save writes the configuration and *then* applies it. When the apply fails — and
   * it did, on the real appliance, for a whole day — the stored value stays. The form
   * then shows a static address the interface has never had, and nothing says so: the
   * page looks like a correctly configured bridge right up until someone checks with
   * `ip addr`. The comparison is deliberately narrow: only a static address that the
   * NIC does not carry counts as drift, because DHCP is *supposed* to disagree with a
   * blank field.
   */
  const driftedSide = (side: 'lan' | 'tnc'): boolean => {
    if (form === undefined || saved === undefined) {
      return false;
    }
    const desired = saved[side];
    if (desired.method !== 'static' || desired.address === undefined) {
      return false;
    }
    const live = interfaces.find((entry) => entry.name === desired.interface);
    if (live === undefined || live.addresses.length === 0) {
      // Nothing to compare against — an interface the host cannot report on is not
      // evidence of drift, and claiming it would be worse than staying quiet.
      return false;
    }
    return !live.addresses.some((address) => address === desired.address);
  };

  const driftedLan = driftedSide('lan');
  const driftedTnc = driftedSide('tnc');

  const anyDirty = dirty('lan') || dirty('tnc');
  useEffect(() => {
    window.onbeforeunload = anyDirty ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [anyDirty]);

  if (form === undefined || saved === undefined) return <FullPageSpinner />;

  /**
   * Saves the whole section, because `/config/:section` is a full replace.
   *
   * `side` decides what happens *after* the save, not what gets written: saving one
   * zone necessarily carries the other zone's current form values with it, so both are
   * validated either way.
   */
  const saveSide = (side: 'lan' | 'tnc'): void => {
    const validationErrors = validateConfigSection('network', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setBusy(side);
    setNotice(undefined);
    api('config.update', { params: { section: 'network' }, body: form })
      .then((data) => {
        setForm(data as NetworkConfig);
        setSaved(data as NetworkConfig);
        onSaved();
        // The machine segment is applied straight away: this browser is not on it, so
        // there is nothing to lose by acting and nothing for the operator to confirm.
        // The LAN side is the one that can cut this connection and waits for its own
        // button, so a half-typed address cannot take the bridge away.
        if (side === 'tnc') {
          return api('network.apply', { body: { side: 'tnc' } })
            .then(loadInterfaces)
            .then(() => {
              setNotice({ side: 'tnc', text: t('tnc_applied') });
            });
        }
        // One button, so saving applies. Splitting them made the operator press two
        // things to do one thing, and left a saved-but-not-applied state that looks
        // exactly like a working configuration until someone reboots.
        //
        // The safety is not in the second button — it is in the backend, which arms a
        // rollback whenever the change could cut the connection it arrived over and
        // reverts unless it is confirmed from the new address.
        return applyLan();
      })
      .catch(onError)
      .finally(() => setBusy(undefined));
  };

  /** Applies the saved LAN configuration, arming the rollback the backend decides on. */
  const applyLan = (): Promise<void> => {
    setApplyingLan(true);
    return api('network.apply', { body: { side: 'lan' } })
      .then((result) => {
        if (result.status === 'pending_confirmation') {
          setNotice({
            side: 'lan',
            text:
              result.expectedUrl === null
                ? t('lan_pending_dhcp')
                : t('lan_pending', { url: result.expectedUrl }),
          });
          // The banner in the layout picks the pending change up on its own poll.
          return undefined;
        }
        setNotice({ side: 'lan', text: t('lan_applied') });
        return loadInterfaces();
      })
      .catch(onError)
      .finally(() => setApplyingLan(false));
  };

  const update =
    (side: 'lan' | 'tnc') =>
    (next: NetworkSide): void => {
      setForm({ ...form, [side]: next });
    };

  /** The banner that says the stored configuration is not the one in force. */
  const driftFor = (side: 'lan' | 'tnc'): JSX.Element | null => {
    if (!(side === 'lan' ? driftedLan : driftedTnc)) {
      return null;
    }
    const desired = saved?.[side];
    const live = interfaces.find((entry) => entry.name === desired?.interface);
    return (
      <div
        className="rounded-md border border-status-warn/40 bg-status-warn/5 px-3 py-2"
        role="alert"
      >
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('drift_title')}</p>
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
          {t('drift_body', {
            configured: desired?.address ?? '—',
            actual: live?.addresses.join(', ') ?? '—',
          })}
        </p>
      </div>
    );
  };

  const noticeFor = (side: 'lan' | 'tnc'): JSX.Element | null =>
    notice?.side === side ? (
      <p className="text-sm text-status-ok" role="status">
        {notice.text}
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Side by side, LAN left and TNC right, so the asymmetry between the two legs of
          the bridge is visible at a glance rather than inferred from field order.
          Each zone carries its own buttons: the two sides genuinely behave differently
          on save — one applies at once, the other cannot without risking the connection
          — and a single shared button at the bottom made that difference invisible. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-4 rounded-lg border border-border p-4 dark:border-border-dark">
          <header>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('lan_side')}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('lan_side_hint')}</p>
          </header>
          {driftFor('lan')}
          <NetworkSideFields
            side="lan"
            value={form.lan}
            interfaces={interfaces}
            errors={errors}
            onChange={update('lan')}
          />
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4 dark:border-border-dark">
            <Button
              onClick={() => saveSide('lan')}
              loading={busy === 'lan' || applyingLan}
              disabled={(!dirty('lan') && !driftedLan) || busy !== undefined || applyingLan}
              className="w-fit"
            >
              {t('save_and_apply_button')}
            </Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('apply_lan_hint')}</p>
          {noticeFor('lan')}
        </section>

        <section className="flex flex-col gap-4 rounded-lg border border-border p-4 dark:border-border-dark">
          <header>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('tnc_side_title')}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('tnc_side_hint')}</p>
          </header>
          {driftFor('tnc')}
          <NetworkSideFields
            side="tnc"
            value={form.tnc}
            interfaces={interfaces}
            errors={errors}
            onChange={update('tnc')}
          />
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4 dark:border-border-dark">
            <Button
              onClick={() => saveSide('tnc')}
              loading={busy === 'tnc'}
              disabled={(!dirty('tnc') && !driftedTnc) || busy !== undefined}
              className="w-fit"
            >
              {t('save_and_apply_button')}
            </Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('apply_tnc_hint')}</p>
          {noticeFor('tnc')}

          {/* The Samba globals live here rather than in the share dialog, because Samba
              reads one value per server and not one per stanza. See TncSmbGlobals. */}
          <TncSmbGlobals />
        </section>
      </div>

      {banner}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync Behavior
// ---------------------------------------------------------------------------

function SyncSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<SyncConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'sync' } }).then((data) =>
      setForm(data as SyncConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('sync', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'sync' }, body: form })
      .then((data) => {
        setForm(data as SyncConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Select
        id="conflictMode"
        label={t('conflict_mode')}
        value={form.conflictMode}
        onChange={(e) => {
          setForm({ ...form, conflictMode: e.target.value as ConflictMode });
          setIsDirty(true);
        }}
        error={errors.conflictMode}
        className="w-64"
      >
        <option value="last_write_wins">{t('last_write_wins')}</option>
        <option value="tnc_wins">{t('tnc_wins')}</option>
        <option value="server_wins">{t('server_wins')}</option>
      </Select>

      <Input
        id="bandwidthLimit"
        label={t('bandwidth_limit')}
        type="number"
        value={form.bandwidthLimitKbps ?? ''}
        onChange={(e) => {
          setForm({
            ...form,
            bandwidthLimitKbps: e.target.value === '' ? null : Number(e.target.value),
          });
          setIsDirty(true);
        }}
        error={errors.bandwidthLimitKbps}
        className="w-64"
      />

      <Input
        id="maxFileSize"
        label={t('max_file_size')}
        type="number"
        value={form.maxFileSizeMb}
        onChange={(e) => {
          setForm({ ...form, maxFileSizeMb: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.maxFileSizeMb}
        className="w-64"
      />

      <Input
        id="mtimeTolerance"
        label={t('mtime_tolerance')}
        type="number"
        value={form.mtimeToleranceMs}
        onChange={(e) => {
          setForm({ ...form, mtimeToleranceMs: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.mtimeToleranceMs}
        className="w-64"
      />

      <Input
        id="scanInterval"
        label={t('scan_interval')}
        type="number"
        value={form.scanIntervalMs}
        onChange={(e) => {
          setForm({ ...form, scanIntervalMs: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.scanIntervalMs}
        className="w-64"
      />

      <Input
        id="concurrency"
        label={t('concurrency')}
        type="number"
        value={form.concurrency}
        onChange={(e) => {
          setForm({ ...form, concurrency: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.concurrency}
        className="w-40"
      />

      <div>
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {t('exclude_patterns')}
        </label>
        <textarea
          className="mt-1 h-24 w-full rounded-md border border-border bg-white px-3 py-2 text-sm dark:border-border-dark dark:bg-surface-dark"
          value={form.excludePatterns.join('\n')}
          onChange={(e) => {
            setForm({
              ...form,
              excludePatterns: e.target.value
                .split('\n')
                .map((p) => p.trim())
                .filter((p) => p.length > 0),
            });
            setIsDirty(true);
          }}
        />
      </div>

      <Checkbox
        id="protectDeletes"
        label={t('protect_deletes')}
        checked={form.protectDeletes}
        onChange={(e) => {
          setForm({ ...form, protectDeletes: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Checkbox
        id="failoverReadOnly"
        label={t('failover_readonly')}
        checked={form.failoverReadOnly}
        onChange={(e) => {
          setForm({ ...form, failoverReadOnly: e.target.checked });
          setIsDirty(true);
        }}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Locking Settings
// ---------------------------------------------------------------------------

function LockingSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<LockingConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'locking' } }).then((data) =>
      setForm(data as LockingConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('locking', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'locking' }, body: form })
      .then((data) => {
        setForm(data as LockingConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Checkbox
        id="lockingEnabled"
        label={t('enable_locking')}
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Select
        id="serverProjection"
        label={t('server_projection')}
        value={form.serverProjection}
        onChange={(e) => {
          setForm({
            ...form,
            serverProjection: e.target.value as 'none' | 'sidecar' | 'byte_range',
          });
          setIsDirty(true);
        }}
        error={errors.serverProjection}
      >
        <option value="none">{t('projection_none')}</option>
        <option value="sidecar">{t('projection_sidecar')}</option>
        <option value="byte_range">{t('projection_byte_range')}</option>
      </Select>

      <Input
        id="tncLockTtl"
        label={t('tnc_lock_ttl')}
        type="number"
        value={form.tncLockTtlS}
        onChange={(e) => {
          setForm({ ...form, tncLockTtlS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.tncLockTtlS}
        className="w-64"
      />

      <Input
        id="releaseLinger"
        label={t('release_linger')}
        type="number"
        value={form.releaseLingerS}
        onChange={(e) => {
          setForm({ ...form, releaseLingerS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.releaseLingerS}
        className="w-64"
      />

      <Select
        id="scheduleDefault"
        label={t('schedule_default')}
        value={form.scheduleDefault}
        onChange={(e) => {
          setForm({
            ...form,
            scheduleDefault: e.target.value as 'none' | 'business_hours' | 'custom',
          });
          setIsDirty(true);
        }}
        error={errors.scheduleDefault}
      >
        <option value="none">{t('schedule_none')}</option>
        <option value="business_hours">{t('schedule_business')}</option>
        <option value="custom">{t('schedule_custom')}</option>
      </Select>

      <Checkbox
        id="blockPullWhenLocked"
        label={t('block_pull_locked')}
        checked={form.blockPullWhenLocked}
        onChange={(e) => {
          setForm({ ...form, blockPullWhenLocked: e.target.checked });
          setIsDirty(true);
        }}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Versioning Settings
// ---------------------------------------------------------------------------

function VersioningSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<VersioningConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'versioning' } }).then((data) =>
      setForm(data as VersioningConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('versioning', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'versioning' }, body: form })
      .then((data) => {
        setForm(data as VersioningConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Checkbox
        id="versioningEnabled"
        label={t('enable_versioning')}
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Input
        id="keepCount"
        label={t('keep_count')}
        type="number"
        value={form.keepCount}
        onChange={(e) => {
          setForm({ ...form, keepCount: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.keepCount}
        className="w-64"
      />

      <Input
        id="keepDays"
        label={t('keep_days')}
        type="number"
        value={form.keepDays}
        onChange={(e) => {
          setForm({ ...form, keepDays: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.keepDays}
        className="w-64"
      />

      <Input
        id="maxStoreGb"
        label={t('max_store_gb')}
        type="number"
        step="0.1"
        value={form.maxStoreGb}
        onChange={(e) => {
          setForm({ ...form, maxStoreGb: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.maxStoreGb}
        className="w-64"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security Settings
// ---------------------------------------------------------------------------

function SecuritySection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<SecurityConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'security' } }).then((data) =>
      setForm(data as SecurityConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('security', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'security' }, body: form })
      .then((data) => {
        setForm(data as SecurityConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Input
        id="sessionIdleMin"
        label={t('session_idle')}
        type="number"
        value={form.sessionIdleMin}
        onChange={(e) => {
          setForm({ ...form, sessionIdleMin: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.sessionIdleMin}
        className="w-64"
      />

      <Input
        id="sessionAbsoluteH"
        label={t('session_absolute')}
        type="number"
        value={form.sessionAbsoluteH}
        onChange={(e) => {
          setForm({ ...form, sessionAbsoluteH: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.sessionAbsoluteH}
        className="w-64"
      />

      <Input
        id="loginMaxAttempts"
        label={t('login_attempts')}
        type="number"
        value={form.loginMaxAttempts}
        onChange={(e) => {
          setForm({ ...form, loginMaxAttempts: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.loginMaxAttempts}
        className="w-64"
      />

      <Checkbox
        id="fail2banEnabled"
        label={t('enable_fail2ban')}
        checked={form.fail2banEnabled}
        onChange={(e) => {
          setForm({ ...form, fail2banEnabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Select
        id="tlsMin"
        label={t('tls_minimum')}
        value={form.tlsMin}
        onChange={(e) => {
          setForm({ ...form, tlsMin: e.target.value as 'TLSv1.2' | 'TLSv1.3' });
          setIsDirty(true);
        }}
        error={errors.tlsMin}
        className="w-40"
      >
        <option value="TLSv1.2">{t('tls_1_2')}</option>
        <option value="TLSv1.3">{t('tls_1_3')}</option>
      </Select>

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>

      {/*
        Outside the form above on purpose: the certificate is installed by its own
        endpoints the moment the operator confirms, not by this section's Save button.
        Putting it inside would suggest the two are saved together.
      */}
      <CertificateManager />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Updates Settings
// ---------------------------------------------------------------------------

function UpdatesSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<UpdatesConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'updates' } }).then((data) =>
      setForm(data as UpdatesConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('updates', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'updates' }, body: form })
      .then((data) => {
        setForm(data as UpdatesConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Checkbox
        id="updatesEnabled"
        label={t('enable_updates')}
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Select
        id="channel"
        label={t('update_channel')}
        value={form.channel}
        onChange={(e) => {
          setForm({ ...form, channel: e.target.value as 'stable' | 'beta' });
          setIsDirty(true);
        }}
        error={errors.channel}
      >
        <option value="stable">{t('channel_stable')}</option>
        <option value="beta">{t('channel_beta')}</option>
      </Select>

      <Input
        id="scheduleCron"
        label={t('schedule_cron')}
        value={form.scheduleCron}
        onChange={(e) => {
          setForm({ ...form, scheduleCron: e.target.value });
          setIsDirty(true);
        }}
        error={errors.scheduleCron}
        hint="e.g., '0 3 * * 0' for 3 AM on Sundays"
      />

      <Input
        id="githubRepo"
        label={t('github_repo')}
        value={form.githubRepo}
        onChange={(e) => {
          setForm({ ...form, githubRepo: e.target.value });
          setIsDirty(true);
        }}
        error={errors.githubRepo}
        hint="Format: owner/repo"
      />

      <Checkbox
        id="autoRestart"
        label={t('auto_restart')}
        checked={form.autoRestart}
        onChange={(e) => {
          setForm({ ...form, autoRestart: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Checkbox
        id="rollbackOnFailure"
        label={t('rollback_failure')}
        checked={form.rollbackOnFailure}
        onChange={(e) => {
          setForm({ ...form, rollbackOnFailure: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Input
        id="healthTimeoutS"
        label={t('health_timeout')}
        type="number"
        value={form.healthTimeoutS}
        onChange={(e) => {
          setForm({ ...form, healthTimeoutS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.healthTimeoutS}
        className="w-64"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DHCP Settings
// ---------------------------------------------------------------------------

function DhcpSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<DhcpConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'dhcp' } }).then((data) =>
      setForm(data as DhcpConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('dhcp', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'dhcp' }, body: form })
      .then((data) => {
        setForm(data as DhcpConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      {/*
        Stated up front because the setting is otherwise easy to read as a general DHCP
        server. `dhcp-config-manager.ts` binds dnsmasq with `interface=<tnc>` plus
        `bind-interfaces`, so it can never answer on the LAN — the note describes an
        invariant of the generated config, not a convention.
      */}
      <div className="rounded-md border border-accent/30 bg-accent/5 px-4 py-3">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('dhcp_tnc_only_title')}
        </p>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t('dhcp_tnc_only_body')}</p>
      </div>
      <Checkbox
        id="dhcpEnabled"
        label={t('enable_dhcp')}
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Input
        id="dhcpRange"
        label={t('dhcp_range')}
        value={form.range}
        onChange={(e) => {
          setForm({ ...form, range: e.target.value });
          setIsDirty(true);
        }}
        error={errors.range}
      />

      <Input
        id="dhcpLeaseTime"
        label={t('lease_time')}
        value={form.leaseTime}
        onChange={(e) => {
          setForm({ ...form, leaseTime: e.target.value });
          setIsDirty(true);
        }}
        error={errors.leaseTime}
      />

      <Input
        id="dhcpGateway"
        label={t('gateway_optional')}
        value={form.gateway ?? ''}
        onChange={(e) => {
          setForm({ ...form, gateway: e.target.value || undefined });
          setIsDirty(true);
        }}
        error={errors.gateway}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logging Settings
// ---------------------------------------------------------------------------

function LoggingSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<LoggingConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'logging' } }).then((data) =>
      setForm(data as LoggingConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('logging', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'logging' }, body: form })
      .then((data) => {
        setForm(data as LoggingConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Select
        id="logLevel"
        label={t('log_level')}
        value={form.level}
        onChange={(e) => {
          setForm({
            ...form,
            level: e.target.value as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
          });
          setIsDirty(true);
        }}
        error={errors.level}
      >
        <option value="trace">{t('log_trace')}</option>
        <option value="debug">{t('log_debug')}</option>
        <option value="info">{t('log_info')}</option>
        <option value="warn">{t('log_warn')}</option>
        <option value="error">{t('log_error')}</option>
        <option value="fatal">{t('log_fatal')}</option>
      </Select>

      <Input
        id="retainDays"
        label={t('retain_logs')}
        type="number"
        value={form.retainDays}
        onChange={(e) => {
          setForm({ ...form, retainDays: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.retainDays}
        className="w-64"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monitoring Settings
// ---------------------------------------------------------------------------

function MonitoringSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<MonitoringConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'monitoring' } }).then((data) =>
      setForm(data as MonitoringConfig),
    );
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('monitoring', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'monitoring' }, body: form })
      .then((data) => {
        setForm(data as MonitoringConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <Input
        id="sampleInterval"
        label={t('sample_interval')}
        type="number"
        value={form.sampleIntervalS}
        onChange={(e) => {
          setForm({ ...form, sampleIntervalS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.sampleIntervalS}
        className="w-64"
      />

      <Input
        id="diskWarnPct"
        label={t('disk_warn_threshold')}
        type="number"
        value={form.diskWarnPct}
        onChange={(e) => {
          setForm({ ...form, diskWarnPct: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors.diskWarnPct}
        className="w-40"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Config Page
// ---------------------------------------------------------------------------

export function ConfigPage(): JSX.Element {
  const t = useTranslation('config');
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {t('page_title')}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('page_subtitle')}</p>
      </div>
      <Card>
        <CardHeader title={t('settings_title')} />
        <CardBody>
          <Tabs
            items={[
              { id: 'network', label: t('network'), content: <NetworkSection /> },
              { id: 'dhcp', label: t('dhcp'), content: <DhcpSection /> },
              { id: 'shares', label: t('tab_shares'), content: <SharesSection /> },
              { id: 'sync', label: t('tab_sync'), content: <SyncSection /> },
              { id: 'locking', label: t('tab_locking'), content: <LockingSection /> },
              { id: 'versioning', label: t('tab_versioning'), content: <VersioningSection /> },
              { id: 'security', label: t('tab_security'), content: <SecuritySection /> },
              { id: 'updates', label: t('tab_updates'), content: <UpdatesSection /> },
              { id: 'logging', label: t('tab_logging'), content: <LoggingSection /> },
              { id: 'monitoring', label: t('tab_monitoring'), content: <MonitoringSection /> },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}
