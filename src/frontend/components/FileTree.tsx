import { useMemo, useState } from 'react';
import { type FileIndexEntry } from '../../shared';
import { cn } from './ui/cn';

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  file?: FileIndexEntry;
  children?: Record<string, TreeNode>;
}

function buildFileTree(items: readonly FileIndexEntry[]): TreeNode[] {
  const root: Record<string, TreeNode> = {};

  // Sort items to process directories before files
  const sorted = [...items].sort((a, b) => {
    if (a.isDir !== b.isDir) return b.isDir ? 1 : -1;
    return a.relPath.localeCompare(b.relPath);
  });

  for (const item of sorted) {
    const parts = item.relPath.split('/').filter((p) => p.length > 0);

    // Type-safe helper to get or create node
    const getOrCreate = (map: Record<string, TreeNode>, part: string): TreeNode => {
      let node = map[part];
      if (node) return node;

      node = {
        name: part,
        path: '',
        isDir: false,
        children: {},
      };
      map[part] = node;
      return node;
    };

    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      const node = getOrCreate(current, part);
      node.path = parts.slice(0, i + 1).join('/');

      if (isLast) {
        node.isDir = item.isDir;
        node.file = item;
      } else {
        node.isDir = true;
      }

      node.children ??= {};
      current = node.children;
    }
  }

  return Object.values(root);
}

function TreeNodeComponent({
  node,
  selectedFile,
  onSelectFile,
  level = 0,
}: {
  readonly node: TreeNode;
  readonly selectedFile?: FileIndexEntry;
  readonly onSelectFile: (file: FileIndexEntry) => void;
  readonly level?: number;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const children = useMemo(
    () =>
      Object.values(node.children ?? {}).sort((a, b) => {
        if (a.isDir !== b.isDir) return b.isDir ? 1 : -1;
        return a.name.localeCompare(b.name);
      }),
    [node.children],
  );

  const isSelected = node.file && selectedFile?.id === node.file.id;

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors',
          isSelected && 'bg-accent/10 text-accent',
        )}
        style={{ paddingLeft: `${level * 1.5 + 0.75}rem` }}
        onClick={() => {
          if (node.file) {
            onSelectFile(node.file);
          } else if (node.isDir) {
            setExpanded(!expanded);
          }
        }}
        role="button"
        tabIndex={0}
      >
        {node.isDir && <span className="text-xs">{expanded ? '▼' : '▶'}</span>}
        {!node.isDir && <span className="text-xs opacity-0">▶</span>}

        <span className="text-base">{node.isDir ? '📁' : '📄'}</span>

        <span className="flex-1 truncate">{node.name}</span>
      </div>

      {node.isDir && expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNodeComponent
              key={child.path}
              node={child}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  items,
  selectedFile,
  onSelectFile,
}: {
  readonly items: readonly FileIndexEntry[];
  readonly selectedFile?: FileIndexEntry;
  readonly onSelectFile: (file: FileIndexEntry) => void;
}): JSX.Element {
  const tree = useMemo(() => buildFileTree(items), [items]);

  return (
    <div className="divide-y divide-border overflow-y-auto dark:divide-border-dark max-h-96">
      {tree.map((node) => (
        <TreeNodeComponent
          key={node.path}
          node={node}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}
