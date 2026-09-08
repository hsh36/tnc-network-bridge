import { type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-white shadow-sm',
        'dark:border-border-dark dark:bg-surface-dark-subtle',
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  title,
  action,
  subtitle,
}: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3 dark:border-border-dark">
      <div>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        {subtitle !== undefined && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('p-4', className)} {...rest} />;
}
