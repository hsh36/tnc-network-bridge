import { useEffect, useState } from 'react';
import { type FileIndexEntry } from '../../shared';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';
import { api, ApiError } from '../lib/api-client';

const PREVIEW_MAX_LINES = 100;

export function FilePreview({
  file,
  onClose,
}: {
  readonly file: FileIndexEntry;
  readonly onClose: () => void;
}): JSX.Element {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(undefined);

    // In a real implementation, we would fetch the content from the backend
    // For now, we'll show a placeholder message
    setContent('Text preview not yet implemented. Download the file to view its content.');
    setLoading(false);
  }, [file]);

  const lines = content.split('\n');
  const visibleLines = showAll ? lines : lines.slice(0, PREVIEW_MAX_LINES);
  const hasMore = lines.length > PREVIEW_MAX_LINES;

  return (
    <Card className="mt-4">
      <CardHeader
        title={`Preview: ${file.relPath}`}
        action={
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        }
      />
      <CardBody className="p-0">
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Spinner />
          </div>
        ) : error ? (
          <div className="bg-status-error/5 p-4 text-sm text-status-error">{error}</div>
        ) : (
          <div className="space-y-2 bg-slate-50 p-4 font-mono text-xs dark:bg-surface-dark-subtle">
            {visibleLines.map((line, i) => (
              <div key={i} className="flex gap-4">
                <span className="w-8 flex-shrink-0 text-right text-slate-400 dark:text-slate-500">
                  {i + 1}
                </span>
                <span className="flex-1 whitespace-pre-wrap break-words text-slate-900 dark:text-slate-100">
                  {line || ' '}
                </span>
              </div>
            ))}

            {hasMore && !showAll && (
              <div className="pt-2">
                <Button variant="secondary" size="sm" onClick={() => setShowAll(true)}>
                  Show all {lines.length} lines
                </Button>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
