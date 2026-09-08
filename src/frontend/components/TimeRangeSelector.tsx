import { useCallback, useState } from 'react';
import { type TimeRange } from '../../shared';
import { Button } from './ui/Button';
import { cn } from './ui/cn';

export interface TimeRangeSelectorProps {
  readonly selected: TimeRange;
  readonly onSelect: (range: TimeRange, customFrom?: number, customTo?: number) => void;
}

export function TimeRangeSelector({ selected, onSelect }: TimeRangeSelectorProps): JSX.Element {
  const [showCustom, setShowCustom] = useState(false);
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');

  const handlePresetClick = (range: TimeRange): void => {
    setShowCustom(false);
    onSelect(range);
  };

  const handleCustomApply = useCallback((): void => {
    if (customFrom && customTo) {
      const from = Math.floor(new Date(customFrom).getTime() / 1000);
      const to = Math.floor(new Date(customTo).getTime() / 1000);
      if (from < to) {
        onSelect('custom', from, to);
        setShowCustom(false);
      }
    }
  }, [customFrom, customTo, onSelect]);

  const ranges = ['1h', '24h', '7d', '30d'] as const;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {ranges.map((range) => (
        <Button
          key={range}
          variant={selected === range ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => handlePresetClick(range)}
        >
          {range === '1h'
            ? '1 Hour'
            : range === '24h'
              ? '24 Hours'
              : range === '7d'
                ? '7 Days'
                : '30 Days'}
        </Button>
      ))}

      <Button
        variant={selected === 'custom' ? 'primary' : 'secondary'}
        size="sm"
        onClick={() => setShowCustom(!showCustom)}
      >
        Custom
      </Button>

      {showCustom && (
        <div
          className={cn(
            'flex w-full flex-wrap gap-2 rounded-md border border-border bg-slate-50 p-3',
            'dark:border-border-dark dark:bg-slate-900',
          )}
        >
          <div className="flex items-center gap-1">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">From:</label>
            <input
              type="datetime-local"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className={cn(
                'rounded border border-border bg-white px-2 py-1 text-xs',
                'dark:border-border-dark dark:bg-surface-dark',
              )}
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">To:</label>
            <input
              type="datetime-local"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className={cn(
                'rounded border border-border bg-white px-2 py-1 text-xs',
                'dark:border-border-dark dark:bg-surface-dark',
              )}
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={handleCustomApply}
            disabled={!customFrom || !customTo}
          >
            Apply
          </Button>
        </div>
      )}
    </div>
  );
}
