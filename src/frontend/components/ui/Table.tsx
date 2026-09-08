import { type ReactNode } from 'react';
import { cn } from './cn';

export interface Column<T> {
  readonly key: string;
  readonly header: ReactNode;
  readonly render: (row: T) => ReactNode;
  readonly className?: string;
}

export interface TableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string | number;
  readonly emptyMessage?: ReactNode;
}

/** A plain, virtualisation-free table — fine up to a few hundred rows; `Logs.tsx` paginates past that. */
export function Table<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = 'No data',
}: TableProps<T>): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-slate-500 dark:border-border-dark dark:text-slate-400">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn('whitespace-nowrap px-3 py-2 font-medium', col.className)}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-3 py-8 text-center text-sm text-slate-500 dark:text-slate-400"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className="border-b border-border last:border-0 hover:bg-slate-50 dark:border-border-dark dark:hover:bg-slate-800/50"
              >
                {columns.map((col) => (
                  <td key={col.key} className={cn('whitespace-nowrap px-3 py-2', col.className)}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
