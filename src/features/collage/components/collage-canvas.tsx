import { ImagePlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collectAdaptivePhotoIds,
  FALLBACK_PHOTO_RATIO,
  getAdaptiveRootRatio,
  photoRatio,
  pruneAdaptiveTree,
} from '@/features/collage/adaptive';
import { CollageAdaptiveLayout } from '@/features/collage/components/collage-adaptive-layout';
import { COLLAGE_LAYOUTS } from '@/features/collage/layouts';
import {
  clamp,
  createEmptySlotState,
  getAspectRatioText,
  getAspectRatioValue,
  MAX_CANVAS_RATIO,
  MIN_CANVAS_RATIO,
} from '@/features/collage/lib';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import { useElementSize } from '@/shared/hooks/use-element-size';
import { usePhotoImportByPath } from '@/shared/hooks/use-photo-import-by-path';
import { usePhotos } from '@/shared/hooks/use-photos';
import { cn } from '@/shared/lib/utils';

/**
 * 画布把手：四边中点 = T 字形（横梁压在画布边缘线上、竖茎垂直伸向画布内侧），
 * 四角 = 横竖两臂的 L 形贴角（臂同样骑缝在两条边缘线上）。
 * `className` 管命中框定位（16×16 便于点选），`arms` 是两条描线臂的定位类（底色与阴影在渲染处统一）。
 * 拖拽几何按 key 另行推导，光标随手柄方向。
 */
const RESIZE_HANDLES = [
  {
    key: 'nw',
    className: '-left-px -top-px h-4 w-4',
    cursor: 'nwse-resize',
    arms: ['left-0 top-0 h-0.5 w-4', 'left-0 top-0 h-4 w-0.5'],
  },
  {
    key: 'n',
    className: 'left-1/2 -top-2 h-4 w-4 -translate-x-1/2',
    cursor: 'ns-resize',
    arms: [
      'top-1/2 left-0 h-0.5 w-4 -translate-y-1/2',
      'left-1/2 bottom-0 h-2 w-0.5 -translate-x-1/2',
    ],
  },
  {
    key: 'ne',
    className: '-right-px -top-px h-4 w-4',
    cursor: 'nesw-resize',
    arms: ['right-0 top-0 h-0.5 w-4', 'right-0 top-0 h-4 w-0.5'],
  },
  {
    key: 'e',
    className: '-right-2 top-1/2 h-4 w-4 -translate-y-1/2',
    cursor: 'ew-resize',
    arms: [
      'left-1/2 top-0 h-4 w-0.5 -translate-x-1/2',
      'top-1/2 left-0 h-0.5 w-2 -translate-y-1/2',
    ],
  },
  {
    key: 'se',
    className: '-right-px -bottom-px h-4 w-4',
    cursor: 'nwse-resize',
    arms: ['right-0 bottom-0 h-0.5 w-4', 'right-0 bottom-0 h-4 w-0.5'],
  },
  {
    key: 's',
    className: 'left-1/2 -bottom-2 h-4 w-4 -translate-x-1/2',
    cursor: 'ns-resize',
    arms: [
      'top-1/2 left-0 h-0.5 w-4 -translate-y-1/2',
      'left-1/2 top-0 h-2 w-0.5 -translate-x-1/2',
    ],
  },
  {
    key: 'sw',
    className: '-left-px -bottom-px h-4 w-4',
    cursor: 'nesw-resize',
    arms: ['left-0 bottom-0 h-0.5 w-4', 'left-0 bottom-0 h-4 w-0.5'],
  },
  {
    key: 'w',
    className: '-left-2 top-1/2 h-4 w-4 -translate-y-1/2',
    cursor: 'ew-resize',
    arms: [
      'left-1/2 top-0 h-4 w-0.5 -translate-x-1/2',
      'top-1/2 right-0 h-0.5 w-2 -translate-y-1/2',
    ],
  },
] as const;

type ResizeHandleKey = (typeof RESIZE_HANDLES)[number]['key'];

/**
 * 手势 → 自适应「套内容框」的锚定：内容贴住画布不动的那组对边，
 * 余量（留白）只往被拖方向堆积——观感即「画布向外延伸、画面原地不动」。
 */
const FRAME_ANCHOR: Record<
  ResizeHandleKey,
  { justify: 'start' | 'center' | 'end'; align: 'start' | 'center' | 'end' }
