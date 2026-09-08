import { useEffect, useState, type FormEvent } from 'react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

interface ScheduleEditorProps {
  readonly onSave?: (cronExpression: string) => void;
  readonly loading?: boolean;
  readonly currentCron?: string;
}

const WEEKDAYS = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
];

/**
 * Simple schedule editor for update scheduling.
 *
 * Parses/generates cron expressions in the format:
 * 0 <hour> * * <weekday>
 *
 * For example: "0 2 * * 0" means 2:00 AM on Sundays.
 */
export function ScheduleEditor({
  onSave,
  loading = false,
  currentCron,
}: ScheduleEditorProps): JSX.Element {
  const [hour, setHour] = useState('2');
  const [minute, setMinute] = useState('0');
  const [weekday, setWeekday] = useState('0');

  // Parse incoming cron expression
  useEffect(() => {
    if (!currentCron) return;
    const parts = currentCron.trim().split(/\s+/);
    if (parts.length >= 5) {
      setMinute(parts[0] || '0');
      setHour(parts[1] || '2');
      setWeekday(parts[4] || '0');
    }
  }, [currentCron]);

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const cron = `${minute} ${hour} * * ${weekday}`;
    onSave?.(cron);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Input
          id="hour"
          label="Hour (0-23)"
          type="number"
          min="0"
          max="23"
          value={hour}
          onChange={(e) => setHour(e.target.value)}
          required
        />
        <Input
          id="minute"
          label="Minute (0-59)"
          type="number"
          min="0"
          max="59"
          value={minute}
          onChange={(e) => setMinute(e.target.value)}
          required
        />
        <div>
          <label
            htmlFor="weekday"
            className="block text-sm font-medium text-slate-700 dark:text-slate-300"
          >
            Day of week
          </label>
          <select
            id="weekday"
            value={weekday}
            onChange={(e) => setWeekday(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            {WEEKDAYS.map((day) => (
              <option key={day.value} value={day.value}>
                {day.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-md bg-slate-50 p-3 dark:bg-slate-800">
        <p className="text-xs font-mono text-slate-600 dark:text-slate-300">
          Cron: {minute} {hour} * * {weekday}
        </p>
      </div>

      <Button type="submit" loading={loading} disabled={loading}>
        Save Schedule
      </Button>
    </form>
  );
}
