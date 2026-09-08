import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { Spinner } from '../components/ui/Spinner';
import { useApiQuery } from '../hooks/useApi';
import { FilePreview } from '../components/FilePreview';
import { FileTree } from '../components/FileTree';
import { SearchBar } from '../components/SearchBar';
import { VersionTimeline } from '../components/VersionTimeline';
import { type FileIndexEntry } from '../../shared';
import { cn } from '../components/ui/cn';

const STATE_TONE: Record<string, BadgeTone> = {
  new: 'idle',
  synced: 'ok',
  pending_push: 'warn',
  pending_pull: 'warn',
  conflict: 'error',
  deferred_locked: 'warn',
  error: 'error',
  excluded: 'idle',
};

const STATE_LABEL: Record<string, string> = {
  new: 'New',
  synced: 'Synced',
  pending_push: 'Pending push',
  pending_pull: 'Pending pull',
  conflict: 'Conflict',
  deferred_locked: 'Locked',
  error: 'Error',
  excluded: 'Excluded',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

interface FilterState {
  share: number;
  path: string;
  state: string;
  search: string;
}

export function FilesBrowserPage(): JSX.Element {
  const [viewMode, setViewMode] = useState<'tree' | 'list'>('tree');
  const [filters, setFilters] = useState<FilterState>({
    share: 1,
    path: '',
    state: 'all',
    search: '',
  });
  const [selectedFile, setSelectedFile] = useState<FileIndexEntry | undefined>();
  const [previewFile, setPreviewFile] = useState<FileIndexEntry | undefined>();

  // Fetch files
  const files = useApiQuery(
    'files.list',
    {
      query: {
        share: filters.share,
        ...(filters.path.length > 0 ? { path: filters.path } : {}),
        ...(filters.state !== 'all' ? { state: filters.state } : {}),
        ...(filters.search.length > 0 ? { q: filters.search } : {}),
        limit: 1000,
        offset: 0,
      },
    },
    { deps: [filters.share, filters.path, filters.state, filters.search] },
  );

  // Get system status for shares (shares are currently empty in Phase 1, but structure is ready)
  const status = useApiQuery('status.get', {}, {});

  const handleFilterChange = (newFilters: Partial<FilterState>): void => {
    setFilters((prev) => ({ ...prev, ...newFilters }));
  };

  const handleSelectFile = (file: FileIndexEntry): void => {
    setSelectedFile(file);
    setPreviewFile(undefined);
  };

  const shareList = useMemo(() => {
    if (!status.data?.shares) return [];
    // Status endpoint returns shares array
    return Array.isArray(status.data.shares) ? status.data.shares : [];
  }, [status.data?.shares]);

  if (files.loading && !files.data) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner />
      </div>
    );
  }

  const fileItems = files.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">File Browser</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Browse synchronized files and their version history
        </p>
      </div>

      {/* Filter bar */}
      <SearchBar
        filters={filters}
        shareList={shareList}
        onFilterChange={handleFilterChange}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* File list */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title={
                <div className="flex items-center justify-between">
                  <span>Files</span>
                  <span className="text-xs font-normal text-slate-500">
                    {files.data?.total ?? 0} total
                  </span>
                </div>
              }
            />
            <CardBody className="p-0">
              {fileItems.length === 0 ? (
                <div className="p-8">
                  <EmptyState
                    title="No files found"
                    description="Try adjusting your filters or search query"
                  />
                </div>
              ) : viewMode === 'tree' ? (
                <FileTree
                  items={fileItems}
                  selectedFile={selectedFile}
                  onSelectFile={handleSelectFile}
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border dark:border-border-dark">
                        <th className="px-4 py-3 text-left font-medium text-slate-600 dark:text-slate-400">
                          Path
                        </th>
                        <th className="px-4 py-3 text-right font-medium text-slate-600 dark:text-slate-400">
                          Size
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-slate-600 dark:text-slate-400">
                          Status
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-slate-600 dark:text-slate-400">
                          Modified
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {fileItems.map((file) => {
                        const size = file.local?.size ?? file.remote?.size ?? 0;
                        const mtime = file.local?.mtime ?? file.remote?.mtime ?? 0;
                        return (
                          <tr
                            key={file.id}
                            className={cn(
                              'border-b border-border hover:bg-slate-50 dark:border-border-dark dark:hover:bg-slate-800',
                              selectedFile?.id === file.id && 'bg-accent/5',
                            )}
                            onClick={() => handleSelectFile(file)}
                            role="button"
                            tabIndex={0}
                          >
                            <td className="px-4 py-3 font-mono text-xs">{file.relPath}</td>
                            <td className="px-4 py-3 text-right text-xs">{formatBytes(size)}</td>
                            <td className="px-4 py-3">
                              <Badge tone={STATE_TONE[file.state] ?? 'idle'}>
                                {STATE_LABEL[file.state] ?? file.state}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 text-xs">
                              {mtime > 0 ? new Date(mtime).toLocaleString() : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        {/* Details panel */}
        <div className="space-y-4">
          {selectedFile ? (
            <>
              <Card>
                <CardHeader title="File Details" />
                <CardBody className="space-y-3 text-sm">
                  <div>
                    <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">Path</p>
                    <p className="mt-1 break-all font-mono text-xs text-slate-900 dark:text-slate-100">
                      {selectedFile.relPath}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                      Status
                    </p>
                    <Badge tone={STATE_TONE[selectedFile.state] ?? 'idle'}>
                      {STATE_LABEL[selectedFile.state] ?? selectedFile.state}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                        Size
                      </p>
                      <p className="mt-1 text-xs">
                        {formatBytes(selectedFile.local?.size ?? selectedFile.remote?.size ?? 0)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                        Type
                      </p>
                      <p className="mt-1 text-xs">{selectedFile.isDir ? 'Directory' : 'File'}</p>
                    </div>
                  </div>

                  {selectedFile.lastSyncAt && (
                    <div>
                      <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                        Last Synced
                      </p>
                      <p className="mt-1 text-xs">
                        {new Date(selectedFile.lastSyncAt * 1000).toLocaleString()}
                      </p>
                    </div>
                  )}

                  {selectedFile.lastError && (
                    <div className="rounded border border-status-error/20 bg-status-error/5 p-2">
                      <p className="text-xs font-semibold text-status-error">Error</p>
                      <p className="mt-1 text-xs text-status-error/80">{selectedFile.lastError}</p>
                    </div>
                  )}
                </CardBody>
              </Card>

              {!selectedFile.isDir && (
                <>
                  <Button size="sm" onClick={() => setPreviewFile(selectedFile)} className="w-full">
                    Preview
                  </Button>

                  {previewFile && (
                    <FilePreview file={previewFile} onClose={() => setPreviewFile(undefined)} />
                  )}
                </>
              )}

              <VersionTimeline file={selectedFile} />
            </>
          ) : (
            <Card>
              <CardBody>
                <EmptyState
                  title="Select a file"
                  description="Click a file to view details and version history"
                />
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
