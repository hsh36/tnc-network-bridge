import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LOG_SOURCES, type LogEntry, type LogLevel, type LogSource } from '../../shared';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Select } from '../components/ui/Input';
import { type LogsFilter, useLogs } from '../hooks/useLogs';

const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const levelTone: Record<LogLevel, BadgeTone> = {
  trace: 'idle',
  debug: 'idle',
  info: 'accent',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

const sourceColor: Record<LogSource, BadgeTone> = {
  app: 'idle',
  sync: 'accent',
  smb: 'accent',
  lock: 'warn',
  auth: 'warn',
  audit: 'warn',
  update: 'accent',
  system: 'idle',
};

interface TimeRange {
  readonly label: string;
  readonly since: number | undefined;
  readonly until: number | undefined;
}

const TIME_RANGES: readonly TimeRange[] = [
  { label: 'Last hour', since: Date.now() - 60 * 60 * 1000, until: undefined },
  { label: 'Last 24h', since: Date.now() - 24 * 60 * 60 * 1000, until: undefined },
  { label: 'Last 7d', since: Date.now() - 7 * 24 * 60 * 60 * 1000, until: undefined },
  { label: 'Last 30d', since: Date.now() - 30 * 24 * 60 * 60 * 1000, until: undefined },
  { label: 'Any', since: undefined, until: undefined },
];

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

function toCsv(rows: readonly LogEntry[]): string {
  const header = ['id', 'ts', 'level', 'source', 'message', 'requestId', 'shareId'];
  const escape = (v: string | number | null | undefined): string => {
    const str = v === null || v === undefined ? '' : String(v);
    return `"${str.replace(/"/g, '""')}"`;
  };
  const lines = rows.map((r) =>
    [
      r.id,
      new Date(r.ts).toISOString(),
      r.level,
      r.source,
      r.message,
      r.requestId ?? '',
      r.shareId ?? '',
    ]
      .map(escape)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

function toJson(rows: readonly LogEntry[]): string {
  return JSON.stringify(rows, null, 2);
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

type ExpandedState = Record<number, boolean>;

export function Logs(): JSX.Element {
  // Parse URL params for deep linking
  const params = new URLSearchParams(window.location.search);
  const [level, setLevel] = useState<LogLevel | ''>((params.get('level') as LogLevel | null) ?? '');
  const [source, setSource] = useState<LogSource | ''>(
    (params.get('source') as LogSource | null) ?? '',
  );
  const [share, setShare] = useState<number | ''>(() => {
    const s = params.get('share');
    return s ? Number(s) : '';
  });
  const [q, setQ] = useState(params.get('q') ?? '');
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[0]!);
  const [customSince, setCustomSince] = useState<string>('');
  const [customUntil, setCustomUntil] = useState<string>('');
  const [useCustom, setUseCustom] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [expandedRows, setExpandedRows] = useState<ExpandedState>({});
  const [inMemorySearch, setInMemorySearch] = useState('');
  const [searchMatch, setSearchMatch] = useState<number>(0);
  const [searchTotal, setSearchTotal] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filter: LogsFilter = useMemo(
    () => ({
      level,
      source,
      share: share !== '' ? share : '',
      since: useCustom && customSince ? new Date(customSince).getTime() : timeRange.since,
      until: useCustom && customUntil ? new Date(customUntil).getTime() : timeRange.until,
      q,
    }),
    [level, source, share, timeRange, useCustom, customSince, customUntil, q],
  );

  const logs = useLogs(filter, { live: true, maxLiveEvents: 10_000 });

  // Update URL on filter change
  useEffect(() => {
    const newParams = new URLSearchParams();
    if (level !== '') newParams.set('level', level);
    if (source !== '') newParams.set('source', source);
    if (share !== '') newParams.set('share', String(share));
    if (q !== '') newParams.set('q', q);
    const newUrl = newParams.toString() ? `?${newParams}` : window.location.pathname;
    window.history.replaceState({}, '', newUrl);
  }, [level, source, share, q]);

  // Search functionality
  useEffect(() => {
    if (inMemorySearch.trim() === '') {
      setSearchTotal(0);
      setSearchMatch(0);
      return;
    }
    const matches = logs.logs.filter((log) =>
      log.message.toLowerCase().includes(inMemorySearch.toLowerCase()),
    );
    setSearchTotal(matches.length);
    setSearchMatch(Math.min(searchMatch, Math.max(0, matches.length - 1)));
  }, [inMemorySearch, logs.logs, searchMatch]);

  const filteredLogs = useMemo(() => {
    if (inMemorySearch.trim() === '') return logs.logs;
    return logs.logs.filter((log) =>
      log.message.toLowerCase().includes(inMemorySearch.toLowerCase()),
    );
  }, [logs.logs, inMemorySearch]);

  const toggleRowSelection = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleRowExpanded = useCallback((id: number) => {
    setExpandedRows((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  }, []);

  const selectedLogs = filteredLogs.filter((l) => selectedIds.has(l.id));

  const handleExportCsv = () => {
    const content = toCsv(selectedLogs.length > 0 ? selectedLogs : filteredLogs);
    const filename = `tnc-bridge-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    downloadFile(content, filename, 'text/csv');
  };

  const handleExportJson = () => {
    const content = toJson(selectedLogs.length > 0 ? selectedLogs : filteredLogs);
    const filename = `tnc-bridge-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    downloadFile(content, filename, 'application/json');
  };

  const handleClearFilters = () => {
    setLevel('');
    setSource('');
    setShare('');
    setQ('');
    setTimeRange(TIME_RANGES[0]!);
    setUseCustom(false);
    setSelectedIds(new Set());
  };

  const handleNavigateSearch = (direction: 'next' | 'prev') => {
    if (inMemorySearch.trim() === '') return;
    const matches = logs.logs.filter((log) =>
      log.message.toLowerCase().includes(inMemorySearch.toLowerCase()),
    );
    if (matches.length === 0) return;

    let newMatch = searchMatch;
    if (direction === 'next') {
      newMatch = (searchMatch + 1) % matches.length;
    } else {
      newMatch = (searchMatch - 1 + matches.length) % matches.length;
    }
    setSearchMatch(newMatch);

    // Scroll to match
    const match = matches[newMatch];
    if (match !== undefined) {
      const element = document.querySelector(`[data-log-id="${match.id}"]`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Logs</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {logs.live ? 'Live tail' : 'Historical logs'} — {logs.total.toLocaleString()} total
            entries
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant={logs.live ? 'primary' : 'secondary'} size="sm" onClick={logs.toggleLive}>
            {logs.live ? '● Live' : '○ Live'}
          </Button>
          {logs.live && (
            <Button variant="secondary" size="sm" onClick={logs.togglePause}>
              {logs.paused ? '▶ Resume' : '⏸ Pause'}
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader title="Filters" />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Select
              id="level"
              label="Level"
              value={level}
              onChange={(e) => setLevel(e.target.value as LogLevel | '')}
              className="w-32"
            >
              <option value="">Any</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>

            <Select
              id="source"
              label="Source"
              value={source}
              onChange={(e) => setSource(e.target.value as LogSource | '')}
              className="w-36"
            >
              <option value="">Any</option>
              {LOG_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>

            <Input
              id="q"
              label="Search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Message contains…"
              className="min-w-[14rem] flex-1"
            />

            <Select
              id="timeRange"
              label="Time Range"
              value={useCustom ? 'custom' : TIME_RANGES.indexOf(timeRange).toString()}
              onChange={(e) => {
                if (e.target.value === 'custom') {
                  setUseCustom(true);
                } else {
                  setUseCustom(false);
                  const idx = Number(e.target.value);
                  if (idx >= 0 && idx < TIME_RANGES.length) {
                    setTimeRange(TIME_RANGES[idx]!);
                  }
                }
              }}
              className="w-40"
            >
              {TIME_RANGES.map((tr, i) => (
                <option key={i} value={i}>
                  {tr.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </Select>

            {(level !== '' || source !== '' || share !== '' || q !== '') && (
              <Button variant="secondary" size="sm" onClick={handleClearFilters}>
                Clear filters
              </Button>
            )}
          </div>

          {useCustom && (
            <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3 dark:border-border-dark">
              <Input
                id="since"
                label="Since"
                type="datetime-local"
                value={customSince}
                onChange={(e) => setCustomSince(e.target.value)}
                className="w-40"
              />
              <Input
                id="until"
                label="Until"
                type="datetime-local"
                value={customUntil}
                onChange={(e) => setCustomUntil(e.target.value)}
                className="w-40"
              />
            </div>
          )}
        </CardBody>
      </Card>

      {inMemorySearch.trim() !== '' && (
        <Card>
          <CardBody className="flex items-center justify-between gap-3">
            <div className="text-sm text-slate-600 dark:text-slate-400">
              {searchTotal === 0 ? 'No matches' : `Match ${searchMatch + 1} of ${searchTotal}`}
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleNavigateSearch('prev')}
                disabled={searchTotal === 0}
              >
                ← Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleNavigateSearch('next')}
                disabled={searchTotal === 0}
              >
                Next →
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Entries"
          subtitle={`${filteredLogs.length} displayed${selectedIds.size > 0 ? `, ${selectedIds.size} selected` : ''}`}
        />
        <CardBody className="space-y-3">
          <Input
            id="inMemorySearch"
            label="Find in displayed logs"
            value={inMemorySearch}
            onChange={(e) => setInMemorySearch(e.target.value)}
            placeholder="Search within results…"
            className="min-w-[14rem]"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleExportCsv}
              disabled={filteredLogs.length === 0}
            >
              Export CSV {selectedIds.size > 0 && `(${selectedIds.size})`}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleExportJson}
              disabled={filteredLogs.length === 0}
            >
              Export JSON {selectedIds.size > 0 && `(${selectedIds.size})`}
            </Button>
            {selectedIds.size > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setSelectedIds(new Set())}>
                Deselect all
              </Button>
            )}
            {logs.live && logs.logs.length > 0 && (
              <Button variant="secondary" size="sm" onClick={logs.clearLogs}>
                Clear live logs
              </Button>
            )}
          </div>

          <div ref={listRef} className="overflow-auto max-h-[600px]">
            {filteredLogs.length === 0 ? (
              <EmptyState
                title="No log entries"
                description="Nothing matches the current filters yet."
              />
            ) : (
              <div className="space-y-0">
                {filteredLogs.map((log) => (
                  <div key={log.id}>
                    <div
                      data-log-id={log.id}
                      className="border-b border-border px-3 py-2 hover:bg-slate-50 dark:border-border-dark dark:hover:bg-slate-800/50"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(log.id)}
                          onChange={() => toggleRowSelection(log.id)}
                          className="h-4 w-4"
                        />
                        <button
                          onClick={() => toggleRowExpanded(log.id)}
                          className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex-shrink-0"
                        >
                          {expandedRows[log.id] ? '▼' : '▶'}
                        </button>
                        <span className="text-xs text-slate-500 dark:text-slate-400 min-w-[160px]">
                          {formatDate(log.ts)}
                        </span>
                        <Badge tone={levelTone[log.level]} className="flex-shrink-0">
                          {log.level}
                        </Badge>
                        <Badge tone={sourceColor[log.source]} className="flex-shrink-0">
                          {log.source}
                        </Badge>
                        <span className="text-sm break-words flex-1 min-w-0">
                          {inMemorySearch.trim() !== '' &&
                            (() => {
                              const lower = log.message.toLowerCase();
                              const searchLower = inMemorySearch.toLowerCase();
                              const index = lower.indexOf(searchLower);
                              if (index === -1) return log.message;
                              return (
                                <>
                                  {log.message.substring(0, index)}
                                  <mark className="rounded bg-yellow-200 dark:bg-yellow-700">
                                    {log.message.substring(index, index + inMemorySearch.length)}
                                  </mark>
                                  {log.message.substring(index + inMemorySearch.length)}
                                </>
                              );
                            })()}
                        </span>
                      </div>
                    </div>
                    {expandedRows[log.id] && (
                      <div className="border-b border-border bg-slate-50 px-6 py-3 dark:border-border-dark dark:bg-slate-900/50">
                        <div className="space-y-2 font-mono text-xs">
                          <div>
                            <span className="text-slate-500 dark:text-slate-400">ID:</span> {log.id}
                          </div>
                          <div>
                            <span className="text-slate-500 dark:text-slate-400">
                              Full message:
                            </span>
                            <p className="mt-1 break-words text-slate-700 dark:text-slate-300">
                              {log.message}
                            </p>
                          </div>
                          {log.requestId && (
                            <div>
                              <span className="text-slate-500 dark:text-slate-400">
                                Request ID:
                              </span>{' '}
                              {log.requestId}
                            </div>
                          )}
                          {log.shareId && (
                            <div>
                              <span className="text-slate-500 dark:text-slate-400">Share ID:</span>{' '}
                              {log.shareId}
                            </div>
                          )}
                          {log.context && (
                            <div>
                              <span className="text-slate-500 dark:text-slate-400">Context:</span>
                              <pre className="mt-1 overflow-auto bg-slate-200 p-2 dark:bg-slate-800 text-slate-800 dark:text-slate-200">
                                {JSON.stringify(log.context, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      {logs.error && (
        <Card className="border-status-error/40">
          <CardBody>
            <p className="text-sm text-status-error">
              {logs.live ? 'Live stream error: ' : 'Load error: '}
              {logs.error.message}
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
