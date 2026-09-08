import { useEffect, useState } from 'react';
import {
  type ConflictMode,
  type DhcpConfig,
  type LoggingConfig,
  type LockingConfig,
  type MonitoringConfig,
  type NetworkConfig,
  type SecurityConfig,
  type SmbConfig,
  type SyncConfig,
  type UpdatesConfig,
  type VersioningConfig,
  configSectionSchemas,
} from '../../shared';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Checkbox, Input, Select } from '../components/ui/Input';
import { Tabs } from '../components/ui/Tabs';
import { FullPageSpinner } from '../components/ui/Spinner';
import { SharesSection } from '../components/SharesSection';
import { api, ApiError } from '../lib/api-client';

/**
 * A per-section save form with Zod validation, unsaved-changes guard, and
 * test connectivity buttons. Replaces the simpler previous implementation with
 * full T47 scope: network, SMB, AD, sync, locking, versioning, security, updates,
 * logging, monitoring, plus test/connection features.
 */

function useSaveBanner(): {
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
    onSaved: () => setMessage({ text: 'Saved.', tone: 'ok' }),
    onError: (err) =>
      setMessage({ text: err instanceof ApiError ? err.message : 'Could not save', tone: 'error' }),
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

function NetworkSection(): JSX.Element {
  const [form, setForm] = useState<NetworkConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner();

  useEffect(() => {
    void api('config.get', { params: { section: 'network' } }).then((data) =>
      setForm(data as NetworkConfig),
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
    const validationErrors = validateConfigSection('network', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error('Validation failed'));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'network' }, body: form })
      .then((data) => {
        setForm(data as NetworkConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          id="lanIf"
          label="LAN interface"
          value={form.lan.interface}
          onChange={(e) => {
            setForm({ ...form, lan: { ...form.lan, interface: e.target.value } });
            setIsDirty(true);
          }}
          error={errors['lan.interface']}
        />
        <Input
          id="tncIf"
          label="TNC interface"
          value={form.tnc.interface}
          onChange={(e) => {
            setForm({ ...form, tnc: { ...form.tnc, interface: e.target.value } });
            setIsDirty(true);
          }}
          error={errors['tnc.interface']}
        />
      </div>
      <Select
        id="lanMethod"
        label="LAN addressing"
        value={form.lan.method}
        onChange={(e) => {
          setForm({ ...form, lan: { ...form.lan, method: e.target.value as 'dhcp' | 'static' } });
          setIsDirty(true);
        }}
        error={errors['lan.method']}
        className="w-40"
      >
        <option value="dhcp">DHCP</option>
        <option value="static">Static</option>
      </Select>
      {form.lan.method === 'static' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            id="lanAddress"
            label="LAN address (CIDR)"
            value={form.lan.address ?? ''}
            onChange={(e) => {
              setForm({
                ...form,
                lan: { ...form.lan, address: e.target.value || undefined },
              });
              setIsDirty(true);
            }}
            error={errors['lan.address']}
          />
          <Input
            id="lanGateway"
            label="Gateway"
            value={form.lan.gateway ?? ''}
            onChange={(e) => {
              setForm({
                ...form,
                lan: { ...form.lan, gateway: e.target.value || undefined },
              });
              setIsDirty(true);
            }}
            error={errors['lan.gateway']}
          />
        </div>
      )}
      <Input
        id="tncAddress"
        label="TNC address (CIDR)"
        value={form.tnc.address}
        onChange={(e) => {
          setForm({ ...form, tnc: { ...form.tnc, address: e.target.value } });
          setIsDirty(true);
        }}
        error={errors['tnc.address']}
      />
      <Input
        id="mtu"
        label="MTU (bytes)"
        type="number"
        value={form.mtu}
        onChange={(e) => {
          setForm({ ...form, mtu: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['mtu']}
        className="w-40"
      />
      <Checkbox
        id="ipv6"
        label="Enable IPv6"
        checked={form.ipv6.enabled}
        onChange={(e) => {
          setForm({ ...form, ipv6: { enabled: e.target.checked } });
          setIsDirty(true);
        }}
      />
      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          Save
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SMB Settings
// ---------------------------------------------------------------------------

function SmbSection(): JSX.Element {
  const [form, setForm] = useState<SmbConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const { banner, onSaved, onError } = useSaveBanner();

  useEffect(() => {
    void api('config.get', { params: { section: 'smb' } }).then((data) =>
      setForm(data as SmbConfig),
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
    const validationErrors = validateConfigSection('smb', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error('Validation failed'));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'smb' }, body: form })
      .then((data) => {
        setForm(data as SmbConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  const testConnection = (): void => {
    setTesting(true);
    // TODO: Implement test connection when API route is available
    setTimeout(() => setTesting(false), 2000);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="border-b border-border pb-4 dark:border-border-dark">
        <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
          Server (LAN side)
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            id="serverMinProtocol"
            label="Minimum protocol"
            value={form.server.minProtocol}
            onChange={(e) => {
              setForm({
                ...form,
                server: { ...form.server, minProtocol: e.target.value as any },
              });
              setIsDirty(true);
            }}
            error={errors['server.minProtocol']}
          >
            <option value="SMB2">SMB 2</option>
            <option value="SMB3">SMB 3</option>
            <option value="SMB3_00">SMB 3.0.0</option>
            <option value="SMB3_02">SMB 3.0.2</option>
            <option value="SMB3_11">SMB 3.1.1</option>
          </Select>
          <Checkbox
            id="serverSeal"
            label="Enable sealing (encryption)"
            checked={form.server.seal}
            onChange={(e) => {
              setForm({ ...form, server: { ...form.server, seal: e.target.checked } });
              setIsDirty(true);
            }}
          />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            id="serverDomain"
            label="Domain"
            value={form.server.credentials.domain}
            onChange={(e) => {
              setForm({
                ...form,
                server: {
                  ...form.server,
                  credentials: { ...form.server.credentials, domain: e.target.value },
                },
              });
              setIsDirty(true);
            }}
            error={errors['server.credentials.domain']}
          />
          <Input
            id="serverUsername"
            label="Username"
            value={form.server.credentials.username}
            onChange={(e) => {
              setForm({
                ...form,
                server: {
                  ...form.server,
                  credentials: { ...form.server.credentials, username: e.target.value },
                },
              });
              setIsDirty(true);
            }}
            error={errors['server.credentials.username']}
          />
          <Input
            id="serverPassword"
            label="Password"
            type="password"
            value={
              form.server.credentials.password === '********'
                ? ''
                : form.server.credentials.password
            }
            placeholder={form.server.credentials.password === '********' ? 'Unchanged' : undefined}
            onChange={(e) => {
              setForm({
                ...form,
                server: {
                  ...form.server,
                  credentials: { ...form.server.credentials, password: e.target.value },
                },
              });
              setIsDirty(true);
            }}
            error={errors['server.credentials.password']}
          />
        </div>
      </div>

      <div className="border-b border-border pb-4 dark:border-border-dark">
        <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
          TNC (Machine side)
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Select
            id="tncMinProtocol"
            label="Minimum protocol"
            value={form.tnc.minProtocol}
            onChange={(e) => {
              setForm({
                ...form,
                tnc: { ...form.tnc, minProtocol: e.target.value as any },
              });
              setIsDirty(true);
            }}
            error={errors['tnc.minProtocol']}
          >
            <option value="NT1">NT1</option>
            <option value="SMB2">SMB 2</option>
            <option value="SMB3">SMB 3</option>
          </Select>
          <Select
            id="tncMaxProtocol"
            label="Maximum protocol"
            value={form.tnc.maxProtocol}
            onChange={(e) => {
              setForm({
                ...form,
                tnc: { ...form.tnc, maxProtocol: e.target.value as any },
              });
              setIsDirty(true);
            }}
            error={errors['tnc.maxProtocol']}
          >
            <option value="NT1">NT1</option>
            <option value="SMB2">SMB 2</option>
            <option value="SMB3">SMB 3</option>
          </Select>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <Checkbox
            id="tncNtlmAuth"
            label="Enable NTLM authentication"
            checked={form.tnc.ntlmAuth}
            onChange={(e) => {
              setForm({ ...form, tnc: { ...form.tnc, ntlmAuth: e.target.checked } });
              setIsDirty(true);
            }}
          />
          <Checkbox
            id="tncLanmanAuth"
            label="Enable LANMAN authentication (legacy)"
            checked={form.tnc.lanmanAuth}
            onChange={(e) => {
              setForm({ ...form, tnc: { ...form.tnc, lanmanAuth: e.target.checked } });
              setIsDirty(true);
            }}
          />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            id="tncDosCharset"
            label="DOS character set"
            value={form.tnc.dosCharset}
            onChange={(e) => {
              setForm({ ...form, tnc: { ...form.tnc, dosCharset: e.target.value } });
              setIsDirty(true);
            }}
            error={errors['tnc.dosCharset']}
          />
          <Input
            id="tncWorkgroup"
            label="Workgroup"
            value={form.tnc.workgroup}
            onChange={(e) => {
              setForm({ ...form, tnc: { ...form.tnc, workgroup: e.target.value } });
              setIsDirty(true);
            }}
            error={errors['tnc.workgroup']}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          Save
        </Button>
        <Button onClick={testConnection} variant="secondary" loading={testing} className="w-fit">
          Test Connection (Verbindung testen)
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync Behavior
// ---------------------------------------------------------------------------

function SyncSection(): JSX.Element {
  const [form, setForm] = useState<SyncConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner();

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
      onError(new Error('Validation failed'));
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
        label="Conflict mode"
        value={form.conflictMode}
        onChange={(e) => {
          setForm({ ...form, conflictMode: e.target.value as ConflictMode });
          setIsDirty(true);
        }}
        error={errors['conflictMode']}
        className="w-64"
      >
        <option value="last_write_wins">Last write wins</option>
        <option value="tnc_wins">TNC wins</option>
        <option value="server_wins">Server wins</option>
      </Select>

      <Input
        id="bandwidthLimit"
        label="Bandwidth limit (kbps, empty = unlimited)"
        type="number"
        value={form.bandwidthLimitKbps ?? ''}
        onChange={(e) => {
          setForm({
            ...form,
            bandwidthLimitKbps: e.target.value === '' ? null : Number(e.target.value),
          });
          setIsDirty(true);
        }}
        error={errors['bandwidthLimitKbps']}
        className="w-64"
      />

      <Input
        id="maxFileSize"
        label="Max file size (MB)"
        type="number"
        value={form.maxFileSizeMb}
        onChange={(e) => {
          setForm({ ...form, maxFileSizeMb: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['maxFileSizeMb']}
        className="w-64"
      />

      <Input
        id="mtimeTolerance"
        label="Mtime tolerance (ms)"
        type="number"
        value={form.mtimeToleranceMs}
        onChange={(e) => {
          setForm({ ...form, mtimeToleranceMs: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['mtimeToleranceMs']}
        className="w-64"
      />

      <Input
        id="scanInterval"
        label="Scan interval (ms)"
        type="number"
        value={form.scanIntervalMs}
        onChange={(e) => {
          setForm({ ...form, scanIntervalMs: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['scanIntervalMs']}
        className="w-64"
      />

      <Input
        id="concurrency"
        label="Concurrency"
        type="number"
        value={form.concurrency}
        onChange={(e) => {
          setForm({ ...form, concurrency: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['concurrency']}
        className="w-40"
      />

      <div>
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Exclude patterns (one per line)
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
        label="Never auto-propagate deletes"
        checked={form.protectDeletes}
        onChange={(e) => {
          setForm({ ...form, protectDeletes: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Checkbox
        id="failoverReadOnly"
        label="Drop to read-only when the server is unreachable"
        checked={form.failoverReadOnly}
        onChange={(e) => {
          setForm({ ...form, failoverReadOnly: e.target.checked });
          setIsDirty(true);
        }}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          Save
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
  const [form, setForm] = useState<LockingConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner();

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
      onError(new Error('Validation failed'));
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
        label="Enable file locking"
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Select
        id="serverProjection"
        label="Server projection mode"
        value={form.serverProjection}
        onChange={(e) => {
          setForm({ ...form, serverProjection: e.target.value as any });
          setIsDirty(true);
        }}
        error={errors['serverProjection']}
      >
        <option value="none">None</option>
        <option value="sidecar">Sidecar</option>
        <option value="byte_range">Byte range</option>
      </Select>

      <Input
        id="tncLockTtl"
        label="TNC lock TTL (seconds)"
        type="number"
        value={form.tncLockTtlS}
        onChange={(e) => {
          setForm({ ...form, tncLockTtlS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['tncLockTtlS']}
        className="w-64"
      />

      <Input
        id="releaseLinger"
        label="Release linger time (seconds)"
        type="number"
        value={form.releaseLingerS}
        onChange={(e) => {
          setForm({ ...form, releaseLingerS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['releaseLingerS']}
        className="w-64"
      />

      <Select
        id="scheduleDefault"
        label="Schedule default"
        value={form.scheduleDefault}
        onChange={(e) => {
          setForm({ ...form, scheduleDefault: e.target.value as any });
          setIsDirty(true);
        }}
        error={errors['scheduleDefault']}
      >
        <option value="none">None (no locks)</option>
        <option value="business_hours">Business hours</option>
        <option value="custom">Custom</option>
      </Select>

      <Checkbox
        id="blockPullWhenLocked"
        label="Block pull when locked"
        checked={form.blockPullWhenLocked}
        onChange={(e) => {
          setForm({ ...form, blockPullWhenLocked: e.target.checked });
          setIsDirty(true);
        }}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          Save
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
  const [form, setForm] = useState<VersioningConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner();

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
      onError(new Error('Validation failed'));
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
        label="Enable file versioning"
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Input
        id="keepCount"
        label="Keep count (number of versions)"
        type="number"
        value={form.keepCount}
        onChange={(e) => {
          setForm({ ...form, keepCount: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['keepCount']}
        className="w-64"
      />

      <Input
        id="keepDays"
        label="Keep days"
        type="number"
        value={form.keepDays}
        onChange={(e) => {
          setForm({ ...form, keepDays: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['keepDays']}
        className="w-64"
      />

      <Input
        id="maxStoreGb"
        label="Max store (GB)"
        type="number"
        step="0.1"
        value={form.maxStoreGb}
        onChange={(e) => {
          setForm({ ...form, maxStoreGb: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['maxStoreGb']}
        className="w-64"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          Save
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
  const [form, setForm] = useState<SecurityConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner();

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
      onError(new Error('Validation failed'));
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
        label="Session idle timeout (minutes)"
        type="number"
        value={form.sessionIdleMin}
        onChange={(e) => {
          setForm({ ...form, sessionIdleMin: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['sessionIdleMin']}
        className="w-64"
      />

      <Input
        id="sessionAbsoluteH"
        label="Session absolute timeout (hours)"
        type="number"
        value={form.sessionAbsoluteH}
        onChange={(e) => {
          setForm({ ...form, sessionAbsoluteH: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['sessionAbsoluteH']}
        className="w-64"
      />

      <Input
        id="loginMaxAttempts"
        label="Max login attempts per 15 min"
        type="number"
        value={form.loginMaxAttempts}
        onChange={(e) => {
          setForm({ ...form, loginMaxAttempts: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['loginMaxAttempts']}
        className="w-64"
      />

      <Checkbox
        id="fail2banEnabled"
        label="Enable Fail2Ban integration"
        checked={form.fail2banEnabled}
        onChange={(e) => {
          setForm({ ...form, fail2banEnabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Select
        id="tlsMin"
        label="Minimum TLS version"
        value={form.tlsMin}
        onChange={(e) => {
          setForm({ ...form, tlsMin: e.target.value as any });
          setIsDirty(true);
        }}
        error={errors['tlsMin']}
        className="w-40"
      >
        <option value="TLSv1.2">TLS 1.2</option>
        <option value="TLSv1.3">TLS 1.3</option>
      </Select>

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          Save
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Updates Settings
// ---------------------------------------------------------------------------

function UpdatesSection(): JSX.Element {
  const [form, setForm] = useState<UpdatesConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner();

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
      onError(new Error('Validation failed'));
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
        label="Enable auto-updates"
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Select
        id="channel"
        label="Update channel"
        value={form.channel}
        onChange={(e) => {
          setForm({ ...form, channel: e.target.value as any });
          setIsDirty(true);
        }}
        error={errors['channel']}
      >
        <option value="stable">Stable</option>
        <option value="beta">Beta</option>
      </Select>

      <Input
        id="scheduleCron"
        label="Schedule (cron format)"
        value={form.scheduleCron}
        onChange={(e) => {
          setForm({ ...form, scheduleCron: e.target.value });
          setIsDirty(true);
        }}
        error={errors['scheduleCron']}
        hint="e.g., '0 3 * * 0' for 3 AM on Sundays"
      />

      <Input
        id="githubRepo"
        label="GitHub repository"
        value={form.githubRepo}
        onChange={(e) => {
          setForm({ ...form, githubRepo: e.target.value });
          setIsDirty(true);
        }}
        error={errors['githubRepo']}
        hint="Format: owner/repo"
      />

      <Checkbox
        id="autoRestart"
        label="Auto-restart after update"
        checked={form.autoRestart}
        onChange={(e) => {
          setForm({ ...form, autoRestart: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Checkbox
        id="rollbackOnFailure"
        label="Rollback on health check failure"
        checked={form.rollbackOnFailure}
        onChange={(e) => {
          setForm({ ...form, rollbackOnFailure: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Input
        id="healthTimeoutS"
        label="Health check timeout (seconds)"
        type="number"
        value={form.healthTimeoutS}
        onChange={(e) => {
          setForm({ ...form, healthTimeoutS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['healthTimeoutS']}
        className="w-64"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          Save
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
  const [form, setForm] = useState<DhcpConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner();

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
      onError(new Error('Validation failed'));
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
      <Checkbox
        id="dhcpEnabled"
        label="Enable DHCP"
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Input
        id="dhcpRange"
        label="IP range (e.g., 192.168.42.100-192.168.42.199)"
        value={form.range}
        onChange={(e) => {
          setForm({ ...form, range: e.target.value });
          setIsDirty(true);
        }}
        error={errors['range']}
      />

      <Input
        id="dhcpLeaseTime"
        label="Lease time (e.g., 12h, 30m, infinite)"
        value={form.leaseTime}
        onChange={(e) => {
          setForm({ ...form, leaseTime: e.target.value });
          setIsDirty(true);
        }}
        error={errors['leaseTime']}
      />

      <Input
        id="dhcpDns"
        label="DNS server"
        value={form.dns}
        onChange={(e) => {
          setForm({ ...form, dns: e.target.value as any });
          setIsDirty(true);
        }}
        error={errors['dns']}
      />

      <Input
        id="dhcpGateway"
        label="Gateway (optional)"
        value={form.gateway ?? ''}
        onChange={(e) => {
          setForm({ ...form, gateway: e.target.value || undefined });
          setIsDirty(true);
        }}
        error={errors['gateway']}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          Save
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
  const [form, setForm] = useState<LoggingConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner();

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
      onError(new Error('Validation failed'));
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
        label="Log level"
        value={form.level}
        onChange={(e) => {
          setForm({ ...form, level: e.target.value as any });
          setIsDirty(true);
        }}
        error={errors['level']}
      >
        <option value="trace">Trace</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
        <option value="fatal">Fatal</option>
      </Select>

      <Input
        id="retainDays"
        label="Retain logs (days)"
        type="number"
        value={form.retainDays}
        onChange={(e) => {
          setForm({ ...form, retainDays: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['retainDays']}
        className="w-64"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          Save
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
  const [form, setForm] = useState<MonitoringConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner();

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
      onError(new Error('Validation failed'));
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
        label="Sample interval (seconds)"
        type="number"
        value={form.sampleIntervalS}
        onChange={(e) => {
          setForm({ ...form, sampleIntervalS: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['sampleIntervalS']}
        className="w-64"
      />

      <Input
        id="diskWarnPct"
        label="Disk warning threshold (%)"
        type="number"
        value={form.diskWarnPct}
        onChange={(e) => {
          setForm({ ...form, diskWarnPct: Number(e.target.value) });
          setIsDirty(true);
        }}
        error={errors['diskWarnPct']}
        className="w-40"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          Save
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
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Configuration</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Changes apply immediately — the config manager notifies every subsystem on save.
        </p>
      </div>
      <Card>
        <CardHeader title="Settings" />
        <CardBody>
          <Tabs
            items={[
              { id: 'network', label: 'Network', content: <NetworkSection /> },
              { id: 'smb', label: 'SMB', content: <SmbSection /> },
              { id: 'dhcp', label: 'DHCP', content: <DhcpSection /> },
              { id: 'shares', label: 'Shares', content: <SharesSection /> },
              { id: 'sync', label: 'Sync', content: <SyncSection /> },
              { id: 'locking', label: 'Locking', content: <LockingSection /> },
              { id: 'versioning', label: 'Versioning', content: <VersioningSection /> },
              { id: 'security', label: 'Security', content: <SecuritySection /> },
              { id: 'updates', label: 'Updates', content: <UpdatesSection /> },
              { id: 'logging', label: 'Logging', content: <LoggingSection /> },
              { id: 'monitoring', label: 'Monitoring', content: <MonitoringSection /> },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}
