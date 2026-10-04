import { FolderOpen, Images, Loader2, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCollagePhotoImport } from '@/features/collage/hooks/use-collage-photo-import';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import { openDirectoryDialog, pathExists, platform, toNativeFileUrl } from '@/platform';
import type { FolderImageFile } from '@/platform/contracts';
import { useElementSize } from '@/shared/hooks/use-element-size';
import { usePhotos } from '@/shared/hooks/use-photos';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/shared/ui/tooltip';

/** 网格列间距（对应 `gap-2`）。容器 `px-2` 的内边距不计入 contentRect，无需参与计算。 */
const GRID_GAP = 8;
/** 信息行高度：`pt-1`(4) + 文本行高 `leading-4`(16)，与单元格类名保持一致。 */
const INFO_HEIGHT = 20;
/** 尚未测量到容器宽度时的兜底单元格宽（接近默认栏宽下的实际值）。 */
const FALLBACK_CELL_WIDTH = 108;

function pathSeparator(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

function baseName(path: string): string {
  const separator = pathSeparator(path);
  return path.slice(path.lastIndexOf(separator) + 1) || path;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** 缩略图块的 CSS `aspect-ratio`（原图宽高比）；尺寸未知时按 1:1 兜底。 */
function thumbRatio(entry: FolderImageFile): string {
  return entry.width > 0 && entry.height > 0 ? `${entry.width} / ${entry.height}` : '1 / 1';
}

/** 单元格高度 = 按原图比例的缩略图块（宽/比例） + 信息行。 */
function cellHeightOf(entry: FolderImageFile | undefined, cellWidth: number): number {
  if (!entry) {
    return 0;
  }
  const ratio = entry.width > 0 && entry.height > 0 ? entry.width / entry.height : 1;
  return cellWidth / ratio + INFO_HEIGHT;
}

/** 行偏移前缀和中最后一个 `offset <= y` 的行号。 */
function findRowAt(offsets: number[], y: number): number {
  let low = 0;
  let high = offsets.length - 1;
  let result = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= y) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

/** 第一个 `offset > y` 的行号（上界，用作开区间 end）。 */
function findRowAfter(offsets: number[], y: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= y) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

type BrowseStatus = 'idle' | 'checking' | 'ready' | 'invalid';

/**
 * 图片预览栏（文件夹直览）：枚举当前文件夹的图片，按需生成缩略图，
 * 点击加入会话并设为当前图片，拖拽送入画布槽位；「移除」仅会话内隐藏。
 */
export function CollageBrowsePanel() {
  const folderPath = useCollageStore((state) => state.folderPath);
  const removedPaths = useCollageStore((state) => state.removedPaths);
  const openFolder = useCollageStore((state) => state.openFolder);
  const hideEntry = useCollageStore((state) => state.hideEntry);
  const { selectByPath } = useCollagePhotoImport();
  const { currentPhoto: sessionPhoto } = usePhotos();

  const [status, setStatus] = useState<BrowseStatus>('idle');
  const [entries, setEntries] = useState<FolderImageFile[]>([]);
  const [thumbs, setThumbs] = useState<Map<string, string>>(() => new Map());
  const [cacheDir, setCacheDir] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const containerSize = useElementSize(containerRef);
  const pendingThumbRef = useRef(new Set<string>());
  // 代际号：切换文件夹 / 刷新后让仍在轮询旧缩略图的异步任务作废
  const generationRef = useRef(0);
  // 枚举请求序号：快速切换文件夹时丢弃过期响应
  const requestRef = useRef(0);

  // 缓存目录只需读一次，供缩略图命令使用
  useEffect(() => {
    let cancelled = false;
    platform.storage
      .getConfig()
      .then((config) => {
        if (!cancelled) {
          setCacheDir(config.cache.directory);
        }
      })
      .catch((error) => console.warn('[collage] 读取缓存目录失败:', error));
    return () => {
      cancelled = true;
    };
  }, []);

  /** 枚举当前文件夹：只读路径，不复制原文件。手动刷新复用同一入口。 */
  const loadFolder = useCallback(async () => {
    if (!folderPath) {
      setStatus('idle');
      setEntries([]);
      return;
    }

    requestRef.current += 1;
    const request = requestRef.current;
    setStatus('checking');
    try {
      const exists = await pathExists(folderPath);
      if (request !== requestRef.current) {
        return;
      }
      if (!exists) {
        // 路径失效：不伪造目录内容，交给空态提示重新选择
        setStatus('invalid');
        setEntries([]);
        return;
      }

      const images = await platform.files.listFolderImages(folderPath);
      if (request !== requestRef.current) {
        return;
      }

      generationRef.current += 1;
      setThumbs(new Map());
      setEntries(images);
      setScrollTop(0);
      if (containerRef.current) {
        containerRef.current.scrollTop = 0;
      }
      setStatus('ready');
    } catch (error) {
      console.warn('[collage] 枚举文件夹失败:', folderPath, error);
      if (request === requestRef.current) {
        setStatus('invalid');
      }
    }
  }, [folderPath]);

  useEffect(() => {
    void loadFolder();
  }, [loadFolder]);

  const removedSet = useMemo(() => new Set(removedPaths), [removedPaths]);
  const visibleEntries = useMemo(
    () => entries.filter((entry) => !removedSet.has(entry.path)),
    [entries, removedSet],
  );

  /**
   * 行布局跟随容器宽度与每张图的原始宽高动态计算：
   * 缩略图块按原图比例定高（原图比例如实呈现、不裁切），行高取该行两个单元格的
   * 较大者 + 列间距；虚拟滚动按行偏移前缀和定位。
   */
  const rowLayout = useMemo(() => {
    const cellWidth =
      containerSize.width > 0 ? (containerSize.width - GRID_GAP) / 2 : FALLBACK_CELL_WIDTH;
    const rowCount = Math.ceil(visibleEntries.length / 2);
    const offsets = new Array<number>(rowCount);
    let cursor = 0;
    for (let row = 0; row < rowCount; row += 1) {
      offsets[row] = cursor;
      cursor +=
        Math.max(
          cellHeightOf(visibleEntries[row * 2], cellWidth),
          cellHeightOf(visibleEntries[row * 2 + 1], cellWidth),
        ) + GRID_GAP;
    }
    return { offsets, totalHeight: cursor };
  }, [containerSize.width, visibleEntries]);

  const { offsets: rowOffsets, totalHeight } = rowLayout;
  const startRow = Math.max(0, rowOffsets.length > 0 ? findRowAt(rowOffsets, scrollTop) - 1 : 0);
  const visibleHeight = containerSize.height || 600;
  const endRow =
    rowOffsets.length > 0
      ? Math.min(rowOffsets.length, findRowAfter(rowOffsets, scrollTop + visibleHeight) + 1)
      : 0;
  const startIndex = startRow * 2;
  const endIndex = Math.min(visibleEntries.length, endRow * 2);
  const slice = visibleEntries.slice(startIndex, endIndex);

  /** 确保条目缩略图存在并拿到 URL：不存在时排队后台生成，轮询等待 worker 完成。 */
  const ensureThumb = useCallback(
    async (path: string, generation: number) => {
      if (!cacheDir || pendingThumbRef.current.has(path)) {
        return;
      }
      pendingThumbRef.current.add(path);
      try {
        const meta = await platform.files.ensureBrowseThumbnail(path, cacheDir);
        if (generation !== generationRef.current) {
          return;
        }
        if (meta.thumbnail_ready) {
          setThumbs((prev) => new Map(prev).set(path, toNativeFileUrl(meta.thumbnail_path)));
          return;
        }

        // 后台 worker 生成中：轮询等待，最多约 12 秒
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await sleep(300);
          if (generation !== generationRef.current) {
            return;
          }
          if (await pathExists(meta.thumbnail_path)) {
            setThumbs((prev) => new Map(prev).set(path, toNativeFileUrl(meta.thumbnail_path)));
            return;
          }
        }
      } catch (error) {
        console.warn('[collage] 生成直览缩略图失败:', path, error);
      } finally {
        pendingThumbRef.current.delete(path);
      }
    },
    [cacheDir],
  );

  // 只为「进入视口且尚无缩略图」的条目触发生成
  const pendingVisible = useMemo(
    () => slice.map((entry) => entry.path).filter((path) => !thumbs.has(path)),
    [slice, thumbs],
  );

  useEffect(() => {
    const generation = generationRef.current;
    for (const path of pendingVisible) {
      void ensureThumb(path, generation);
    }
  }, [ensureThumb, pendingVisible]);

  const handleOpenFolder = useCallback(async () => {
    const selected = await openDirectoryDialog();
    if (!selected || Array.isArray(selected)) {
      return;
    }
    openFolder(selected);
  }, [openFolder]);

  const selectedId = sessionPhoto?.id ?? null;

  const renderEntry = (entry: FolderImageFile) => {
    const thumbUrl = thumbs.get(entry.path) ?? null;
    const isSelected = selectedId === entry.path;

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: 整张卡片是拖拽源；点击由内层 button 承担
      <div
        key={entry.path}
        draggable
        onDragStart={(event) => {
          // 画布槽位的 onDrop 按这两个类型读取；不 setData 拖拽就永远是空操作
          event.dataTransfer.setData('text/copicseal-photo-id', entry.path);
          event.dataTransfer.setData('text/plain', entry.path);
          event.dataTransfer.effectAllowed = 'copy';
        }}
        className="group relative"
      >
        <button
          type="button"
          onClick={() => void selectByPath(entry.path)}
          className="block w-full text-left"
        >
          <div
            className={cn(
              // 高度由原始宽高推导（aspect-ratio）：原图比例如实呈现，不裁切
              'relative overflow-hidden rounded-sm border bg-muted/40 transition-colors',
              isSelected
                ? 'border-primary ring-1 ring-primary/40'
                : 'border-border/70 group-hover:border-primary/40',
            )}
            style={{ aspectRatio: thumbRatio(entry) }}
          >
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt={entry.name}
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span className="line-clamp-2 text-center text-[10px] leading-tight">
                  {entry.name}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-baseline gap-1.5 px-0.5 pt-1 leading-4">
            <span className="min-w-0 truncate text-[10px] text-foreground/90">{entry.name}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {formatSize(entry.size)}
            </span>
          </div>
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="从列表移除"
              className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/75"
              onClick={() => hideEntry(entry.path)}
            >
              <X className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">仅从当前列表隐藏，不删除本地文件</TooltipContent>
        </Tooltip>
      </div>
    );
  };

  const renderEmpty = () => {
    if (status === 'checking') {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <p className="text-xs">正在读取文件夹…</p>
        </div>
      );
    }

    if (status === 'invalid') {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
          <Images className="size-7 text-muted-foreground" />
          <div>
            <p className="text-xs font-medium text-foreground">文件夹不存在或无法访问</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              可能已被移动或删除，请重新选择文件夹。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void handleOpenFolder()}>
            <FolderOpen data-icon="inline-start" />
            打开文件夹
          </Button>
        </div>
      );
    }

    if (visibleEntries.length === 0 && status === 'ready') {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
          <Images className="size-7 text-muted-foreground" />
          <div>
            <p className="text-xs font-medium text-foreground">文件夹里没有图片</p>
            <p className="mt-1 text-[11px] text-muted-foreground">支持 JPG / PNG / HEIC / WEBP</p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <FolderOpen className="size-7 text-primary" />
        <div>
          <p className="text-xs font-medium text-foreground">打开一个文件夹</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            直接浏览文件夹里的图片，拖入画布即可拼图。
            <br />
            使用时才会复制到缓存，原文件保持不动。
          </p>
        </div>
        <Button size="sm" onClick={() => void handleOpenFolder()}>
          <FolderOpen data-icon="inline-start" />
          打开文件夹
        </Button>
      </div>
    );
  };

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col bg-card">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/80 px-3 py-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xs font-semibold">
              {folderPath ? baseName(folderPath) : '图片'}
            </h2>
            {folderPath ? (
              <p className="truncate text-[10px] text-muted-foreground">
                {visibleEntries.length} 张图片
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="刷新目录"
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            disabled={!folderPath || status === 'checking'}
            onClick={() => void loadFolder()}
          >
            <RefreshCw className={cn('size-3.5', status === 'checking' && 'animate-spin')} />
          </button>
          <button
            type="button"
            aria-label="打开文件夹"
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => void handleOpenFolder()}
          >
            <FolderOpen className="size-3.5" />
          </button>
        </div>

        {status === 'idle' || status === 'invalid' ? (
          <div className="min-h-0 flex-1">{renderEmpty()}</div>
        ) : (
          <div
            ref={containerRef}
            className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            {slice.length === 0 ? (
              visibleEntries.length > 0 ? (
                // 滚动位置越界（条目被移除后浏览器尚未夹紧 scrollTop）：只留占位，不显示空态
                <div style={{ height: totalHeight }} />
              ) : (
                <div className="h-full">{renderEmpty()}</div>
              )
            ) : (
              <div style={{ height: totalHeight, position: 'relative' }}>
                <div
                  className="grid grid-cols-2 gap-2"
                  style={{
                    position: 'absolute',
                    top: rowOffsets[startRow] ?? 0,
                    left: 0,
                    right: 0,
                  }}
                >
                  {slice.map(renderEntry)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
