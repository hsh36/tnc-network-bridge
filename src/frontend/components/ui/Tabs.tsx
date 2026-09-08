import { useId, useState, type ReactNode } from 'react';
import { cn } from './cn';

export interface TabItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly content: ReactNode;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly defaultTab?: string;
}

/** A minimal, accessible (roving `role="tablist"`) tab set — no external dependency needed for this shape. */
export function Tabs({ items, defaultTab }: TabsProps): JSX.Element {
  const [active, setActive] = useState(defaultTab ?? items[0]?.id);
  const baseId = useId();
  const activeItem = items.find((i) => i.id === active) ?? items[0];

  return (
    <div>
      <div role="tablist" className="flex gap-1 border-b border-border dark:border-border-dark">
        {items.map((item) => {
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.id}`}
              onClick={() => setActive(item.id)}
              className={cn(
                'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                selected
                  ? 'border-accent text-accent'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {activeItem !== undefined && (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${activeItem.id}`}
          aria-labelledby={`${baseId}-tab-${activeItem.id}`}
          className="pt-4"
        >
          {activeItem.content}
        </div>
      )}
    </div>
  );
}
