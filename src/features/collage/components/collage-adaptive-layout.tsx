import { ImagePlus, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  computeAdaptiveRects,
  FALLBACK_PHOTO_RATIO,
  isAdaptiveEdgeFlush,
  photoRatio,
} from '@/features/collage/adaptive';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import type { AdaptiveInsertDirection } from '@/features/collage/types';
import { usePhotoImportByPath } from '@/shared/hooks/use-photo-import-by-path';
import { usePhotos } from '@/shared/hooks/use-photos';
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
}

/**
 * 自适应布局的画布内容：按树递归计算每张照片的矩形并绝对定位。
 *
 * 格子比例 == 照片自然比例（`object-cover` 因此无变形无裁切）；
 * `gap/2` 内缩形成格间距，画布边距由外层按画布比例分配后传入（内容框恒等比）。
 * 拖放交互：照片上的落点细分或替换这张照片（即使它的边贴合画布外沿，
 * 如上1下1 的下排占满整宽，拖到左侧即劈成上1下2）；
 * 边距外框落点沿最近外沿整体插入一整行/一列；空画布直接落第一张。
 */
export function CollageAdaptiveLayout({ photoById, contentPadding }: CollageAdaptiveLayoutProps) {
  const tree = useCollageStore((state) => state.present.adaptiveTree);
  const canvas = useCollageStore((state) => state.present.canvas);
  const insertAdaptivePhoto = useCollageStore((state) => state.insertAdaptivePhoto);
  const replaceAdaptivePhoto = useCollageStore((state) => state.replaceAdaptivePhoto);
  const removeAdaptivePhoto = useCollageStore((state) => state.removeAdaptivePhoto);
  const { ensureByPath } = usePhotoImportByPath();
  const { photos } = usePhotos();
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const [dropTarget, setDropTarget] = useState<AdaptiveDropTarget | null>(null);

  const resolveRatio = useCallback(
    (photoId: string) => {
      const photo = photoById.get(photoId);
      return photo ? photoRatio(photo) : FALLBACK_PHOTO_RATIO;
    },
    [photoById],
  );

  const rects = useMemo(() => computeAdaptiveRects(tree, resolveRatio), [resolveRatio, tree]);

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
      className="absolute inset-0"
      style={{ padding: contentPadding }}
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
      <div className="relative h-full w-full">
        {rects.length === 0 ? (
          <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <ImagePlus className="size-8" />
            <span className="text-xs">从左侧拖入照片开始拼图</span>
          </div>
        ) : null}

        {rects.map((rect) => {
          const photo = photoById.get(rect.photoId);
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
              <div
                className="group relative h-full w-full overflow-hidden bg-muted/35 transition-colors hover:bg-muted/50"
                style={{
                  borderRadius: canvas.borderRadius,
                  boxShadow:
                    canvas.shadow > 0
                      ? `0 14px 28px -18px rgba(15, 23, 42, ${Math.min(canvas.shadow / 100, 0.35)})`
                      : 'none',
                }}
              >
                {photo ? (
                  <img
                    src={photo.previewUrl}
                    alt={photo.name}
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                    <ImagePlus className="size-5" />
                  </div>
                )}

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

        {/* 根级插入预览：高亮画布内容区该侧的一半（实际比例由照片宽高比决定） */}
        {dropTarget?.root ? (
          <div
            className="pointer-events-none absolute bg-primary/25 ring-2 ring-inset ring-primary"
            style={ZONE_OVERLAY[dropTarget.zone]}
          />
        ) : null}
      </div>
    </div>
  );
}
