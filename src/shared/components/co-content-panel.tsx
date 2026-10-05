import { FolderOpen, Images, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pathExists, platform, toNativeFileUrl } from '@/platform';
import type { FolderImageFile } from '@/platform/contracts';
import { useElementSize } from '@/shared/hooks/use-element-size';
import { usePhotoImportByPath } from '@/shared/hooks/use-photo-import-by-path';
import { usePhotos } from '@/shared/hooks/use-photos';
import {
  collectAvailability,
  type FilterCriteria,
  hasCriteria,
  matchesFilter,
  resolveCriteria,
} from '@/shared/lib/image-filter';
import { cn } from '@/shared/lib/utils';
import { useFileSourceStore } from '@/shared/store/use-file-source-store';
import { useFilterStore } from '@/shared/store/use-filter-store';
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

/**
 * 内容边栏（文件夹直览，全局文件来源）：枚举当前文件夹的图片，按需生成缩略图，
 * 点击加入全局素材会话并设为当前图片，拖拽可送入拼图画布槽位；「移除」仅列表内隐藏。
 *
 * 条目数据来自 `useFileSourceStore`（与筛选器共用一份，枚举只发生一次），
 * 展示集合在移除隐藏与筛选条件（星级 / 标签 / 文件类型）之上过滤。
 *
 * 本栏是停靠布局里的「内容」面板：标题由 tab 条承担，顶部只在导入时显示进度条，
 * 文件夹名 · 图片数的信息行放在面板最下方；目录切换只走文件夹树，不设刷新 / 打开文件夹入口。
 */
export function CoContentPanel() {
  const folderPath = useFileSourceStore((state) => state.folderPath);
  const removedPaths = useFileSourceStore((state) => state.removedPaths);
  const hideEntry = useFileSourceStore((state) => state.hideEntry);
  const entries = useFileSourceStore((state) => state.entries);
  const status = useFileSourceStore((state) => state.entriesStatus);
  const ratings = useFilterStore((state) => state.ratings);
  const labels = useFilterStore((state) => state.labels);
  const types = useFilterStore((state) => state.types);
  const ratios = useFilterStore((state) => state.ratios);
  const tags = useFilterStore((state) => state.tags);
  const tagsStatus = useFilterStore((state) => state.tagsStatus);
  const tagsFolder = useFilterStore((state) => state.tagsFolder);
  const { selectByPath } = usePhotoImportByPath();
  const { currentPhoto: sessionPhoto, importState } = usePhotos();

  const importProgress =
    importState.total > 0 ? Math.min((importState.current / importState.total) * 100, 100) : 0;

  const [thumbs, setThumbs] = useState<Map<string, string>>(() => new Map());
  const [cacheDir, setCacheDir] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const containerSize = useElementSize(containerRef);
  const pendingThumbRef = useRef(new Set<string>());
  // 代际号：切换文件夹后让仍在轮询旧缩略图的异步任务作废
  const generationRef = useRef(0);

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
      .catch((error) => console.warn('[file-source] 读取缓存目录失败:', error));
    return () => {
      cancelled = true;
    };
  }, []);

  // 换文件夹即换一批条目：作废旧缩略图轮询、清空缩略图并回到列表顶部
  // biome-ignore lint/correctness/useExhaustiveDependencies: folderPath 只作为「目录已切换」的触发信号，效果体内无需引用
  useEffect(() => {
    generationRef.current += 1;
    pendingThumbRef.current.clear();
    setThumbs(new Map());
    setScrollTop(0);
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [folderPath]);

  const removedSet = useMemo(() => new Set(removedPaths), [removedPaths]);
  const criteria: FilterCriteria = useMemo(
    () => ({ ratings, labels, types, ratios }),
    [labels, ratings, ratios, types],
  );
  const availability = useMemo(() => collectAvailability(entries), [entries]);
  const tagsReady = tagsStatus === 'ready' && tagsFolder === folderPath;
  // 空态文案分流：有筛选条件时提示筛选器，否则是被「移除」隐藏
  const hasFilterCriteria = hasCriteria(criteria);
  const visibleEntries = useMemo(() => {
    const resolved = resolveCriteria(criteria, availability, tagsReady);
    return entries.filter(
      (entry) => !removedSet.has(entry.path) && matchesFilter(entry, resolved, tags),
    );
  }, [availability, criteria, entries, removedSet, tags, tagsReady]);

  /**
   * 行布局只跟随容器宽度：占位一律正方形，横竖照片的显示面积相当，
   * 行高 = 方格边长 + 信息行 + 列间距，对所有行一致；虚拟滚动按行号直接换算。
   */
  const cellWidth =
    containerSize.width > 0 ? (containerSize.width - GRID_GAP) / 2 : FALLBACK_CELL_WIDTH;
  const rowHeight = cellWidth + INFO_HEIGHT + GRID_GAP;
  const rowCount = Math.ceil(visibleEntries.length / 2);
  const totalHeight = rowCount * rowHeight;
  const visibleHeight = containerSize.height || 600;
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 1);
  const endRow = Math.min(rowCount, Math.floor((scrollTop + visibleHeight) / rowHeight) + 2);
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
        console.warn('[file-source] 生成直览缩略图失败:', path, error);
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
              // 占位正方形：照片完整显示、留白不裁切，横竖图显示面积相当
              'relative aspect-square overflow-hidden rounded-sm border bg-muted/40 transition-colors',
              isSelected
                ? 'border-primary ring-1 ring-primary/40'
                : 'border-border/70 group-hover:border-primary/40',
            )}
          >
            {thumbUrl ? (
              <img
                src={thumbUrl}
                alt={entry.name}
                className="h-full w-full object-contain"
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
              可能已被移动或删除，请在文件夹栏重新选择。
            </p>
          </div>
        </div>
      );
    }

    if (visibleEntries.length === 0 && status === 'ready') {
      if (entries.length > 0) {
        // 条目存在但全被「移除隐藏」或筛选条件排除：提示去向，不误报文件夹为空
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <Images className="size-7 text-muted-foreground" />
            <div>
              <p className="text-xs font-medium text-foreground">没有匹配的图片</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {hasFilterCriteria
                  ? '当前筛选条件下没有结果，可在筛选器面板调整或清除。'
                  : '图片已被移除（仅隐藏，不删除文件），可在文件夹栏切换目录恢复。'}
              </p>
            </div>
          </div>
        );
      }
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
          <p className="text-xs font-medium text-foreground">选择一个文件夹</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            在左侧文件夹栏展开一个目录，点击图片加入素材，
            <br />
            拼图页里可直接拖入画布；使用时才会复制到缓存，原文件保持不动。
          </p>
        </div>
      </div>
    );
  };

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col bg-card">
        {importState.active ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/80 px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
              <p className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                导入 {importState.current} / {importState.total}
                {importState.currentName ? ` · ${importState.currentName}` : ''}
              </p>
              <div className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-border/60">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                  style={{ width: `${importProgress}%` }}
                />
              </div>
            </div>
          </div>
        ) : null}

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
                    top: startRow * rowHeight,
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

        {/* 信息行放在面板最下方：文件夹名 · 图片数（筛选 / 隐藏生效时为命中数 / 总数） */}
        {folderPath ? (
          <div className="flex shrink-0 items-center border-t border-border/80 px-3 py-2">
            <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {baseName(folderPath)} ·{' '}
              {visibleEntries.length === entries.length
                ? `${entries.length} 张图片`
                : `${visibleEntries.length} / ${entries.length} 张图片`}
            </p>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
