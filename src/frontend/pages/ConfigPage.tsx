import { useEffect, useState } from 'react';
import {
  type ConflictMode,
  type NetworkConfig,
  type SecurityConfig,
  type SyncConfig,
} from '../../shared';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Checkbox, Input, Select } from '../components/ui/Input';
import { Tabs } from '../components/ui/Tabs';
import { FullPageSpinner } from '../components/ui/Spinner';
import { api, ApiError } from '../lib/api-client';

/**
 * A per-section save form. Not schema-driven (a generic form generator over
 * `configSectionSchemas` is real T47 scope) — each section below is a small, explicit
 * form so the fields that exist today are genuinely wired to `/config/:section`
 * rather than being a preview of settings the backend cannot act on yet.
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

function SyncSection(): JSX.Element {
  const [form, setForm] = useState<SyncConfig>();
  const [saving, setSaving] = useState(false);
  const { banner, onSaved, onError } = useSaveBanner();

  useEffect(() => {
    void api('config.get', { params: { section: 'sync' } }).then((data) =>
      setForm(data as SyncConfig),
    );
  }, []);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    setSaving(true);
    api('config.update', { params: { section: 'sync' }, body: form })
      .then((data) => {
        setForm(data as SyncConfig);
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
        onChange={(e) => setForm({ ...form, conflictMode: e.target.value as ConflictMode })}
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
        onChange={(e) =>
          setForm({
            ...form,
            bandwidthLimitKbps: e.target.value === '' ? null : Number(e.target.value),
          })
        }
        className="w-64"
      />
      <Input
        id="maxFileSize"
        label="Max file size (MB)"
        type="number"
        value={form.maxFileSizeMb}
        onChange={(e) => setForm({ ...form, maxFileSizeMb: Number(e.target.value) })}
        className="w-64"
      />
      <Input
        id="excludePatterns"
        label="Exclude patterns (comma-separated)"
        value={form.excludePatterns.join(', ')}
        onChange={(e) =>
          setForm({
            ...form,
            excludePatterns: e.target.value
              .split(',')
              .map((p) => p.trim())
              .filter((p) => p.length > 0),
          })
        }
      />
      <Checkbox
        id="protectDeletes"
        label="Never auto-propagate deletes"
        checked={form.protectDeletes}
        onChange={(e) => setForm({ ...form, protectDeletes: e.target.checked })}
      />
      <Checkbox
        id="failoverReadOnly"
        label="Drop to read-only when the server is unreachable"
        checked={form.failoverReadOnly}
        onChange={(e) => setForm({ ...form, failoverReadOnly: e.target.checked })}
      />
      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} className="w-fit">
          Save
        </Button>
        {banner}
      </div>
    </div>
  );
}

function SecuritySection(): JSX.Element {
  const [form, setForm] = useState<SecurityConfig>();
  const [saving, setSaving] = useState(false);
  const { banner, onSaved, onError } = useSaveBanner();

  useEffect(() => {
    void api('config.get', { params: { section: 'security' } }).then((data) =>
      setForm(data as SecurityConfig),
    );
  }, []);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    setSaving(true);
    api('config.update', { params: { section: 'security' }, body: form })
      .then((data) => {
        setForm(data as SecurityConfig);
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
        onChange={(e) => setForm({ ...form, sessionIdleMin: Number(e.target.value) })}
        className="w-64"
      />
      <Input
        id="sessionAbsoluteH"
        label="Session absolute timeout (hours)"
        type="number"
        value={form.sessionAbsoluteH}
        onChange={(e) => setForm({ ...form, sessionAbsoluteH: Number(e.target.value) })}
        className="w-64"
      />
      <Input
        id="loginMaxAttempts"
        label="Max login attempts per 15 min"
        type="number"
        value={form.loginMaxAttempts}
        onChange={(e) => setForm({ ...form, loginMaxAttempts: Number(e.target.value) })}
        className="w-64"
      />
      <Checkbox
        id="fail2banEnabled"
        label="Enable Fail2Ban integration"
        checked={form.fail2banEnabled}
        onChange={(e) => setForm({ ...form, fail2banEnabled: e.target.checked })}
      />
      <Select
        id="tlsMin"
        label="Minimum TLS version"
        value={form.tlsMin}
        onChange={(e) => setForm({ ...form, tlsMin: e.target.value as SecurityConfig['tlsMin'] })}
        className="w-40"
      >
        <option value="TLSv1.2">TLS 1.2</option>
        <option value="TLSv1.3">TLS 1.3</option>
      </Select>
      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} className="w-fit">
          Save
        </Button>
        {banner}
      </div>
    </div>
  );
}

function NetworkSection(): JSX.Element {
  const [form, setForm] = useState<NetworkConfig>();
  const [saving, setSaving] = useState(false);
  const { banner, onSaved, onError } = useSaveBanner();

  useEffect(() => {
    void api('config.get', { params: { section: 'network' } }).then((data) =>
      setForm(data as NetworkConfig),
    );
  }, []);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    setSaving(true);
    api('config.update', { params: { section: 'network' }, body: form })
      .then((data) => {
        setForm(data as NetworkConfig);
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
          onChange={(e) => setForm({ ...form, lan: { ...form.lan, interface: e.target.value } })}
        />
        <Input
          id="tncIf"
          label="TNC interface"
          value={form.tnc.interface}
          onChange={(e) => setForm({ ...form, tnc: { ...form.tnc, interface: e.target.value } })}
        />
      </div>
      <Select
        id="lanMethod"
        label="LAN addressing"
        value={form.lan.method}
        onChange={(e) =>
          setForm({ ...form, lan: { ...form.lan, method: e.target.value as 'dhcp' | 'static' } })
        }
        className="w-40"
      >
        <option value="dhcp">DHCP</option>
        <option value="static">Static</option>
      </Select>
      <Checkbox
        id="ipv6"
        label="Enable IPv6"
        checked={form.ipv6.enabled}
        onChange={(e) => setForm({ ...form, ipv6: { enabled: e.target.checked } })}
      />
      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} className="w-fit">
          Save
        </Button>
        {banner}
      </div>
    </div>
  );
}

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
              { id: 'sync', label: 'Sync behaviour', content: <SyncSection /> },
              { id: 'security', label: 'Security', content: <SecuritySection /> },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}
