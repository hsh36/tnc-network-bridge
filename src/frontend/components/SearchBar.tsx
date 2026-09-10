import { type FormEvent } from 'react';

import { useTranslation } from '../hooks/useTranslation';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

interface FilterState {
  /** Null until the share list has loaded and one can honestly be chosen. */
  share: number | null;
  path: string;
  state: string;
  search: string;
}

interface Share {
  id: number;
  name: string;
}

const SELECT_CLASS =
  'mt-1 block w-full rounded-md border border-border bg-white px-3 py-2 text-sm ' +
  'text-slate-900 placeholder-slate-400 shadow-sm disabled:opacity-60 ' +
  'dark:border-border-dark dark:bg-surface-dark-subtle dark:text-slate-100';

const LABEL_CLASS = 'block text-xs font-medium text-slate-700 dark:text-slate-300';

/**
 * The filter bar above the file browser.
 *
 * Every string here was hardcoded English until now, on a page whose operators read
 * German. The share selector also offered a fabricated "Default Share" with id 1
 * whenever the list was empty — selecting it asked the API for files from a share that
 * need not exist, so the browser stayed empty with nothing to explain why.
 */
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
  const t = useTranslation('files');

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="share-filter" className={LABEL_CLASS}>
            {t('share_label')}
          </label>
          <select
            id="share-filter"
            value={filters.share ?? ''}
            disabled={shareList.length === 0}
            onChange={(e) => onFilterChange({ share: Number(e.target.value) })}
            className={SELECT_CLASS}
          >
            {shareList.length > 0 ? (
              shareList.map((share) => (
                <option key={share.id} value={share.id}>
                  {share.name}
                </option>
              ))
            ) : (
              // Says what is true rather than naming a share that may not exist.
              <option value="">{t('no_shares_option')}</option>
            )}
          </select>
        </div>

        <div>
          <label htmlFor="state-filter" className={LABEL_CLASS}>
            {t('state_label')}
          </label>
          <select
            id="state-filter"
            value={filters.state}
            onChange={(e) => onFilterChange({ state: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="all">{t('state_all')}</option>
            <option value="synced">{t('state_synced')}</option>
            <option value="pending_push">{t('state_pending_push')}</option>
            <option value="pending_pull">{t('state_pending_pull')}</option>
            <option value="conflict">{t('state_conflict')}</option>
            <option value="error">{t('state_error')}</option>
            <option value="excluded">{t('state_excluded')}</option>
          </select>
        </div>

        <div>
          <label htmlFor="path-filter" className={LABEL_CLASS}>
            {t('path_label')}
          </label>
          <Input
            id="path-filter"
            type="text"
            placeholder={t('path_placeholder')}
            value={filters.path}
            onChange={(e) => onFilterChange({ path: e.target.value })}
            className="mt-1"
          />
        </div>

        <div>
          <label htmlFor="search-filter" className={LABEL_CLASS}>
            {t('search_label')}
          </label>
          <Input
            id="search-filter"
            type="text"
            placeholder={t('search_placeholder')}
            value={filters.search}
            onChange={(e) => onFilterChange({ search: e.target.value })}
            className="mt-1"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className={LABEL_CLASS}>{t('view_label')}</span>
        <Button
          type="button"
          variant={viewMode === 'tree' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => onViewModeChange('tree')}
        >
          {t('view_tree')}
        </Button>
        <Button
          type="button"
          variant={viewMode === 'list' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => onViewModeChange('list')}
        >
          {t('view_list')}
        </Button>
      </div>
    </form>
  );
}