> = {
  nw: { justify: 'end', align: 'end' },
  n: { justify: 'center', align: 'end' },
  ne: { justify: 'start', align: 'end' },
  e: { justify: 'start', align: 'center' },
  se: { justify: 'start', align: 'start' },
  s: { justify: 'center', align: 'start' },
  sw: { justify: 'end', align: 'start' },
  w: { justify: 'end', align: 'center' },
};

/** 起手势快照：视口屏幕框 + 基准帧滚动量；画布框换算为内容坐标（锚定边在滚动中内容位不变） */
interface ResizeSnapshot {
  viewport: { left: number; top: number; right: number; bottom: number };
  /** 起手势的预览区滚动量：几何换算冻结在此帧——自动滚动只影响呈现，不反馈进换算 */
  scroll: { left: number; top: number };
  box: { left: number; top: number; width: number; height: number };
}

/** 拖拽时的最小画布边长（px），防止把边拖过锚边得到负尺寸 */
const RESIZE_MIN_EDGE = 40;
/** 拖到预览区内缩多少 px 时开始自动滚动（向下/右）或钉边（向上/左），给把手外沿留可见富余 */
const RESIZE_SCROLL_MARGIN = 12;
/** 把手伸出画布外沿的距离（1.5×4px）+ 富余：可滚内容区按此扩展上限 */
const RESIZE_HANDLE_REACH = 8;

/**
 * 各把手的拖拽生长方向：
 * `+1` = 向下/右延伸（内容自然生长 → 预览自动滚动跟随）；
 * `-1` = 向上/左延伸（滚动原点不能为负 → 被拖边钉在预览边缘、原锚边延展）；
 * `0` = 该轴不参与。
 */
const RESIZE_SCROLL_DIR: Record<ResizeHandleKey, { x: number; y: number }> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

