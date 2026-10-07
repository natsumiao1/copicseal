import { ImagePlus, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  adaptivePhotoFitLimits,
  clampAdaptivePhotoFit,
  computeAdaptiveGeometry,
  DEFAULT_ADAPTIVE_FIT,
  FALLBACK_PHOTO_RATIO,
  getAdaptiveRootRatio,
  isAdaptiveEdgeFlush,
  photoRatio,
} from '@/features/collage/adaptive';
import { getAspectRatioValue } from '@/features/collage/lib';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import type { AdaptiveInsertDirection, AdaptivePhotoFit } from '@/features/collage/types';
import { usePhotoImportByPath } from '@/shared/hooks/use-photo-import-by-path';
import { usePhotos } from '@/shared/hooks/use-photos';
import { cn } from '@/shared/lib/utils';
import type { ImportedPhoto } from '@/shared/types/photo';

/** 落点判定结果：四边插入方位，或中心区替换。 */
type DropZone = AdaptiveInsertDirection | 'replace';

interface AdaptiveDropTarget {
  /**
   * 目标照片 id；null = 边距外框（照片与画布边距之间的环带）拖放，
   * 此时沿该侧整体插入一整行/一列（根节点分割）。
   */
  photoId: string | null;
  zone: DropZone;
  /** true = 根级插入（只在 photoId 为 null 的外框落点出现），高亮画布内容区该侧的一半 */
  root: boolean;
}

/** 预览各方位即将生成的高亮区域（近似 50/50 分割，实际比例由照片宽高比决定）。 */
const ZONE_OVERLAY: Record<DropZone, React.CSSProperties> = {
  left: { left: 0, top: 0, width: '50%', height: '100%' },
  right: { left: '50%', top: 0, width: '50%', height: '100%' },
  top: { left: 0, top: 0, width: '100%', height: '50%' },
  bottom: { left: 0, top: '50%', width: '100%', height: '50%' },
  replace: { left: 0, top: 0, width: '100%', height: '100%' },
};

/** 套内容框的贴边方位 → Tailwind 类（保持字面量，JIT 才能扫描到） */
const FRAME_JUSTIFY_CLASS = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
} as const;
const FRAME_ALIGN_CLASS = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
} as const;

/** 从拖拽载荷里取照片 id：直览条目（路径）与画布照片两种来源。 */
function readDraggedPhotoId(event: React.DragEvent): string {
  return (
    event.dataTransfer.getData('text/copicseal-photo-id') ||
    event.dataTransfer.getData('text/plain')
  );
}

/**
 * 判定落点方位：贴近某条边（30% 带内）→ 该方位插入；
 * 四边距离都够远（中央区域）→ 替换目标照片。
 */
function computeDropZone(event: React.DragEvent, bounds: DOMRect): DropZone {
  const x = (event.clientX - bounds.left) / Math.max(bounds.width, 1);
  const y = (event.clientY - bounds.top) / Math.max(bounds.height, 1);
  const edges: Array<[DropZone, number]> = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y],
  ];
  const closest = edges.reduce((best, current) => (current[1] < best[1] ? current : best));
  return closest[1] >= 0.3 ? 'replace' : closest[0];
}

/**
 * 边距外框（画布 padding 环带）上的落点方位：取指针最近的画布外沿。
 * 外框是贴边插入的独立拖放区，照片与画布边距之间那圈都算。
 */
function nearestEdgeSide(
  clientX: number,
  clientY: number,
  bounds: DOMRect,
): AdaptiveInsertDirection {
  const edges: Array<[AdaptiveInsertDirection, number]> = [
    ['left', clientX - bounds.left],
    ['right', bounds.right - clientX],
    ['top', clientY - bounds.top],
    ['bottom', bounds.bottom - clientY],
  ];
  return edges.reduce((best, current) => (current[1] < best[1] ? current : best))[0];
}

interface CollageAdaptiveLayoutProps {
  photoById: Map<string, ImportedPhoto>;
  /** 内容区内边距：已按画布比例分配到两条轴（长边 = 滑杆值），保证内容框等比（见 docs/features.md 2.4） */
  contentPadding: string;
  /**
   * 套内容框的贴边方位（画布把手拖拽时由外层传入）：内容贴住画布锚定侧、画面不随拖动重排，
   * 余量（留白）向被拖方向堆积；缺省居中。
   */
  contentAnchor?: { justify: 'start' | 'center' | 'end'; align: 'start' | 'center' | 'end' };
}

