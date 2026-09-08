import { type FormEvent } from 'react';
import { Input } from './ui/Input';
import { Button } from './ui/Button';

interface FilterState {
  share: number;
  path: string;
  state: string;
  search: string;
}

interface Share {
  id: number;
  name: string;
}

export function SearchBar({
  filters,
  shareList,
  onFilterChange,
  viewMode,
  onViewModeChange,
}: {
  readonly filters: FilterState;
  readonly shareList: readonly Share[];
  readonly onFilterChange: (filters: Partial<FilterState>) => void;
  readonly viewMode: 'tree' | 'list';
  readonly onViewModeChange: (mode: 'tree' | 'list') => void;
}): JSX.Element {
  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {/* Share selector */}
        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Share
          </label>
          <select
            value={filters.share}
            onChange={(e) => onFilterChange({ share: Number(e.target.value) || 1 })}
            className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 shadow-sm dark:border-border-dark dark:bg-surface-dark-subtle dark:text-slate-100"
          >
            {shareList.length > 0 ? (
              shareList.map((share: any) => (
                <option key={share.id} value={share.id}>
                  {share.name}
                </option>
              ))
            ) : (
              <option value="1">Default Share</option>
            )}
          </select>
        </div>

        {/* State filter */}
        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Status
          </label>
          <select
            value={filters.state}
            onChange={(e) => onFilterChange({ state: e.target.value })}
            className="mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 shadow-sm dark:border-border-dark dark:bg-surface-dark-subtle dark:text-slate-100"
          >
            <option value="all">All</option>
            <option value="synced">Synced</option>
            <option value="pending_push">Pending push</option>
            <option value="pending_pull">Pending pull</option>
            <option value="conflict">Conflict</option>
            <option value="error">Error</option>
            <option value="excluded">Excluded</option>
          </select>
        </div>

        {/* Path filter */}
        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Path
          </label>
          <Input
            type="text"
            placeholder="e.g., /PARTS"
            value={filters.path}
            onChange={(e) => onFilterChange({ path: e.target.value })}
            className="mt-1"
          />
        </div>

        {/* Search */}
        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Search
          </label>
          <Input
            type="text"
            placeholder="File name..."
            value={filters.search}
            onChange={(e) => onFilterChange({ search: e.target.value })}
            className="mt-1"
          />
        </div>
      </div>

      {/* View mode toggle */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">View:</span>
        <Button
          type="button"
          variant={viewMode === 'tree' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => onViewModeChange('tree')}
        >
          Tree
        </Button>
        <Button
          type="button"
          variant={viewMode === 'list' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => onViewModeChange('list')}
        >
          List
        </Button>
      </div>
    </form>
  );
}