export function CollageCanvas({
  previewRef,
}: {
  previewRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const { photos, currentPhoto } = usePhotos();
  const { ensureByPath } = usePhotoImportByPath();
  const {
    present,
    selectedSlotIndex,
    restorePending,
    selectSlot,
    assignPhotoToSlot,
    commit,
    updateCanvas,
    beginTransient,
    updateSlotTransient,
    endTransient,
  } = useCollageStore();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewportSize = useElementSize(viewportRef);

  const layout = useMemo(
    () => COLLAGE_LAYOUTS.find((item) => item.id === present.layoutId) ?? COLLAGE_LAYOUTS[0],
    [present.layoutId],
  );
  const isAdaptive = present.canvas.layoutMode === 'adaptive';
  /** 照片填充：contain = 完整显示、留白透出画布背景（自动比例下自适应两模式渲染一致，拖过分割线后生效） */
  const fillContain = present.canvas.fillMode === 'contain';
  const photoById = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);
  const resolvePhotoRatio = useCallback(
    (photoId: string) => {
      const photo = photoById.get(photoId);
      return photo ? photoRatio(photo) : FALLBACK_PHOTO_RATIO;
    },
    [photoById],
  );
  // 自适应模式：画布比例默认跟随内容 = 根节点比例（照片树整框铺满）；
  // 用户切固定比例后画布按所选比例呈现，照片树在画布内 contain 居中（套内容）。
  // 其余模式沿用画布比例设置。
  const adaptiveRatio = useMemo(
    () => (isAdaptive ? getAdaptiveRootRatio(present.adaptiveTree, resolvePhotoRatio) : 1),
    [isAdaptive, present.adaptiveTree, resolvePhotoRatio],
  );
  const ratioValue =
    isAdaptive && present.canvas.adaptiveFollowContent !== false
      ? adaptiveRatio
      : getAspectRatioValue(present.canvas);
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
    // 始终让画布完整落在视口内：极扁/极高的自由比例下宁可整体缩小，
    // 也不因 280px 下限把预览顶出视口
    return Math.min(availableWidth, availableHeight * ratioValue);
  }, [ratioValue, viewportSize.height, viewportSize.width]);

  /** 套内容框的锚定方位（贴住画布对侧边，余量向拖拽方向堆积） */
  type FrameAnchor = { justify: 'start' | 'center' | 'end'; align: 'start' | 'center' | 'end' };

  /**
   * 画布把手拖拽的持久状态：
   * - `manualFrame`：视口坐标系下的手动几何——拖拽期间与结束后画布不再居中重排，只有被拖的边延伸；
   * - `frameAnchor`：自适应套内容框的贴边方位；
   * - 快照 / 进行中标记 / 比例对账基准（非手势改动比例时丢弃手动几何）。
   */
  const resizeSnapshotRef = useRef<ResizeSnapshot | null>(null);
  const resizeDraggingRef = useRef(false);
  const lastAppliedRatioRef = useRef<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [manualFrame, setManualFrame] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const [frameAnchor, setFrameAnchor] = useState<FrameAnchor | null>(null);

  /** 把手按下：快照视口与画布框（对侧锚定基准），手动几何从当前位置无缝接管 */
  const startResize = (event: React.PointerEvent<HTMLDivElement>, key: ResizeHandleKey) => {
    if (event.button !== 0) {
      return;
    }
    const viewport = viewportRef.current;
    const wrapper = event.currentTarget.parentElement;
    if (!viewport || !wrapper) {
      return;
    }
    // 阻止默认行为避免选中/图片拖拽，并把后续指针事件锁到把手上
    event.preventDefault();
    const vpBounds = viewport.getBoundingClientRect();
    const boxBounds = wrapper.getBoundingClientRect();
    resizeSnapshotRef.current = {
      viewport: {
        left: vpBounds.left,
        top: vpBounds.top,
        right: vpBounds.right,
        bottom: vpBounds.bottom,
      },
      scroll: { left: viewport.scrollLeft, top: viewport.scrollTop },
      box: {
        // 内容坐标 = 屏幕位 + 滚动量：滚动只让画面滑动，锚定边的内容位保持不变
        left: boxBounds.left - vpBounds.left + viewport.scrollLeft,
        top: boxBounds.top - vpBounds.top + viewport.scrollTop,
        width: boxBounds.width,
        height: boxBounds.height,
      },
    };
    setManualFrame({
      left: boxBounds.left - vpBounds.left + viewport.scrollLeft,
      top: boxBounds.top - vpBounds.top + viewport.scrollTop,
      width: boxBounds.width,
    });
    setFrameAnchor(FRAME_ANCHOR[key]);
    resizeDraggingRef.current = true;
    setIsResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    beginTransient();
  };

  /**
   * 拖动中：对侧边锚定在快照位置不动、被拖的边跟手——不钳指针，画布可延伸出预览区。
   * 拖到预览边缘时保证被拖边全程可见：
   * - 向下/右（内容自然生长、滚动空间天然存在）→ 预览自动滚动跟随，
   *   拖拽边钉在预览边缘、锚定边随滚动滑出；
   * - 向上/左（滚动原点不能为负，无处可滚）→ 被拖边钉在预览边缘内缩处、
   *   原锚边改为延展——视觉与滚动等价，且盒内无负坐标，松手后可完整回看。
   * 指针换算冻结在起手势基准帧（滚动不反馈进几何，幂等不漂移）；
   * 比例本身钳 1:5 ~ 5:1，天然限制单轴最大伸长为另一轴的 5 倍。
   * 手动几何存内容坐标——期间与之后画布都不再居中重排。
   */
  const moveResize = (event: React.PointerEvent<HTMLDivElement>, key: ResizeHandleKey) => {
    const snapshot = resizeSnapshotRef.current;
    if (!resizeDraggingRef.current || !snapshot) {
      return;
    }
    const { viewport: vp, box: b, scroll: scrollAtStart } = snapshot;
    const dir = RESIZE_SCROLL_DIR[key];
    const px = event.clientX - vp.left + scrollAtStart.left;
    const py = event.clientY - vp.top + scrollAtStart.top;
    const right = b.left + b.width;
    const bottom = b.top + b.height;

    let left = b.left;
    let top = b.top;
    let width = b.width;
    let height = b.height;
    switch (key) {
      case 'e':
        width = Math.max(RESIZE_MIN_EDGE, px - b.left);
        break;
      case 'w':
        width = Math.max(RESIZE_MIN_EDGE, right - px);
        left = right - width;
        break;
      case 's':
        height = Math.max(RESIZE_MIN_EDGE, py - b.top);
        break;
      case 'n':
        height = Math.max(RESIZE_MIN_EDGE, bottom - py);
        top = bottom - height;
        break;
      case 'se':
        width = Math.max(RESIZE_MIN_EDGE, px - b.left);
        height = Math.max(RESIZE_MIN_EDGE, py - b.top);
        break;
      case 'ne':
        width = Math.max(RESIZE_MIN_EDGE, px - b.left);
        height = Math.max(RESIZE_MIN_EDGE, bottom - py);
        top = bottom - height;
        break;
      case 'sw':
        width = Math.max(RESIZE_MIN_EDGE, right - px);
        left = right - width;
        height = Math.max(RESIZE_MIN_EDGE, py - b.top);
        break;
      default: {
        // nw：右、下两边锚定
        width = Math.max(RESIZE_MIN_EDGE, right - px);
        left = right - width;
        height = Math.max(RESIZE_MIN_EDGE, bottom - py);
        top = bottom - height;
        break;
      }
    }

    // 目标比例钳到安全范围后反推尺寸：画布实际高度恒等于 宽 / 比例，与预览 aspect 一致
    const ratio = clamp(width / height, MIN_CANVAS_RATIO, MAX_CANVAS_RATIO);
    if (key === 'e' || key === 'w') {
      width = ratio * b.height;
      if (key === 'w') {
        left = right - width;
      }
    } else if (key === 'n' || key === 's') {
      height = b.width / ratio;
      if (key === 'n') {
        top = bottom - height;
      }
    } else {
      // 角：横向跟指针，纵向按比例反推（锚定的上/下边不动）
      height = width / ratio;
      if (key === 'ne' || key === 'nw') {
        top = bottom - height;
      }
    }

    // 向上/左没有可滚空间：被拖边钉在预览边缘内缩处（滚动起点 + 内缩量）、原锚边延展，
    // 被拖边全程可见；渲染盒 = [钉住的 top/left, + 尺寸]，无负坐标，松手后可完整回看
    if (dir.y < 0) {
      top = Math.max(top, scrollAtStart.top + RESIZE_SCROLL_MARGIN);
    }
    if (dir.x < 0) {
      left = Math.max(left, scrollAtStart.left + RESIZE_SCROLL_MARGIN);
    }

    setManualFrame({ left, top, width });

    // 向下/右拖到预览区边缘外 → 自动滚动跟随：拖拽边钉在预览边缘继续可见，锚定边随滚动
    // 滑出。上限按内容底/右边直接算（画布边 + 把手外沿），不依赖尚未提交到 DOM 的新尺寸。
    const viewportEl = viewportRef.current;
    if (viewportEl) {
      if (dir.y > 0) {
        const edgeY = vp.bottom - RESIZE_SCROLL_MARGIN;
        const deltaY = Math.max(0, event.clientY - edgeY);
        const maxTop = Math.max(0, top + height + RESIZE_HANDLE_REACH - viewportEl.clientHeight);
        viewportEl.scrollTop = Math.min(Math.max(scrollAtStart.top + deltaY, 0), maxTop);
      }
      if (dir.x > 0) {
        const edgeX = vp.right - RESIZE_SCROLL_MARGIN;
        const deltaX = Math.max(0, event.clientX - edgeX);
        const maxLeft = Math.max(0, left + width + RESIZE_HANDLE_REACH - viewportEl.clientWidth);
        viewportEl.scrollLeft = Math.min(Math.max(scrollAtStart.left + deltaX, 0), maxLeft);
      }
    }

    updateCanvas({
      aspectPreset: 'custom',
      customRatioWidth: Math.round(ratio * 100),
      customRatioHeight: 100,
      // 自适应下拖把手 = 从「跟随内容」接管为固定比例（走套内容渲染）
      ...(isAdaptive ? { adaptiveFollowContent: false } : {}),
    });
  };

  const endResize = () => {
    if (!resizeDraggingRef.current) {
      return;
    }
    resizeDraggingRef.current = false;
    setIsResizing(false);
    endTransient();
  };

  // 比例被手势之外的途径改掉（预设按钮 / 撤销重做 / 跟随内容切换）→ 丢弃手动几何，
  // 回归自适应视口居中；手势进行中的比例变化只更新对账基准，不触发。
  useEffect(() => {
    if (
      lastAppliedRatioRef.current !== null &&
      lastAppliedRatioRef.current !== ratioValue &&
      !resizeDraggingRef.current
    ) {
      setManualFrame(null);
      setFrameAnchor(null);
    }
    lastAppliedRatioRef.current = ratioValue;
  }, [ratioValue]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 视口尺寸仅作触发时机——尺寸变化时作废手动几何、重新贴合视口
  useEffect(() => {
    setManualFrame(null);
    setFrameAnchor(null);
  }, [viewportSize.height, viewportSize.width]);

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
        <span>
          画布比例{' '}
          {isAdaptive && present.canvas.adaptiveFollowContent !== false
            ? '跟随内容'
            : getAspectRatioText(present.canvas)}
        </span>
      </div>

      <div
        ref={viewportRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
      >
        {/* 画布直接贴着描边，不设固定装裱白边：「边距」滑杆即可把外圈留白真正调到 0 */}
        <div
          className="group relative border border-border/80 bg-white/80 shadow-[0_24px_80px_-36px_rgba(15,23,42,0.32)]"
          style={
            manualFrame
              ? // 拖过把手：绝对定位的手动几何——对边锚定、不回弹不重排
                {
                  position: 'absolute',
                  left: `${manualFrame.left}px`,
                  top: `${manualFrame.top}px`,
                  width: `${manualFrame.width}px`,
                }
              : {
                  width: `${frameWidth}px`,
                  maxWidth: '100%',
                }
          }
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
              <CollageAdaptiveLayout
                photoById={photoById}
                contentPadding={contentPadding}
                contentAnchor={frameAnchor ?? undefined}
              />
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
                        'group absolute aspect-[4/3] w-[30%] overflow-hidden text-left transition-colors',
                        // contain 留白要透出画布背景：格子底色让位，仅 hover 时给出反馈
                        fillContain ? 'bg-transparent' : 'bg-muted/35',
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
                        // 拖拽是连续手势：期间只做临时更新，松手才把起点快照作为一步历史入栈，
                        // 否则每个 mousemove 都入栈，撤销会退化成「按像素撤销」
                        beginTransient();
                        const startX = event.clientX;
                        const startY = event.clientY;
                        const startOffsetX = slot.offsetX;
                        const startOffsetY = slot.offsetY;

                        const handleUp = () => {
                          window.removeEventListener('mousemove', handleMove);
                          window.removeEventListener('mouseup', handleUp);
                          window.removeEventListener('blur', handleUp);
                          endTransient();
                        };

                        const handleMove = (moveEvent: MouseEvent) => {
                          // 在窗口外松手收不到 mouseup：回到窗口后的第一次移动 buttons 已归零，
                          // 据此补一次收尾，避免监听器与手势基线一直挂着
                          if (moveEvent.buttons === 0) {
                            handleUp();
                            return;
                          }
                          updateSlotTransient(index, {
                            offsetX: startOffsetX + (moveEvent.clientX - startX),
                            offsetY: startOffsetY + (moveEvent.clientY - startY),
                            photoId: photo.id,
                          });
                        };

                        window.addEventListener('mousemove', handleMove);
                        window.addEventListener('mouseup', handleUp);
                        // 拖拽中切走窗口（焦点丢失）时同样收尾
                        window.addEventListener('blur', handleUp);
                      }}
                    >
                      <img
                        src={photo.previewUrl}
                        alt={photo.name}
                        className={cn(
                          'h-full w-full',
                          fillContain ? 'object-contain' : 'object-cover',
                        )}
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
                  // photoById 已按会话照片建好索引：这里避免每个槽位线性扫一遍 photos
                  const photo = slotItem.photoId ? (photoById.get(slotItem.photoId) ?? null) : null;

                  return (
                    <button
                      key={`${layout.id}-${slotItem.photoId ?? `empty-${gridSlot.x}-${gridSlot.y}`}`}
                      type="button"
                      className={cn(
                        'group relative overflow-hidden text-left transition-colors',
                        // contain 下已有照片的格子底色让位给画布背景，空槽位保留占位底色
                        photo && fillContain ? 'bg-transparent' : 'bg-muted/35',
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
                          className={cn(
                            'h-full w-full',
                            fillContain ? 'object-contain' : 'object-cover',
                          )}
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
          {/* 边角把手：四角 = 横竖两臂的 L 形贴角，四边中点 = T 字形（横梁压在画布边缘线上、竖茎伸向画布内侧）；
              hover 浮现、拖动期间常显；导出只截预览层，不含把手 */}
          {RESIZE_HANDLES.map((handle) => (
            <div
              key={handle.key}
              title="拖拽调整画布比例"
              className={cn(
                'absolute z-10 transition-opacity drop-shadow-[0_1px_2px_rgba(15,23,42,0.5)]',
                isResizing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                handle.className,
              )}
              style={{ cursor: handle.cursor }}
              onPointerDown={(event) => startResize(event, handle.key)}
              onPointerMove={(event) => moveResize(event, handle.key)}
              onPointerUp={endResize}
              onPointerCancel={endResize}
            >
              {handle.arms.map((arm) => (
                <div key={arm} className={cn('absolute bg-background', arm)} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
