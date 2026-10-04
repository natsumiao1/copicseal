import { ImagePlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  collectAdaptivePhotoIds,
  FALLBACK_PHOTO_RATIO,
  getAdaptiveRootRatio,
  photoRatio,
  pruneAdaptiveTree,
} from '@/features/collage/adaptive';
import { CollageAdaptiveLayout } from '@/features/collage/components/collage-adaptive-layout';
import { useCollagePhotoImport } from '@/features/collage/hooks/use-collage-photo-import';
import { COLLAGE_LAYOUTS } from '@/features/collage/layouts';
import {
  createEmptySlotState,
  getAspectRatioText,
  getAspectRatioValue,
} from '@/features/collage/lib';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import { useElementSize } from '@/shared/hooks/use-element-size';
import { usePhotos } from '@/shared/hooks/use-photos';
import { cn } from '@/shared/lib/utils';

export function CollageCanvas({
  previewRef,
}: {
  previewRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const { photos, currentPhoto } = usePhotos();
  const { ensureByPath } = useCollagePhotoImport();
  const { present, selectedSlotIndex, restorePending, selectSlot, assignPhotoToSlot, commit } =
    useCollageStore();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewportSize = useElementSize(viewportRef);

  const layout = useMemo(
    () => COLLAGE_LAYOUTS.find((item) => item.id === present.layoutId) ?? COLLAGE_LAYOUTS[0],
    [present.layoutId],
  );
  const isAdaptive = present.canvas.layoutMode === 'adaptive';
  const photoById = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);
  const resolvePhotoRatio = useCallback(
    (photoId: string) => {
      const photo = photoById.get(photoId);
      return photo ? photoRatio(photo) : FALLBACK_PHOTO_RATIO;
    },
    [photoById],
  );
  // 自适应模式：画布比例跟随内容 = 根节点比例；其余模式沿用画布比例设置
  const adaptiveRatio = useMemo(
    () => (isAdaptive ? getAdaptiveRootRatio(present.adaptiveTree, resolvePhotoRatio) : 1),
    [isAdaptive, present.adaptiveTree, resolvePhotoRatio],
  );
  const ratioValue = isAdaptive ? adaptiveRatio : getAspectRatioValue(present.canvas);
  /**
   * 「边距」按画布比例分配到两条轴：长边 = 滑杆值，短边 = 滑杆值 × 短/长。
   * 四边同值的均匀 px 边距会把内容框推离画布比例，格子按百分比铺满内容框后
   * 比例被整体压偏，`object-cover` 只能裁掉照片内容来填满（出现「挤压」观感）。
   * 按比例分配后内容框比例恒等于画布比例，任何边距下照片都零裁切零变形。
   */
  const contentPadding = `${present.canvas.padding * Math.min(1, 1 / ratioValue)}px ${
    present.canvas.padding * Math.min(1, ratioValue)
  }px`;
  const frameWidth = useMemo(() => {
    const availableWidth = Math.max(viewportSize.width - 48, 280);
    const availableHeight = Math.max(viewportSize.height - 48, 280);
    const widthFromHeight = availableHeight * ratioValue;
    return Math.max(280, Math.min(availableWidth, widthFromHeight));
  }, [ratioValue, viewportSize.height, viewportSize.width]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: present.layoutId 用于触发时机而非回调体——切换布局后 normalizeSlots 会补出空槽位，photos 未变时需要重跑一次自动填充
  useEffect(() => {
    // 重启恢复期间挂起对账：slotItems 持久化引用着上次会话的直览照片（id = 文件路径），
    // 等这些路径懒导入回填（或确认失效）后再放行，否则会把恢复出来的槽位清空。
    if (restorePending) {
      return;
    }

    if (present.canvas.layoutMode === 'adaptive') {
      // 自适应布局不自动填充：只校验树内引用，
      // 失效的照片（未恢复成功/已从会话删除）由叶子塌缩清除。
      const validPhotoIds = new Set(photos.map((photo) => photo.id));
      commit((draft) => {
        draft.adaptiveTree = pruneAdaptiveTree(draft.adaptiveTree, (photoId) =>
          validPhotoIds.has(photoId),
        );
      });
      return;
    }

    if (present.canvas.layoutMode === 'free') {
      commit((draft) => {
        draft.slotItems = photos.map((photo, index) => {
          const existing = draft.slotItems[index];
          // 槽位调整（位移/缩放/旋转）属于某张图：index 对应的图换了就从干净状态开始，
          // 否则旧图的残留位移会套到新图上，把图推出可视区。
          const base =
            existing && existing.photoId === photo.id ? existing : createEmptySlotState();
          return {
            ...base,
            photoId: photo.id,
          };
        });
      });
      return;
    }

    const validPhotoIds = new Set(photos.map((photo) => photo.id));

    commit((draft) => {
      const usedPhotoIds = new Set<string>();

      draft.slotItems = draft.slotItems.map((slot) => {
        if (slot.photoId && validPhotoIds.has(slot.photoId) && !usedPhotoIds.has(slot.photoId)) {
          usedPhotoIds.add(slot.photoId);
          return slot;
        }

        // 图已失效（换会话重新导入后 photoId 全部变化，而 slotItems 会被持久化）：
        // 必须连同位移/缩放一并重置，否则新图会继承旧图的残留 transform，
        // 表现为「槽位明明填了图却像空的一样」。
        return createEmptySlotState();
      });

      const availablePhotoIds = photos
        .map((photo) => photo.id)
        .filter((photoId) => !usedPhotoIds.has(photoId));

      draft.slotItems = draft.slotItems.map((slot) => {
        if (slot.photoId || availablePhotoIds.length === 0) {
          return slot;
        }

        const nextPhotoId = availablePhotoIds.shift() ?? null;
        return {
          ...createEmptySlotState(),
          photoId: nextPhotoId,
        };
      });
    });
  }, [commit, photos, present.layoutId, present.canvas.layoutMode, restorePending]);

  const freeLayoutItems = useMemo(
    () =>
      photos.map((photo, index) => ({
        photo,
        slot: present.slotItems[index] ?? createEmptySlotState(),
        index,
      })),
    [photos, present.slotItems],
  );

  if (photos.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 text-center text-muted-foreground">
        <ImagePlus className="size-14 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">拼图预览</h1>
          <p className="mt-2 text-sm leading-6">
            从左侧文件夹选择图片，这里会显示真实拼图预览结果。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between border-b border-border/80 px-4 py-3 text-xs text-muted-foreground">
        <span>
          当前布局{' '}
          {isAdaptive ? '自适应' : present.canvas.layoutMode === 'free' ? '自由布局' : layout.name}{' '}
          ·{' '}
          {isAdaptive
            ? `${collectAdaptivePhotoIds(present.adaptiveTree).length} 张图`
            : present.canvas.layoutMode === 'free'
              ? `${photos.length} 张图`
              : `${layout.count} 格`}
        </span>
        <span>画布比例 {isAdaptive ? '跟随内容' : getAspectRatioText(present.canvas)}</span>
      </div>

      <div ref={viewportRef} className="flex min-h-0 flex-1 items-center justify-center p-4">
        {/* 画布直接贴着描边，不设固定装裱白边：「边距」滑杆即可把外圈留白真正调到 0 */}
        <div
          className="border border-border/80 bg-white/80 shadow-[0_24px_80px_-36px_rgba(15,23,42,0.32)]"
          style={{
            width: `${frameWidth}px`,
            maxWidth: '100%',
          }}
        >
          <div
            ref={previewRef}
            className="relative w-full overflow-hidden"
            style={{
              aspectRatio: ratioValue,
              backgroundColor: present.canvas.backgroundColor,
              backgroundImage: present.canvas.backgroundImage
                ? `linear-gradient(rgba(255,255,255,0.16), rgba(255,255,255,0.16)), url(${present.canvas.backgroundImage})`
                : undefined,
              backgroundPosition: 'center',
              backgroundSize: 'cover',
            }}
          >
            {isAdaptive ? (
              <CollageAdaptiveLayout photoById={photoById} contentPadding={contentPadding} />
            ) : present.canvas.layoutMode === 'free' ? (
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ padding: present.canvas.padding }}
              >
                {freeLayoutItems.map(({ photo, slot, index }) => {
                  const baseLeft = 6 + (index % 3) * 26;
                  const baseTop = 8 + Math.floor(index / 3) * 26;

                  return (
                    <button
                      key={`free-${photo.id}`}
                      type="button"
                      className={cn(
                        'group absolute aspect-[4/3] w-[30%] overflow-hidden bg-muted/35 text-left transition-colors',
                        selectedSlotIndex === index
                          ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                          : 'hover:bg-muted/50',
                      )}
                      style={{
                        left: `${baseLeft}%`,
                        top: `${baseTop}%`,
                        borderRadius: slot.borderRadius ?? present.canvas.borderRadius,
                        boxShadow:
                          present.canvas.shadow > 0
                            ? `0 14px 28px -18px rgba(15, 23, 42, ${Math.min(
                                present.canvas.shadow / 100,
                                0.35,
                              )})`
                            : 'none',
                        transform: `translate(${slot.offsetX}px, ${slot.offsetY}px) scale(${slot.scale}) rotate(${slot.rotation}deg)`,
                      }}
                      onClick={() => selectSlot(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        selectSlot(index);
                        const startX = event.clientX;
                        const startY = event.clientY;
                        const startOffsetX = slot.offsetX;
                        const startOffsetY = slot.offsetY;

                        const handleMove = (moveEvent: MouseEvent) => {
                          commit((draft) => {
                            const currentSlot = draft.slotItems[index] ?? createEmptySlotState();
                            draft.slotItems[index] = {
                              ...currentSlot,
                              offsetX: startOffsetX + (moveEvent.clientX - startX),
                              offsetY: startOffsetY + (moveEvent.clientY - startY),
                              photoId: photo.id,
                            };
                          });
                        };

                        const handleUp = () => {
                          window.removeEventListener('mousemove', handleMove);
                          window.removeEventListener('mouseup', handleUp);
                        };

                        window.addEventListener('mousemove', handleMove);
                        window.addEventListener('mouseup', handleUp);
                      }}
                    >
                      <img
                        src={photo.previewUrl}
                        alt={photo.name}
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    </button>
                  );
                })}
              </div>
            ) : (
              <div
                className="absolute inset-0 grid"
                style={{
                  gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
                  gridTemplateRows: 'repeat(12, minmax(0, 1fr))',
                  gap: present.canvas.gap,
                  padding: contentPadding,
                }}
              >
                {/* 以 layout.slots 为循环源：slotItems 是可持久化的用户状态，长度可能
                    暂时超过当前布局的槽位表（历史脏数据、切换布局的中间态），
                    按 slotItems 循环会让 layout.slots[index] 越界并清空整窗。 */}
                {layout.slots.map((gridSlot, index) => {
                  const slotItem = present.slotItems[index] ?? createEmptySlotState();
                  const photo = slotItem.photoId
                    ? (photos.find((item) => item.id === slotItem.photoId) ?? null)
                    : null;

                  return (
                    <button
                      key={`${layout.id}-${slotItem.photoId ?? `empty-${gridSlot.x}-${gridSlot.y}`}`}
                      type="button"
                      className={cn(
                        'group relative overflow-hidden bg-muted/35 text-left transition-colors',
                        selectedSlotIndex === index
                          ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                          : 'hover:bg-muted/50',
                      )}
                      style={{
                        gridColumn: `${gridSlot.x + 1} / span ${gridSlot.w}`,
                        gridRow: `${gridSlot.y + 1} / span ${gridSlot.h}`,
                        borderRadius: slotItem.borderRadius ?? present.canvas.borderRadius,
                        boxShadow:
                          present.canvas.shadow > 0
                            ? `0 14px 28px -18px rgba(15, 23, 42, ${Math.min(
                                present.canvas.shadow / 100,
                                0.35,
                              )})`
                            : 'none',
                      }}
                      onClick={() => {
                        if (!photo && currentPhoto) {
                          assignPhotoToSlot(index, currentPhoto.id);
                        }
                        selectSlot(index);
                      }}
                      onDragEnter={(event) => {
                        // WKWebView/Safari 要求 dragenter 与 dragover 都被取消才放行 drop，
                        // 只取消 dragover 时拖拽高亮正常但松手不触发 drop（Chrome 则只看 dragover）。
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'copy';
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        // WKWebView/Safari：dragover 不显式声明 dropEffect 时，
                        // 可能与 dragstart 的 effectAllowed 不匹配导致 drop 根本不触发。
                        event.dataTransfer.dropEffect = 'copy';
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const photoId =
                          event.dataTransfer.getData('text/copicseal-photo-id') ||
                          event.dataTransfer.getData('text/plain');
                        if (photoId) {
                          if (photos.some((item) => item.id === photoId)) {
                            assignPhotoToSlot(index, photoId);
                          } else {
                            // 直览条目：先懒导入进会话再落槽，否则对账会把未入会话的引用清掉
                            void ensureByPath(photoId).then(() => {
                              assignPhotoToSlot(index, photoId);
                            });
                          }
                        }
                        selectSlot(index);
                      }}
                    >
                      {photo ? (
                        <img
                          src={photo.previewUrl}
                          alt={photo.name}
                          className="h-full w-full object-cover"
                          style={{
                            transform: `translate(${slotItem.offsetX}px, ${slotItem.offsetY}px) scale(${slotItem.scale}) rotate(${slotItem.rotation}deg)`,
                          }}
                          draggable={false}
                        />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                          <ImagePlus className="size-5" />
                          <span className="text-xs">点击填充当前图片</span>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
