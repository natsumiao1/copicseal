import { ChevronRight, Folder, FolderOpen, HardDrive, Home, Monitor, Star } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { platform } from '@/platform';
import type { DirectoryNode } from '@/platform/contracts';
import { cn } from '@/shared/lib/utils';
import { useFileSourceStore } from '@/shared/store/use-file-source-store';

interface TreeRoot {
  label: string;
  path: string;
  /** `home` 用户磁盘 / `system` 系统卷（Macintosh HD） / `volume` 其他磁盘 */
  kind: 'home' | 'system' | 'volume';
}

/** 「计算机」虚拟根节点的占位路径：没有真实路径，展开态只在前端维护。 */
const COMPUTER_NODE = '__computer__';

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
 * 文件夹树（文件夹边栏）：唯一顶级入口是「计算机」，其下依次是
 * 「用户磁盘」（用户主目录）、「Macintosh HD」（系统卷；Windows 为各盘符）
 * 与外接磁盘，展开时按需枚举子目录，不做递归扫描。选中目录驱动右侧内容边栏加载。
 *
 * 文件来源是全局通用能力：当前文件夹来自 `useFileSourceStore`，
 * 拼图与边框水印共用同一棵树。本栏是停靠布局里的「文件夹」面板，标题、移动、
 * 合并与关闭统一由面板 tab 条承担，这里不再自设表头。
 *
 * 行尾提供收藏星标：收藏 / 取消收藏的是文件夹本身，收藏项在同组的「收藏夹」
 * tab 里集中展示（不收藏文件）。
 */
export function CoFolderTree() {
  const folderPath = useFileSourceStore((state) => state.folderPath);
  const favoriteFolders = useFileSourceStore((state) => state.favoriteFolders);
  const openFolder = useFileSourceStore((state) => state.openFolder);
  const toggleFavoriteFolder = useFileSourceStore((state) => state.toggleFavoriteFolder);
  const [rootNodes, setRootNodes] = useState<TreeRoot[]>([]);
  const [tree, setTree] = useState<TreeState>(() => ({
    // 「计算机」默认展开：打开面板即看到磁盘列表
    expanded: new Set<string>([COMPUTER_NODE]),
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
            kind: root.kind === 'home' ? 'home' : root.kind === 'system' ? 'system' : 'volume',
          })),
        );
      })
      .catch((error) => console.warn('[file-source] 枚举根目录失败:', error));
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
        console.warn('[file-source] 枚举子目录失败:', path, error);
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

  /** 幂等展开：已展开则跳过；缓存命中时不重新枚举。「计算机」是虚拟节点，直接切展开态。 */
  const expand = useCallback(
    (path: string) => {
      setTree((prev) => {
        if (prev.expanded.has(path)) {
          return prev;
        }
        return { ...prev, expanded: new Set(prev.expanded).add(path) };
      });
      if (path !== COMPUTER_NODE && !treeRef.current.cache.has(path)) {
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
      if (path !== COMPUTER_NODE && !treeRef.current.cache.has(path)) {
        loadChildren(path);
      }
    },
    [loadChildren],
  );

  // 选中目录不在可见链上时（重启恢复持久化选中），逐级展开祖先让它出现在树里
  useEffect(() => {
    if (!folderPath) {
      return;
    }
    let cancelled = false;
    void (async () => {
      for (const ancestor of ancestorPaths(folderPath)) {
        if (cancelled) {
          return;
        }
        expand(ancestor);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expand, folderPath]);

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

  /**
   * 行尾收藏星标：未收藏时只在 hover 该行时浮现，已收藏常显填充星。
   * 星标与行内选中按钮是同级兄弟，点击不会触发目录选中。
   */
  const renderFavorite = (path: string) => {
    const isFavorite = favoriteFolders.includes(path);

    return (
      <button
        type="button"
        aria-label={isFavorite ? '取消收藏该文件夹' : '收藏该文件夹'}
        title={isFavorite ? '取消收藏' : '收藏'}
        className={cn(
          'ml-auto flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:text-foreground',
          isFavorite
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        )}
        onClick={() => {
          toggleFavoriteFolder(path);
        }}
      >
        <Star className={cn('size-3', isFavorite && 'fill-current text-amber-500')} />
      </button>
    );
  };

  const rowClass = (isSelected: boolean) =>
    cn(
      'group flex h-7 items-center gap-1 pr-2 text-xs transition-colors',
      isSelected ? 'bg-primary/12 text-primary' : 'text-foreground/90 hover:bg-muted/60',
    );

  const renderNode = (node: DirectoryNode, depth: number) => {
    const isExpanded = tree.expanded.has(node.path);
    const isSelected = folderPath === node.path;

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
              openFolder(node.path);
            }}
          >
            {isExpanded ? (
              <FolderOpen className="size-3.5 shrink-0 text-primary/80" />
            ) : (
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
          {renderFavorite(node.path)}
        </div>
        {isExpanded && tree.cache.get(node.path)?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1.5">
        {rootNodes.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-muted-foreground">正在读取根目录…</p>
        ) : (
          <div>
            <div className={rowClass(false)} style={{ paddingLeft: '8px' }}>
              {renderChevron(COMPUTER_NODE)}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => toggleExpand(COMPUTER_NODE)}
              >
                <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">计算机</span>
              </button>
            </div>
            {tree.expanded.has(COMPUTER_NODE) &&
              rootNodes.map((root) => {
                const isSelected = folderPath === root.path;
                const RootIcon = root.kind === 'home' ? Home : HardDrive;

                return (
                  <div key={root.path}>
                    <div className={rowClass(isSelected)} style={{ paddingLeft: '20px' }}>
                      {renderChevron(root.path)}
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        onClick={() => {
                          if (!tree.expanded.has(root.path)) {
                            expand(root.path);
                          }
                          openFolder(root.path);
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
                      {renderFavorite(root.path)}
                    </div>
                    {tree.expanded.has(root.path) &&
                      tree.cache.get(root.path)?.map((child) => renderNode(child, 2))}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
