import { Folder, Star } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { useFileSourceStore } from '@/shared/store/use-file-source-store';

function pathSeparator(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

function baseName(path: string): string {
  const separator = pathSeparator(path);
  return path.slice(path.lastIndexOf(separator) + 1) || path;
}

/**
 * 收藏夹面板：集中展示从文件夹面板收藏的文件夹，点击即切换到该目录。
 *
 * 收藏数据来自 `useFileSourceStore.favoriteFolders`（只收藏文件夹，不收藏文件），
 * 与文件夹面板同处一个停靠面板组的两个 tab。行尾星标负责取消收藏，完整路径挂在
 * `title` 上便于窄栏下查看；点击行会驱动内容面板加载，并让文件夹树自动展开到该目录。
 */
export function CoFavoriteFolders() {
  const favoriteFolders = useFileSourceStore((state) => state.favoriteFolders);
  const folderPath = useFileSourceStore((state) => state.folderPath);
  const openFolder = useFileSourceStore((state) => state.openFolder);
  const toggleFavoriteFolder = useFileSourceStore((state) => state.toggleFavoriteFolder);

  if (favoriteFolders.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <Star className="size-7 text-muted-foreground" />
        <div>
          <p className="text-xs text-muted-foreground/90">还没有收藏的文件夹</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            在「文件夹」里把鼠标移到目录行上，点击浮现的星标即可收藏
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1.5">
        {favoriteFolders.map((path) => {
          const isActive = folderPath === path;

          return (
            <div
              key={path}
              className={cn(
                'group flex h-7 items-center gap-1 pr-1.5 text-xs transition-colors',
                isActive ? 'bg-primary/12 text-primary' : 'text-foreground/90 hover:bg-muted/60',
              )}
            >
              <button
                type="button"
                title={path}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => {
                  openFolder(path);
                }}
              >
                <Folder
                  className={cn(
                    'size-3.5 shrink-0',
                    isActive ? 'text-primary/80' : 'text-muted-foreground',
                  )}
                />
                <span className="truncate">{baseName(path)}</span>
              </button>
              <button
                type="button"
                aria-label="取消收藏该文件夹"
                title="取消收藏"
                className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => {
                  toggleFavoriteFolder(path);
                }}
              >
                <Star className="size-3 fill-current text-amber-500" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
