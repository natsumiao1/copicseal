import { Check, Eraser, Fingerprint, FolderOpen, Images, Loader2, Trash2, X } from 'lucide-react';
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { pathExists, platform, toNativeFileUrl } from '@/platform';
import type { FolderImageFile } from '@/platform/contracts';
import { useElementSize } from '@/shared/hooks/use-element-size';
import { invalidatePhotoExif } from '@/shared/hooks/use-photo-exif';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/shared/ui/context-menu';
import { Switch } from '@/shared/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/shared/ui/tooltip';

/** 能做段 / 块级去元数据的容器；HEIC 需解析 BMFF box，暂不支持（菜单项给出提示） */
const STRIPPABLE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

function isStrippable(name: string): boolean {
  const lower = name.toLowerCase();
  return STRIPPABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

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
  const { currentPhoto: sessionPhoto, importState, photos } = usePhotos();

  const importProgress =
    importState.total > 0 ? Math.min((importState.current / importState.total) * 100, 100) : 0;

  const [thumbs, setThumbs] = useState<Map<string, string>>(() => new Map());
  const [cacheDir, setCacheDir] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  /**
   * 多选集合（按路径）：与「当前图片」是两套状态——当前图片随点击流转并联动画布，
   * 选择集合只服务于右键批量操作。空数组表示没有多选。
   */
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  /** 范围选择的锚点（上一次点选的路径），目录切换时复位 */
  const selectionAnchorRef = useRef<string | null>(null);
  /** 右键菜单打开与否：Esc 清除选择时先关菜单，避免「关菜单」顺带清掉选择 */
  const menuOpenRef = useRef(false);
  /** 右键「删除」的待确认目标（选中集合）；null 表示确认弹窗关闭 */
  const [deleteTargets, setDeleteTargets] = useState<FolderImageFile[] | null>(null);
  /** 右键「去除 EXIF 信息」的待确认目标（选中集合，已过滤掉不支持的格式）；null 表示关闭 */
  const [stripTargets, setStripTargets] = useState<FolderImageFile[] | null>(null);
  /** 确认弹窗里的「同时清除内嵌 XMP」开关；每次打开复位为关 */
  const [stripRemoveXmp, setStripRemoveXmp] = useState(false);
  /** 批量任务进行中：禁用菜单项，避免并发写盘 */
  const [batchBusy, setBatchBusy] = useState(false);

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

  // 换文件夹即换一批条目：作废旧缩略图轮询、清空缩略图与多选并回到列表顶部
  // biome-ignore lint/correctness/useExhaustiveDependencies: folderPath 只作为「目录已切换」的触发信号，效果体内无需引用
  useEffect(() => {
    generationRef.current += 1;
    pendingThumbRef.current.clear();
    setThumbs(new Map());
    setSelectedPaths([]);
    selectionAnchorRef.current = null;
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

  // 展示集合变化（移除隐藏 / 筛选 / 换目录）后剔除失效的选中路径：选择只作用于看得见的条目
  useEffect(() => {
    setSelectedPaths((prev) => {
      if (prev.length === 0) {
        return prev;
      }
      const visible = new Set(visibleEntries.map((entry) => entry.path));
      const next = prev.filter((path) => visible.has(path));
      return next.length === prev.length ? prev : next;
    });
  }, [visibleEntries]);

  // Esc 清除多选：确认弹窗或右键菜单开着时不动（那次 Esc 归它们）
  useEffect(() => {
    if (selectedPaths.length === 0) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        deleteTargets !== null ||
        stripTargets !== null ||
        menuOpenRef.current
      ) {
        return;
      }
      setSelectedPaths([]);
      selectionAnchorRef.current = null;
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteTargets, selectedPaths.length, stripTargets]);

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

  /**
   * 逐张执行的批量任务：单张与多张共用一个入口，菜单不用分支。
   *
   * 进度用同一条 toast 原地更新（sonner 的 `id` 复用），批量结束给成功 / 失败汇总；
   * 单张仍走「一条成功提示」的旧反馈。串行而不是并发：写盘任务并发只会互相抢 IO，
   * 还会让进度失真；单张失败计入失败数后继续跑下一张，与导出「跳过该张」的语义一致。
   *
   * worker 返回「单张成功时的提示文案」，批量场景忽略（由汇总承担反馈）。
   */
  const runBatch = useCallback(
    async (
      label: string,
      targets: FolderImageFile[],
      worker: (target: FolderImageFile) => Promise<string | undefined>,
    ) => {
      if (targets.length === 0) {
        return;
      }
      setBatchBusy(true);
      try {
        if (targets.length === 1) {
          try {
            const message = await worker(targets[0]);
            if (message) {
              toast.success(message);
            }
          } catch (error) {
            console.warn(`[file-source] ${label}失败:`, targets[0].name, error);
            toast.error(`${label}失败：${targets[0].name}`, { description: String(error) });
          }
          return;
        }

        const toastId = 'file-source-batch';
        let failed = 0;
        let lastError: unknown = null;
        toast.loading(`${label} 0 / ${targets.length}`, {
          id: toastId,
          description: targets[0].name,
        });
        for (const [index, target] of targets.entries()) {
          try {
            await worker(target);
          } catch (error) {
            failed += 1;
            lastError = error;
            console.warn(`[file-source] ${label}失败:`, target.name, error);
          }
          toast.loading(`${label} ${index + 1} / ${targets.length}`, {
            id: toastId,
            description: target.name,
          });
        }
        if (failed === 0) {
          toast.success(`${label}完成：${targets.length} 张`, { id: toastId });
        } else {
          toast.warning(`${label}部分失败：${targets.length - failed} 成功、${failed} 失败`, {
            id: toastId,
            description: String(lastError ?? ''),
          });
        }
      } finally {
        setBatchBusy(false);
      }
    },
    [],
  );

  /**
   * 移入回收站（单张或多张），成功后从列表隐藏。
   *
   * 已入会话的素材渲染用的是缓存副本，原文件被移走不影响预览与导出，因此不动会话；
   * 失败只计入汇总，条目继续留在列表里。
   */
  const trashTargets = useCallback(
    async (targets: FolderImageFile[]) => {
      await runBatch('移入回收站', targets, async (target) => {
        await platform.files.moveToTrash(target.path);
        hideEntry(target.path);
        return `已移到回收站：${target.name}`;
      });
    },
    [hideEntry, runBatch],
  );

  /**
   * 清空缩略图缓存（派生数据，单张或多张）：状态里同步移除，视口再次滚到时重新生成。
   *
   * 导入副本与预览副本是素材会话在用的独立缓存，不在这里动（设置页的缓存清理管它们）。
   */
  const clearThumbCache = useCallback(
    async (targets: FolderImageFile[]) => {
      if (!cacheDir) {
        return;
      }
      await runBatch('清空缓存', targets, async (target) => {
        const removed = await platform.files.clearBrowseThumbnail(target.path, cacheDir);
        setThumbs((prev) => {
          const next = new Map(prev);
          next.delete(target.path);
          return next;
        });
        return removed
          ? `已清空缩略图缓存：${target.name}`
          : `没有可清的缩略图缓存：${target.name}`;
      });
    },
    [cacheDir, runBatch],
  );

  const selectedId = sessionPhoto?.id ?? null;
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  /** 选中条目的实体列表（按目录顺序）：只在选择变化时过滤一次，避免每个格子各自扫全量条目 */
  const selectedEntries = useMemo(
    () => entries.filter((item) => selectedSet.has(item.path)),
    [entries, selectedSet],
  );
  /** 选中集合里支持去除 EXIF 的子集路径：菜单的「暂不支持 / 跳过 N 张」按它计数 */
  const strippableSelected = useMemo(
    () =>
      new Set(selectedEntries.filter((item) => isStrippable(item.name)).map((item) => item.path)),
    [selectedEntries],
  );

  /**
   * 确认后原地改写文件：先处理原图，再处理已入会话的缓存副本。
   *
   * 缓存副本才是素材会话与导出实际读的文件（`originalPath` 指向原图）：只改原图的
   * 话，导出勾了「包含原始元数据」仍会把 EXIF 带出去，EXIF 卡片也停在旧值。副本改完
   * 逐个作废 EXIF 缓存，卡片与水印模板立即按新文件重读。
   */
  const stripExifTargets = useCallback(
    async (targets: FolderImageFile[], removeXmp: boolean) => {
      await runBatch('去除 EXIF', targets, async (target) => {
        const changed = await platform.files.stripImageExif(target.path, removeXmp);

        let copyChanged = false;
        for (const photo of photos) {
          // 会话副本与原图是同一个文件时，上面那步已经改过，只需作废缓存
          if (photo.path === target.path) {
            invalidatePhotoExif(photo.id);
            continue;
          }
          if (photo.originalPath !== target.path) {
            continue;
          }
          copyChanged = (await platform.files.stripImageExif(photo.path, removeXmp)) || copyChanged;
          invalidatePhotoExif(photo.id);
        }

        if (!changed && !copyChanged) {
          return `未发现可去除的元数据：${target.name}`;
        }
        return `已去除 EXIF 信息：${target.name}`;
      });

      // XMP 的计数来自标签数据：整批结束后统一强制重读一次，筛选器数量即时刷新
      if (removeXmp && folderPath && entries.length > 0) {
        await useFilterStore.getState().loadTags(
          entries.map((entry) => entry.path),
          folderPath,
          { force: true },
        );
      }
    },
    [entries, folderPath, photos, runBatch],
  );

  /**
   * 单元格点击：按修饰键分流。
   *
   * 普通点击沿用原语义（加入素材会话并设为当前图片），同时把选择集合收缩为这一张；
   * Cmd / Ctrl 逐张增减、Shift 按列表顺序取范围，这两种只动选择集合、不切换当前图片
   * （与文件管理器一致：多选是为批量操作服务的，不接管「看哪张」）。
   */
  const handleEntryClick = (entry: FolderImageFile, event: MouseEvent<HTMLButtonElement>) => {
    const anchor = selectionAnchorRef.current;

    if (event.shiftKey && anchor) {
      const paths = visibleEntries.map((item) => item.path);
      const from = paths.indexOf(anchor);
      const to = paths.indexOf(entry.path);
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelectedPaths(paths.slice(start, end + 1));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      selectionAnchorRef.current = entry.path;
      setSelectedPaths((prev) =>
        prev.includes(entry.path)
          ? prev.filter((path) => path !== entry.path)
          : [...prev, entry.path],
      );
      return;
    }

    // 无修饰键（含没有锚点的 Shift 点击）：选择收缩为这一张；只有普通点击才切当前图片
    selectionAnchorRef.current = entry.path;
    setSelectedPaths([entry.path]);
    if (!event.shiftKey) {
      void selectByPath(entry.path);
    }
  };

  /** 右键目标 = 当前选中集合；右键未选中的条目时集合已先收缩为该条目（见触发器的 onContextMenu）。 */
  const resolveTargets = (entry: FolderImageFile): FolderImageFile[] => {
    return selectedSet.has(entry.path) ? selectedEntries : [entry];
  };

  /** 右键目标里支持去除 EXIF 的子集：不支持的格式不进弹窗，菜单上先提示跳过张数 */
  const resolveStrippableTargets = (entry: FolderImageFile): FolderImageFile[] => {
    return resolveTargets(entry).filter((target) => isStrippable(target.name));
  };

  const renderEntry = (entry: FolderImageFile) => {
    const thumbUrl = thumbs.get(entry.path) ?? null;
    // 「当前图片」的高亮环与「多选」的对勾是两套状态，可以同时成立
    const isCurrent = selectedId === entry.path;
    const isSelected = selectedSet.has(entry.path);
    // 渲染期只算张数、不取实体（选择集可能很大，每个格子都过滤全量就是 O(格子 × 条目)）；
    // 实体在菜单点击时经 resolveTargets / resolveStrippableTargets 取一次即可
    const targetCount = isSelected ? selectedEntries.length : 1;
    const singleStrippable = isStrippable(entry.name) ? 1 : 0;
    const strippableCount = isSelected ? strippableSelected.size : singleStrippable;
    const skippedCount = targetCount - strippableCount;

    return (
      <ContextMenu
        key={entry.path}
        onOpenChange={(open) => {
          menuOpenRef.current = open;
        }}
      >
        <ContextMenuTrigger asChild>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: 整张卡片是拖拽源；点击由内层 button 承担 */}
          <div
            draggable
            onDragStart={(event) => {
              // 画布槽位的 onDrop 按这两个类型读取；不 setData 拖拽就永远是空操作
              event.dataTransfer.setData('text/copicseal-photo-id', entry.path);
              event.dataTransfer.setData('text/plain', entry.path);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onContextMenu={() => {
              // 右键落在未选中的条目上：菜单改作用于这一张（文件管理器惯例）
              if (!selectedSet.has(entry.path)) {
                selectionAnchorRef.current = entry.path;
                setSelectedPaths([entry.path]);
              }
            }}
            className="group relative"
          >
            <button
              type="button"
              onClick={(event) => handleEntryClick(entry, event)}
              className="block w-full text-left"
            >
              <div
                className={cn(
                  // 占位正方形：照片完整显示、留白不裁切，横竖图显示面积相当
                  'relative aspect-square overflow-hidden rounded-sm border bg-muted/40 transition-colors',
                  isCurrent && 'border-primary ring-1 ring-primary/40',
                  isSelected && 'border-primary bg-primary/10',
                  !isCurrent && !isSelected && 'border-border/70 group-hover:border-primary/40',
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
                {isSelected ? (
                  <span className="absolute left-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                    <Check className="size-2.5" />
                  </span>
                ) : null}
              </div>
              <div className="flex items-baseline gap-1.5 px-0.5 pt-1 leading-4">
                <span className="min-w-0 truncate text-[10px] text-foreground/90">
                  {entry.name}
                </span>
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
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={!cacheDir || batchBusy}
            onSelect={() => void clearThumbCache(resolveTargets(entry))}
          >
            <Eraser />
            清空缓存{targetCount > 1 ? `（${targetCount} 张）` : ''}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={strippableCount === 0 || batchBusy}
            onSelect={() => {
              setStripRemoveXmp(false);
              setStripTargets(resolveStrippableTargets(entry));
            }}
          >
            <Fingerprint />
            去除 EXIF 信息{strippableCount > 1 ? `（${strippableCount} 张）` : ''}
            {strippableCount === 0 ? (
              <span className="ml-auto pl-2 text-[10px] opacity-60">暂不支持</span>
            ) : skippedCount > 0 ? (
              <span className="ml-auto pl-2 text-[10px] opacity-60">{skippedCount} 张暂不支持</span>
            ) : null}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            disabled={batchBusy}
            onSelect={() => setDeleteTargets(resolveTargets(entry))}
          >
            <Trash2 />
            删除{targetCount > 1 ? `（${targetCount} 张）` : ''}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
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

  /** 删除弹窗文案：目标是一张或多张，主语随数量变化，去向说明共用一句 */
  const deleteDescription =
    deleteTargets && deleteTargets.length === 1
      ? `「${deleteTargets[0].name}」将被移到系统回收站，可随时从中恢复。`
      : `选中的 ${deleteTargets?.length ?? 0} 张文件将被移到系统回收站，可随时从中恢复。`;

  /** 去除 EXIF 弹窗文案：主语 + 固定说明（覆盖原文件、方向保留、会话副本一并处理） */
  const stripDescription =
    (stripTargets && stripTargets.length === 1
      ? `「${stripTargets[0].name}」`
      : `选中的 ${stripTargets?.length ?? 0} 张文件`) +
    '的相机型号、拍摄参数与 GPS 位置等 EXIF 信息将从文件中移除，并直接覆盖原文件，不可撤销。' +
    '方向（Orientation）会被保留，图片显示方向不受影响；已加入素材的照片会一并处理其缓存副本。';

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

        {/* 信息行放在面板最下方：文件夹名 · 图片数（筛选 / 隐藏生效时为命中数 / 总数） · 已选数 */}
        {folderPath ? (
          <div className="flex shrink-0 items-center border-t border-border/80 px-3 py-2">
            <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {baseName(folderPath)} ·{' '}
              {visibleEntries.length === entries.length
                ? `${entries.length} 张图片`
                : `${visibleEntries.length} / ${entries.length} 张图片`}
              {selectedPaths.length > 0 ? ` · 已选 ${selectedPaths.length} 张` : ''}
            </p>
          </div>
        ) : null}
      </div>

      {/* 删除确认：右键菜单点了「删除」才打开；Action 点击后弹窗自行关闭 */}
      <AlertDialog
        open={deleteTargets !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTargets(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移到回收站？</AlertDialogTitle>
            <AlertDialogDescription>{deleteDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTargets) {
                  void trashTargets(deleteTargets);
                }
              }}
            >
              移到回收站
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/*
        去除 EXIF 确认：右键菜单点了「去除 EXIF 信息」才打开（目标是选中集合里
        支持的格式）。原文件被直接覆盖且不可撤销，因此先给出去向、方向保留与副本
        处理的说明，XMP 作为可选项放行。
      */}
      <AlertDialog
        open={stripTargets !== null}
        onOpenChange={(open) => {
          if (!open) {
            setStripTargets(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>去除 EXIF 信息？</AlertDialogTitle>
            <AlertDialogDescription>{stripDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">同时清除内嵌 XMP 信息</div>
              <div className="text-[10px] text-muted-foreground">
                星级与颜色标签将丢失；同名 .xmp sidecar 文件不受影响
              </div>
            </div>
            <Switch
              checked={stripRemoveXmp}
              onCheckedChange={setStripRemoveXmp}
              aria-label="同时清除内嵌 XMP 信息"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (stripTargets) {
                  void stripExifTargets(stripTargets, stripRemoveXmp);
                }
              }}
            >
              覆盖原文件
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
