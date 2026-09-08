import { type ReactNode } from 'react';
import { Card } from './Card';
import { cn } from './cn';

export interface StatCardProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: 'default' | 'ok' | 'warn' | 'error';
  readonly icon?: ReactNode;
}

const toneText: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'text-slate-900 dark:text-slate-100',
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  error: 'text-status-error',
};

export function StatCard({ label, value, hint, tone = 'default', icon }: StatCardProps): JSX.Element {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </p>
        {icon}
      </div>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', toneText[tone])}>{value}</p>
      {hint !== undefined && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </Card>
  );
}
