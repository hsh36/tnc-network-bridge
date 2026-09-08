import { cn } from './cn';

export function Spinner({
  className,
  label = 'Loading',
}: {
  readonly className?: string;
  readonly label?: string;
}): JSX.Element {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-accent',
        'dark:border-slate-700 dark:border-t-accent',
        className,
      )}
    />
  );
}

export function FullPageSpinner(): JSX.Element {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner />
    </div>
  );
}