/**
 * 自适应布局的画布内容：按树递归计算每张照片的矩形并绝对定位。
 *
 * 格子比例 == 照片自然比例（`object-cover` 因此无变形无裁切）；
 * `gap/2` 内缩形成格间距，画布边距由外层按画布比例分配后传入（内容框恒等比）。
 * 拖放交互：照片上的落点细分或替换这张照片（即使它的边贴合画布外沿，
 * 如上1下1 的下排占满整宽，拖到左侧即劈成上1下2）；
 * 边距外框落点沿最近外沿整体插入一整行/一列；空画布直接落第一张。
 * 分割线把手：每个 split 节点的接缝上可拖调手动比例（双击恢复自动），
 * 手势配合 transient 合并为一步撤销；比例偏离照片后按照片填充方式渲染。
 * 格内取景：单击照片选中（描边高亮），按住拖动平移（钳制在不露缝 / 不出格的可达范围，
 * transient 合并一步撤销），双击照片重置；缩放走属性面板「选中项」。
 */
export function CollageAdaptiveLayout({
  photoById,
  contentPadding,
  contentAnchor,
}: CollageAdaptiveLayoutProps) {
  const frameJustify = FRAME_JUSTIFY_CLASS[contentAnchor?.justify ?? 'center'];
  const frameAlign = FRAME_ALIGN_CLASS[contentAnchor?.align ?? 'center'];
  const tree = useCollageStore((state) => state.present.adaptiveTree);
  const canvas = useCollageStore((state) => state.present.canvas);
  const insertAdaptivePhoto = useCollageStore((state) => state.insertAdaptivePhoto);
  const replaceAdaptivePhoto = useCollageStore((state) => state.replaceAdaptivePhoto);
  const removeAdaptivePhoto = useCollageStore((state) => state.removeAdaptivePhoto);
  const setSplitRatio = useCollageStore((state) => state.setAdaptiveSplitRatio);
  const selectedAdaptivePhotoId = useCollageStore((state) => state.selectedAdaptivePhotoId);
  const selectAdaptivePhoto = useCollageStore((state) => state.selectAdaptivePhoto);
  const setAdaptivePhotoFit = useCollageStore((state) => state.setAdaptivePhotoFit);
  const beginTransient = useCollageStore((state) => state.beginTransient);
  const endTransient = useCollageStore((state) => state.endTransient);
  const { ensureByPath } = usePhotoImportByPath();
  const { photos } = usePhotos();
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const [dropTarget, setDropTarget] = useState<AdaptiveDropTarget | null>(null);
  /** 分割线拖动是否进行中（pointer capture 保证事件回流到发起的把手） */
  const splitDragRef = useRef(false);
  /** 格内取景拖拽的起手势快照（指针捕获在按下时的格子上，坐标按格子比例换算） */
  const panRef = useRef<{
    photoId: string;
    startX: number;
    startY: number;
    cellWidth: number;
    cellHeight: number;
    fit: AdaptivePhotoFit;
  } | null>(null);
  /** 内容区基准框：把手拖动时把指针坐标换算成 0..1 占比 */
  const contentRef = useRef<HTMLDivElement | null>(null);

  const resolveRatio = useCallback(
    (photoId: string) => {
      const photo = photoById.get(photoId);
      return photo ? photoRatio(photo) : FALLBACK_PHOTO_RATIO;
    },
    [photoById],
  );

  const geometry = useMemo(() => computeAdaptiveGeometry(tree, resolveRatio), [resolveRatio, tree]);
  const rects = geometry.leaves;
  const splitRects = geometry.splits;
  /** contain = 完整显示、留白透出画布背景；自动比例下与 cover 渲染一致，拖过分割线后生效 */
  const fillContain = canvas.fillMode === 'contain';
  /** 取景钳制使用的填充模式（收窄为字面量类型） */
  const fillMode: 'cover' | 'contain' = fillContain ? 'contain' : 'cover';
  /** 内容框比例 == 照片树自然比例（跟随内容与套内容两种模式都成立，见 frame memo）：格子像素比例由此折算 */
  const naturalRatio = useMemo(
    () => getAdaptiveRootRatio(tree, resolveRatio),
    [resolveRatio, tree],
  );
  /**
   * 画布套内容：固定比例下把照片树按自然比例 contain 进内容框并居中，
   * 余量透出画布背景（照片零裁切）；跟随内容时自然比例 == 画布比例，整框铺满。
   */
  const frame = useMemo(() => {
    if (canvas.adaptiveFollowContent !== false) {
      return { widthPct: 100, heightPct: 100 };
    }
    const canvasRatio = getAspectRatioValue(canvas);
    const naturalRatio = getAdaptiveRootRatio(tree, resolveRatio);
    // 内容更宽 → 按宽贴合、上下留白；更高 → 按高贴合、左右留白
    return naturalRatio >= canvasRatio
      ? { widthPct: 100, heightPct: (canvasRatio / naturalRatio) * 100 }
      : { widthPct: (naturalRatio / canvasRatio) * 100, heightPct: 100 };
  }, [canvas, resolveRatio, tree]);

  /**
   * 落图：照片不在会话里先懒导入；导入失败（文件已失效）则不入树，
   * 避免留下一个渲染不出图的失效叶子。
   */
  const placePhoto = useCallback(
    (draggedPhotoId: string, targetPhotoId: string | null, zone: DropZone) => {
      const apply = () => {
        if (!photosRef.current.some((photo) => photo.id === draggedPhotoId)) {
          console.warn('[collage] 拖入照片懒导入失败，未放置:', draggedPhotoId);
          return;
        }
        if (!targetPhotoId) {
          // null 目标 = 边距外框/空画布：沿该侧整体插入一整行/一列（空树即第一张）
          insertAdaptivePhoto(null, zone === 'replace' ? 'left' : zone, draggedPhotoId);
          return;
        }
        if (zone === 'replace') {
          replaceAdaptivePhoto(targetPhotoId, draggedPhotoId);
        } else {
          insertAdaptivePhoto(targetPhotoId, zone, draggedPhotoId);
        }
      };

      if (photoById.has(draggedPhotoId)) {
        apply();
        return;
      }
      void ensureByPath(draggedPhotoId).then(apply);
    },
    [ensureByPath, insertAdaptivePhoto, photoById, replaceAdaptivePhoto],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖放容器需要在容器级接收 drag/drop 事件
    <div
      className={cn('absolute inset-0 flex', frameJustify, frameAlign)}
      style={{ padding: contentPadding }}
      onPointerDown={(event) => {
        // 单击边距环带（照片之外的画布空白）取消选中
        if (event.button === 0 && event.target === event.currentTarget) {
          selectAdaptivePhoto(null);
        }
      }}
      onDragOver={(event) => {
        // WKWebView/Safari 要求 dragenter 与 dragover 都被取消才放行 drop
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';

        // 指针在外框（padding 环带）上时 target 就是容器自身：
        // 判定为「贴外沿整体插入」，按最近的画布外沿给出方位。
        if (event.target === event.currentTarget && tree) {
          const side = nearestEdgeSide(
            event.clientX,
            event.clientY,
            event.currentTarget.getBoundingClientRect(),
          );
          setDropTarget((prev) =>
            prev?.photoId === null && prev.zone === side
              ? prev
              : { photoId: null, zone: side, root: true },
          );
          return;
        }
        // 内容区无照片（空画布）时只需放行 drop，不给方位高亮
        setDropTarget((prev) => (prev?.photoId === null ? null : prev));
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setDropTarget((prev) => (prev?.photoId === null ? null : prev));
      }}
      onDrop={(event) => {
        event.preventDefault();
        const draggedPhotoId = readDraggedPhotoId(event);
        if (!draggedPhotoId) {
          return;
        }
        setDropTarget(null);

        // 外框落点：沿最近外沿整体插入一整行/一列
        if (tree && event.target === event.currentTarget) {
          const side = nearestEdgeSide(
            event.clientX,
            event.clientY,
            event.currentTarget.getBoundingClientRect(),
          );
          placePhoto(draggedPhotoId, null, side);
          return;
        }
        // 空画布：作为第一张
        if (!tree) {
          placePhoto(draggedPhotoId, null, 'left');
        }
      }}
    >
      {/* 内容框：跟随内容时铺满；固定比例时按自然比例 contain，
          贴边方位由 contentAnchor 决定（拖把手时贴锚定侧、余量向拖拽方向堆积），缺省居中 */}
      <div
        className="relative"
        style={{
          width: `${frame.widthPct}%`,
          height: `${frame.heightPct}%`,
        }}
      >
        <div ref={contentRef} className="relative h-full w-full">
          {rects.length === 0 ? (
            <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <ImagePlus className="size-8" />
              <span className="text-xs">从左侧拖入照片开始拼图</span>
            </div>
          ) : null}

          {rects.map((rect) => {
            const photo = photoById.get(rect.photoId);
            const photoAspect = photo ? photoRatio(photo) : FALLBACK_PHOTO_RATIO;
            // 格子像素比例：rect 相对内容框（恒等比 == 照片树自然比例），
            // 是取景钳制（cover 不露缝 / contain 不出格）的基准
            const cellAspect = (rect.width / Math.max(rect.height, 1e-6)) * naturalRatio;
            const fit = rect.fit
              ? clampAdaptivePhotoFit(rect.fit, cellAspect, photoAspect, fillMode)
              : null;
            const limits = photo
              ? adaptivePhotoFitLimits(cellAspect, photoAspect, fillMode, fit?.scale ?? 1)
              : { x: 0, y: 0 };
            const canPan = limits.x > 0.002 || limits.y > 0.002;
            const cellZone =
              dropTarget?.photoId === rect.photoId && !dropTarget.root ? dropTarget.zone : null;
            // 格间距只作用于照片之间：贴画布外沿的边不内缩，
            // 外圈留白完全由「边距」独立决定（可为 0，不随间距变化）
            const edgeInset = (direction: AdaptiveInsertDirection) =>
              isAdaptiveEdgeFlush(rect, direction) ? 0 : canvas.gap / 2;

            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: 照片格子是拖放目标，按方位判定插入位置
              <div
                key={rect.photoId}
                className="absolute"
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.width * 100}%`,
                  height: `${rect.height * 100}%`,
                  // 内部接缝两侧各缩 gap/2 合计成间距；贴外沿的边缩量为 0
                  padding: `${edgeInset('top')}px ${edgeInset('right')}px ${edgeInset('bottom')}px ${edgeInset('left')}px`,
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'copy';
                  const nextZone = computeDropZone(
                    event,
                    event.currentTarget.getBoundingClientRect(),
                  );
                  // 照片上的落点永远细分/替换这张照片，不因贴外沿而升级成根级插入：
                  // 占满整宽/整高的照片（如上1下1 的下排）其外侧边必然贴画布外沿，
                  // 若升级就永远无法横向劈开它；整行/整列插入只走边距外框落点。
                  setDropTarget((prev) =>
                    prev?.photoId === rect.photoId && prev.zone === nextZone && !prev.root
                      ? prev
                      : { photoId: rect.photoId, zone: nextZone, root: false },
                  );
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    return;
                  }
                  setDropTarget((prev) => (prev?.photoId === rect.photoId ? null : prev));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const draggedPhotoId = readDraggedPhotoId(event);
                  const nextZone = computeDropZone(
                    event,
                    event.currentTarget.getBoundingClientRect(),
                  );
                  setDropTarget(null);
                  if (draggedPhotoId) {
                    placePhoto(draggedPhotoId, rect.photoId, nextZone);
                  }
                }}
              >
                {/* biome-ignore lint/a11y/noStaticElementInteractions: 照片格子按住拖动平移取景（按下选中、双击重置） */}
                <div
                  className={cn(
                    'group relative h-full w-full overflow-hidden transition-colors hover:bg-muted/50',
                    // contain 下照片不铺满格子：底色让位给画布背景，空叶保留占位底色
                    photo && fillContain ? 'bg-transparent' : 'bg-muted/35',
                    // 位移被钳到 0（照片恰好铺满格子、无可平移余量）时不摆出抓手
                    canPan ? 'cursor-grab active:cursor-grabbing' : '',
                  )}
                  style={{
                    borderRadius: canvas.borderRadius,
                    boxShadow:
                      canvas.shadow > 0
                        ? `0 14px 28px -18px rgba(15, 23, 42, ${Math.min(canvas.shadow / 100, 0.35)})`
                        : 'none',
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) {
                      return;
                    }
                    if (!photo) {
                      // 点空叶（失效照片未回收前的占位）：清掉选中
                      selectAdaptivePhoto(null);
                      return;
                    }
                    // 「移除」按钮等内部控件不参与取景拖拽
                    if ((event.target as HTMLElement).closest('button')) {
                      return;
                    }
                    // 阻止默认行为避免选中文字/原生图片拖拽，并把后续指针事件锁到当前格子
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    selectAdaptivePhoto(rect.photoId);
                    const bounds = event.currentTarget.getBoundingClientRect();
                    panRef.current = {
                      photoId: rect.photoId,
                      startX: event.clientX,
                      startY: event.clientY,
                      cellWidth: Math.max(bounds.width, 1),
                      cellHeight: Math.max(bounds.height, 1),
                      fit: fit ?? DEFAULT_ADAPTIVE_FIT,
                    };
                    beginTransient();
                  }}
                  onPointerMove={(event) => {
                    const pan = panRef.current;
                    if (!pan || pan.photoId !== rect.photoId) {
                      return;
                    }
                    // 指针位移换算成格子比例（与存储单位一致，视口缩放不漂移），写入前钳到可达范围
                    setAdaptivePhotoFit(
                      pan.photoId,
                      clampAdaptivePhotoFit(
                        {
                          scale: pan.fit.scale,
                          offsetX: pan.fit.offsetX + (event.clientX - pan.startX) / pan.cellWidth,
                          offsetY: pan.fit.offsetY + (event.clientY - pan.startY) / pan.cellHeight,
                        },
                        cellAspect,
                        photoAspect,
                        fillMode,
                      ),
                    );
                  }}
                  onPointerUp={() => {
                    if (panRef.current?.photoId !== rect.photoId) {
                      return;
                    }
                    panRef.current = null;
                    endTransient();
                  }}
                  onPointerCancel={() => {
                    if (panRef.current?.photoId !== rect.photoId) {
                      return;
                    }
                    panRef.current = null;
                    endTransient();
                  }}
                  onDoubleClick={() => {
                    if (photo && rect.fit) {
                      setAdaptivePhotoFit(rect.photoId, null);
                    }
                  }}
                >
                  {photo ? (
                    <img
                      src={photo.previewUrl}
                      alt={photo.name}
                      className={cn(
                        'h-full w-full',
                        fillContain ? 'object-contain' : 'object-cover',
                      )}
                      draggable={false}
                      style={
                        fit
                          ? {
                              transform: `translate(${fit.offsetX * 100}%, ${fit.offsetY * 100}%) scale(${fit.scale})`,
                            }
                          : undefined
                      }
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                      <ImagePlus className="size-5" />
                    </div>
                  )}

                  {/* 选中态描边：独立覆盖层——格子自带内联 boxShadow，同元素上的 ring 类会被盖掉 */}
                  {rect.photoId === selectedAdaptivePhotoId ? (
                    <div
                      className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-primary"
                      style={{ borderRadius: canvas.borderRadius }}
                    />
                  ) : null}

                  {/* hover 浮现移除：只从画布去掉，不删磁盘文件 */}
                  <button
                    type="button"
                    aria-label="从画布移除"
                    title="从画布移除（不删除文件）"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeAdaptivePhoto(rect.photoId);
                    }}
                    className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75 group-hover:flex"
                  >
                    <X className="size-3.5" />
                  </button>

                  {cellZone ? (
                    <div
                      className="pointer-events-none absolute bg-primary/25 ring-2 ring-inset ring-primary"
                      style={ZONE_OVERLAY[cellZone]}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}

          {/* 分割线把手：叠在每个 split 的接缝上，拖动写手动比例，双击恢复自动 */}
          {splitRects.map((split) => {
            const vertical = split.dir === 'v';
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: 指针拖拽把手：按下起手势、移动写比例、松手收尾
              <div
                key={`split-${split.path.join('-')}`}
                title="拖动调整分割比例，双击恢复自动"
                className="absolute z-10 bg-transparent transition-colors hover:bg-primary/30"
                style={
                  vertical
                    ? {
                        left: `${(split.x + split.width * split.share) * 100}%`,
                        top: `${split.y * 100}%`,
                        height: `${split.height * 100}%`,
                        width: '8px',
                        marginLeft: '-4px',
                        cursor: 'col-resize',
                      }
                    : {
                        top: `${(split.y + split.height * split.share) * 100}%`,
                        left: `${split.x * 100}%`,
                        width: `${split.width * 100}%`,
                        height: '8px',
                        marginTop: '-4px',
                        cursor: 'row-resize',
                      }
                }
                onPointerDown={(event) => {
                  if (event.button !== 0) {
                    return;
                  }
                  // 阻止默认行为避免选中文字/图片拖拽，并把后续指针事件锁到把手上
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  splitDragRef.current = true;
                  beginTransient();
                }}
                onPointerMove={(event) => {
                  if (!splitDragRef.current || !contentRef.current) {
                    return;
                  }
                  const bounds = contentRef.current.getBoundingClientRect();
                  const fraction = vertical
                    ? (event.clientX - bounds.left) / Math.max(bounds.width, 1)
                    : (event.clientY - bounds.top) / Math.max(bounds.height, 1);
                  setSplitRatio(split.path, fraction);
                }}
                onPointerUp={() => {
                  if (!splitDragRef.current) {
                    return;
                  }
                  splitDragRef.current = false;
                  endTransient();
                }}
                onPointerCancel={() => {
                  if (!splitDragRef.current) {
                    return;
                  }
                  splitDragRef.current = false;
                  endTransient();
                }}
                onDoubleClick={() => setSplitRatio(split.path, null)}
              />
            );
          })}

          {/* 根级插入预览：高亮画布内容区该侧的一半（实际比例由照片宽高比决定） */}
          {dropTarget?.root ? (
            <div
              className="pointer-events-none absolute bg-primary/25 ring-2 ring-inset ring-primary"
              style={ZONE_OVERLAY[dropTarget.zone]}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
