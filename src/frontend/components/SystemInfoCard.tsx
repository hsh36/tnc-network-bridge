import { type SystemInfo } from '../../shared';
import { Badge } from './ui/Badge';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Spinner } from './ui/Spinner';

export interface SystemInfoCardProps {
  readonly systemInfo: SystemInfo | undefined;
  readonly loading?: boolean;
}

export function SystemInfoCard({ systemInfo, loading = false }: SystemInfoCardProps): JSX.Element {
  if (loading) {
    return (
      <Card>
        <CardHeader title="System Info" subtitle="Bridge hardware and software" />
        <CardBody className="flex h-64 items-center justify-center">
          <Spinner />
        </CardBody>
      </Card>
    );
  }

  if (!systemInfo) {
    return (
      <Card>
        <CardHeader title="System Info" subtitle="Bridge hardware and software" />
        <CardBody>
          <p className="text-sm text-slate-500 dark:text-slate-400">No system info available</p>
        </CardBody>
      </Card>
    );
  }

  const uptime = formatUptime(systemInfo.uptimeSeconds);
  const isRaspberryPi = systemInfo.osRelease.includes('Raspberry Pi');

  return (
    <Card>
      <CardHeader title="System Info" subtitle="Bridge hardware and software" />
      <CardBody className="space-y-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Uptime
          </p>
          <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {uptime}
          </p>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            OS
          </p>
          <p className="mt-0.5 text-sm font-mono text-slate-700 dark:text-slate-300">
            {systemInfo.osRelease}
          </p>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Software
          </p>
          <div className="mt-0.5 flex flex-col gap-1 text-sm">
            <span className="font-mono text-slate-700 dark:text-slate-300">
              Bridge v{systemInfo.version}
            </span>
            <span className="font-mono text-slate-700 dark:text-slate-300">
              Node.js {systemInfo.nodeVersion}
            </span>
          </div>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Hardware
          </p>
          <p className="mt-0.5 text-sm font-mono text-slate-700 dark:text-slate-300">
            {isRaspberryPi ? 'Raspberry Pi 5' : systemInfo.hostname}
          </p>
        </div>

        {systemInfo.cpuTempC !== null && (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Temperature
            </p>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {systemInfo.cpuTempC.toFixed(1)}°C
              </span>
              {systemInfo.throttling.underVoltageNow && <Badge tone="error">Under-voltage</Badge>}
              {systemInfo.throttling.throttledNow && <Badge tone="warn">Throttled</Badge>}
            </div>
          </div>
        )}

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Network
          </p>
          <div className="mt-0.5 space-y-1">
            {systemInfo.interfaces.map((iface) => (
              <div key={iface.name} className="flex items-center justify-between text-xs">
                <span className="font-mono text-slate-600 dark:text-slate-400">{iface.name}</span>
                <div className="flex items-center gap-2">
                  <span
                    className={iface.up ? 'text-status-ok' : 'text-slate-400 dark:text-slate-500'}
                  >
                    {iface.up ? 'Up' : 'Down'}
                  </span>
                  {iface.speedMbps !== null && (
                    <span className="text-slate-500 dark:text-slate-400">
                      {iface.speedMbps} Mbps
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Load Average
          </p>
          <p className="mt-0.5 text-sm font-mono text-slate-700 dark:text-slate-300">
            {systemInfo.loadAverage.map((x) => x.toFixed(2)).join(', ')}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

  return parts.join(' ');
}
