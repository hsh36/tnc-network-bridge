import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { cn } from './cn';

export interface FieldProps {
  // Explicitly `| undefined` (not just `?`) so a caller can pass through a possibly-
  // undefined local variable (`error={error}`) under `exactOptionalPropertyTypes`
  // without also having to conditionally spread the prop in.
  readonly label?: string | undefined;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly id: string;
}

function FieldWrapper({
  label,
  error,
  hint,
  id,
  children,
}: FieldProps & { readonly children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {label !== undefined && (
        <label htmlFor={id} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
      )}
      {children}
      {error !== undefined ? (
        <p className="text-xs text-status-error" role="alert">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

const fieldClasses = (error: string | undefined) =>
  cn(
    'h-9 rounded-md border bg-white px-3 text-sm text-slate-900 shadow-sm outline-none transition-colors',
    'focus:border-accent focus:ring-1 focus:ring-accent',
    'dark:bg-surface-dark dark:text-slate-100',
    error !== undefined ? 'border-status-error' : 'border-border dark:border-border-dark',
  );

export type InputProps = FieldProps & InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, id, className, ...rest },
  ref,
) {
  return (
    <FieldWrapper label={label} error={error} hint={hint} id={id}>
      <input
        ref={ref}
        id={id}
        className={cn(fieldClasses(error), className)}
        aria-invalid={error !== undefined}
        {...rest}
      />
    </FieldWrapper>
  );
});

export type SelectProps = FieldProps &
  SelectHTMLAttributes<HTMLSelectElement> & { readonly children: React.ReactNode };

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, hint, id, className, children, ...rest },
  ref,
) {
  return (
    <FieldWrapper label={label} error={error} hint={hint} id={id}>
      <select ref={ref} id={id} className={cn(fieldClasses(error), className)} {...rest}>
        {children}
      </select>
    </FieldWrapper>
  );
});

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  readonly id: string;
}

export function Checkbox({ label, id, className, ...rest }: CheckboxProps): JSX.Element {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300',
        className,
      )}
    >
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4 rounded border-border text-accent focus:ring-accent dark:border-border-dark"
        {...rest}
      />
      {label}
    </label>
  );
}
