import { ChevronRight, Clock, Folder, FolderOpen, HardDrive, Home } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import { platform } from '@/platform';
import type { DirectoryNode } from '@/platform/contracts';
import { cn } from '@/shared/lib/utils';

interface CollageFolderTreeProps {
  /** 当前打开的直览文件夹（选中态） */
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

interface TreeRoot {
  label: string;
  path: string;
  kind: 'recent' | 'home' | 'volume';
}

interface TreeState {
  /** 展开中的目录（折叠后保留缓存，再次展开不重新枚举） */
  expanded: Set<string>;
  /** 正在枚举子目录的集合 */
  loading: Set<string>;
  /** 已枚举过的子目录缓存 */
  cache: Map<string, DirectoryNode[]>;
}

function pathSeparator(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

function baseName(path: string): string {
  const separator = pathSeparator(path);
  return path.slice(path.lastIndexOf(separator) + 1) || path;
}

function parentPath(path: string): string | null {
  const separator = pathSeparator(path);
  const index = path.lastIndexOf(separator);
  if (index <= 0) {
    return null;
  }
  const parent = path.slice(0, index);
  return parent === '' ? null : parent;
}

/** 自文件夹路径推导从根到父级的祖先链，用于恢复选中目录时自动展开到可见。 */
function ancestorPaths(path: string): string[] {
  const chain: string[] = [];
  let current = parentPath(path);
  while (current && !chain.includes(current)) {
    chain.push(current);
    current = parentPath(current);
  }
  return chain.reverse();
}

/**
 * 文件夹树：根节点为「最近使用 / 用户主目录 / 外接磁盘」，展开时按需枚举子目录，
 * 不做递归扫描。选中目录驱动右侧图片预览栏加载。
 */
export function CollageFolderTree({ selectedPath, onSelect }: CollageFolderTreeProps) {
  const recentFolders = useCollageStore((state) => state.recentFolders);
  const [rootNodes, setRootNodes] = useState<TreeRoot[]>([]);
  const [tree, setTree] = useState<TreeState>(() => ({
    expanded: new Set<string>(),
    loading: new Set<string>(),
    cache: new Map<string, DirectoryNode[]>(),
  }));
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const inflightRef = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    platform.files
      .listRootDirectories()
      .then((roots) => {
        if (cancelled) {
          return;
        }
        setRootNodes(
          roots.map((root) => ({
            label: root.label,
            path: root.path,
            kind: root.kind === 'home' ? 'home' : 'volume',
          })),
        );
      })
      .catch((error) => console.warn('[collage] 枚举根目录失败:', error));
    return () => {
      cancelled = true;
    };
  }, []);

  const loadChildren = useCallback((path: string) => {
    if (inflightRef.current.has(path)) {
      return;
    }
    inflightRef.current.add(path);
    setTree((prev) => ({ ...prev, loading: new Set(prev.loading).add(path) }));

    platform.files
      .listSubdirectories(path)
      .then((children) => {
        setTree((prev) => {
          const cache = new Map(prev.cache);
          cache.set(path, children);
          const loading = new Set(prev.loading);
          loading.delete(path);
          return { ...prev, cache, loading };
        });
      })
      .catch((error) => {
        console.warn('[collage] 枚举子目录失败:', path, error);
        setTree((prev) => {
          const loading = new Set(prev.loading);
          loading.delete(path);
          return { ...prev, loading };
        });
      })
      .finally(() => {
        inflightRef.current.delete(path);
      });
  }, []);

  /** 幂等展开：已展开则跳过；缓存命中时不重新枚举。 */
  const expand = useCallback(
    (path: string) => {
      setTree((prev) => {
        if (prev.expanded.has(path)) {
          return prev;
        }
        return { ...prev, expanded: new Set(prev.expanded).add(path) };
      });
      if (!treeRef.current.cache.has(path)) {
        loadChildren(path);
      }
    },
    [loadChildren],
  );

  const toggleExpand = useCallback(
    (path: string) => {
      setTree((prev) => {
        if (prev.expanded.has(path)) {
          const expanded = new Set(prev.expanded);
          expanded.delete(path);
          return { ...prev, expanded };
        }
        return { ...prev, expanded: new Set(prev.expanded).add(path) };
      });
      if (!treeRef.current.cache.has(path)) {
        loadChildren(path);
      }
    },
    [loadChildren],
  );

  // 选中目录不在可见链上时（重启恢复、从最近列表点入），逐级展开祖先让它出现在树里
  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    let cancelled = false;
    void (async () => {
      for (const ancestor of ancestorPaths(selectedPath)) {
        if (cancelled) {
          return;
        }
        expand(ancestor);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expand, selectedPath]);

  const roots = useMemo(() => {
    const homeRoots = rootNodes.filter((root) => root.kind === 'home');
    const volumeRoots = rootNodes.filter((root) => root.kind === 'volume');
    const homePaths = new Set(homeRoots.map((root) => root.path));
    const volumePaths = new Set(volumeRoots.map((root) => root.path));
    const recentRoots = recentFolders
      .filter((path) => !homePaths.has(path) && !volumePaths.has(path))
      .map((path) => ({ label: baseName(path), path, kind: 'recent' as const }));

    return [
      { title: '最近使用', items: recentRoots },
      { title: '主目录', items: homeRoots },
      { title: '磁盘', items: volumeRoots },
    ].filter((section) => section.items.length > 0);
  }, [recentFolders, rootNodes]);

  const renderChevron = (path: string) => {
    const isExpanded = tree.expanded.has(path);
    const isLoading = tree.loading.has(path);

    return (
      <button
        type="button"
        aria-label={isExpanded ? '折叠目录' : '展开目录'}
        className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation();
          toggleExpand(path);
        }}
      >
        <ChevronRight
          className={cn(
            'size-3 transition-transform',
            isExpanded && 'rotate-90',
            isLoading && 'animate-pulse',
          )}
        />
      </button>
    );
  };

  const rowClass = (isSelected: boolean) =>
    cn(
      'flex h-7 items-center gap-1 pr-2 text-xs transition-colors',
      isSelected ? 'bg-primary/12 text-primary' : 'text-foreground/90 hover:bg-muted/60',
    );

  const renderNode = (node: DirectoryNode, depth: number) => {
    const isExpanded = tree.expanded.has(node.path);
    const isSelected = selectedPath === node.path;

    return (
      <div key={node.path}>
        <div className={rowClass(isSelected)} style={{ paddingLeft: `${8 + depth * 12}px` }}>
          {renderChevron(node.path)}
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => {
              if (!isExpanded) {
                expand(node.path);
              }
              onSelect(node.path);
            }}
          >
            {isExpanded ? (
              <FolderOpen className="size-3.5 shrink-0 text-primary/80" />
            ) : (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
        </div>
        {isExpanded && tree.cache.get(node.path)?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="shrink-0 border-b border-border/80 px-3 py-2">
        <h2 className="text-xs font-semibold">文件夹</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1.5">
        {roots.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-muted-foreground">正在读取根目录…</p>
        ) : (
          roots.map((section) => (
            <div key={section.title} className="mb-1.5 last:mb-0">
              <p className="px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground">
                {section.title}
              </p>
              {section.items.map((root) => {
                const isSelected = selectedPath === root.path;
                const RootIcon =
                  root.kind === 'recent' ? Clock : root.kind === 'home' ? Home : HardDrive;

                return (
                  <div key={root.path}>
                    <div className={rowClass(isSelected)} style={{ paddingLeft: '8px' }}>
                      {renderChevron(root.path)}
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        onClick={() => {
                          if (!tree.expanded.has(root.path)) {
                            expand(root.path);
                          }
                          onSelect(root.path);
                        }}
                      >
                        <RootIcon
                          className={cn(
                            'size-3.5 shrink-0',
                            isSelected ? 'text-primary/80' : 'text-muted-foreground',
                          )}
                        />
                        <span className="truncate">{root.label}</span>
                      </button>
                    </div>
                    {tree.expanded.has(root.path) &&
                      tree.cache.get(root.path)?.map((child) => renderNode(child, 1))}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
