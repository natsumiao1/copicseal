import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { coalescedLocalStorage } from '@/shared/lib/coalesced-storage';
import {
  collectAdaptivePhotoIds,
  hasAdaptivePhoto,
  insertAdaptivePhoto,
  insertAdaptiveRoot,
  removeAdaptivePhoto,
  replaceAdaptivePhoto,
  setAdaptivePhotoFit,
  setAdaptiveSplitRatio,
} from '../adaptive';
import { COLLAGE_LAYOUTS } from '../layouts';
import { createAnnotation, createEmptySlotState, getDefaultCanvasState } from '../lib';
import type {
  AdaptiveInsertDirection,
  AdaptivePhotoFit,
  CollageAnnotation,
  CollageCanvasState,
  CollagePresentState,
  CollageSlotState,
} from '../types';

const DEFAULT_LAYOUT = COLLAGE_LAYOUTS[0];

function clonePresentState(state: CollagePresentState): CollagePresentState {
  return structuredClone(state);
}

function getDefaultPresentState(): CollagePresentState {
  return {
    layoutId: DEFAULT_LAYOUT.id,
    canvas: getDefaultCanvasState(),
    slotItems: Array.from({ length: DEFAULT_LAYOUT.count }, () => createEmptySlotState()),
    annotations: [],
    adaptiveTree: null,
  };
}

/**
 * 归一化槽位数组，使其与当前布局匹配。
 *
 * - grid：长度严格等于 layout.count（多退少补）。历史实现取 `Math.max(count, slotItems.length)`
 *   导致「大布局切小布局」后残留多余槽位并被持久化，画布按 layout.slots 取值时越界崩溃。
 * - free：槽位按 index 承载每张图的缩放/位移，长度跟素材走，不能按 layout 裁剪。
 */
function normalizeSlots(
  layoutId: string,
  slotItems: CollageSlotState[],
  layoutMode: CollageCanvasState['layoutMode'] = 'grid',
): CollageSlotState[] {
  const layout = COLLAGE_LAYOUTS.find((item) => item.id === layoutId) ?? DEFAULT_LAYOUT;
  const count = layoutMode === 'free' ? Math.max(slotItems.length, 1) : layout.count;
  return Array.from({ length: count }, (_, index) => {
    const existing = slotItems[index];
    return existing
      ? {
          ...createEmptySlotState(),
          ...existing,
        }
      : createEmptySlotState();
  });
}

function normalizeAnnotations(annotations: CollageAnnotation[]): CollageAnnotation[] {
  return annotations.map((annotation) => {
    if (annotation.type === 'text') {
      // 旧持久化数据缺 vertical：补横排默认值，让数据形状统一（渲染处另有兜底）
      const vertical = annotation.vertical ?? false;
      if (annotation.text === '双击右侧修改文字') {
        return {
          ...annotation,
          text: '文字',
          fontSize: Math.min(annotation.fontSize, 20),
          width: Math.min(annotation.width, 0.22),
          height: Math.min(annotation.height, 0.1),
          vertical,
        };
      }
      return vertical === annotation.vertical ? annotation : { ...annotation, vertical };
    }

    return annotation;
  });
}

interface CollageStoreState {
  past: CollagePresentState[];
  future: CollagePresentState[];
  present: CollagePresentState;
  selectedSlotIndex: number | null;
  selectedAnnotationId: string | null;
  /** 重启后等待槽位照片回填期间为 true：画布对账暂停，避免清空持久化的槽位 */
  restorePending: boolean;
  /**
   * 连续手势（拖拽）的基线快照：手势开始时记录，结束时一次性写入历史。
   * null 表示当前没有进行中的手势。不持久化。
   */
  transientBase: CollagePresentState | null;
  commit: (updater: (draft: CollagePresentState) => void) => void;
  /** 开始一次连续手势：记录基线，之后的 `updateSlotTransient` 不进历史 */
  beginTransient: () => void;
  /**
   * 手势期间的临时更新：只改 present，不入历史、不做变更比对。
   * 供拖拽这类逐帧触发的路径使用——每一步都进历史会让撤销退化成「按像素撤销」。
   */
  updateSlotTransient: (index: number, patch: Partial<CollageSlotState>) => void;
  /** 结束手势：present 相对基线确有变化时，把基线作为一步历史入栈 */
  endTransient: () => void;
  undo: () => void;
  redo: () => void;
  selectSlot: (index: number | null) => void;
  selectAnnotation: (id: string | null) => void;
  /** 自适应：选中画布里的照片（格内取景的目标），与 Grid 槽位 / 标注选择互斥；不进历史、不持久化 */
  selectedAdaptivePhotoId: string | null;
  selectAdaptivePhoto: (photoId: string | null) => void;
  setLayout: (layoutId: string) => void;
  updateCanvas: (patch: Partial<CollageCanvasState>) => void;
  assignPhotoToSlot: (index: number, photoId: string) => void;
  clearSlot: (index: number) => void;
  swapSlots: (from: number, to: number) => void;
  updateSlot: (index: number, patch: Partial<CollageSlotState>) => void;
  resetSlot: (index: number) => void;
  removePhotoReferences: (photoId: string) => void;
  /**
   * 自适应布局：把新照片插到目标照片的指定方位。
   * `targetPhotoId` 为 null = 沿画布外沿整体插入一整行/一列（根节点分割），
   * 也是空画布放入第一张的入口。
   */
  insertAdaptivePhoto: (
    targetPhotoId: string | null,
    direction: AdaptiveInsertDirection,
    newPhotoId: string,
  ) => void;
  /** 自适应布局：中心区拖放，替换目标照片（树形不变） */
  replaceAdaptivePhoto: (targetPhotoId: string, newPhotoId: string) => void;
  /**
   * 自适应布局：写入分割线的手动比例（children[0] 占分割轴的份额）。
   * `ratio` 为 null = 移除手动值、恢复按照片比例自动推导（双击把手）。
   * 拖动手势配合 beginTransient / endTransient 合并为一步历史。
   */
  setAdaptiveSplitRatio: (path: number[], ratio: number | null) => void;
  /**
   * 自适应：写入叶子的格内取景（缩放 / 位移），`fit` 为 null = 重置恢复默认。
   * 位移需要格子与照片比例才能钳到位，由调用方（画布拖拽 / 属性面板）先钳再传；
   * 拖动手势配合 beginTransient / endTransient 合并为一步历史。
   */
  setAdaptivePhotoFit: (photoId: string, fit: AdaptivePhotoFit | null) => void;
  /** 自适应布局：移除照片，父节点自动塌缩 */
  removeAdaptivePhoto: (photoId: string) => void;
  /** 自适应布局：一键清空画布上的全部照片（只清画布，不删除任何文件） */
  clearAdaptiveCanvas: () => void;
  setRestorePending: (pending: boolean) => void;
  addAnnotation: (kind: CollageAnnotation['type']) => void;
  updateAnnotation: (id: string, patch: Partial<CollageAnnotation>) => void;
  removeAnnotation: (id: string) => void;
}

export const useCollageStore = create<CollageStoreState>()(
  persist(
    (set, get) => ({
      past: [],
      future: [],
      present: getDefaultPresentState(),
      selectedSlotIndex: null,
      selectedAnnotationId: null,
      selectedAdaptivePhotoId: null,
      restorePending: false,
      transientBase: null,
      commit: (updater) => {
        set((state) => {
          // 只克隆一份作为可变草稿：上一版直接复用 `state.present`，
          // 它在本 store 内从不被原地修改（所有写操作都先克隆再改），
          // 既能做变更比对，也能直接进历史栈，省掉每次提交的一半深克隆。
          const next = clonePresentState(state.present);
          updater(next);
          next.slotItems = normalizeSlots(next.layoutId, next.slotItems, next.canvas.layoutMode);
          next.annotations = normalizeAnnotations(next.annotations);

          if (JSON.stringify(state.present) === JSON.stringify(next)) {
            return state;
          }

          // 手势进行中：这一步与手势合并，不单独入栈——否则基线会晚于它入栈，
          // 历史顺序被颠倒；整段改动由 endTransient 一次性记作一步。
          if (state.transientBase !== null) {
            return {
              present: next,
              future: [],
            };
          }

          return {
            past: [...state.past.slice(-59), state.present],
            present: next,
            future: [],
          };
        });
      },
      beginTransient: () => {
        // 直接存引用、不克隆：present 在本 store 内只做不可变替换、从不原地修改，
        // 手势开始时的这份对象到结束时仍是原样，可以直接充当历史基线。
        set((state) => ({ transientBase: state.present }));
      },
      updateSlotTransient: (index, patch) => {
        set((state) => ({
          present: {
            ...state.present,
            slotItems: state.present.slotItems.map((item, slotIndex) =>
              slotIndex !== index ? item : { ...item, ...patch },
            ),
          },
        }));
      },
      endTransient: () => {
        const state = get();
        const base = state.transientBase;
        if (base === null) {
          return;
        }

        // 没动过（引用未变）或动了又复原：只清基线，不产生历史记录
        if (base === state.present || JSON.stringify(base) === JSON.stringify(state.present)) {
          set({ transientBase: null });
          return;
        }

        set({
          transientBase: null,
          past: [...state.past.slice(-59), base],
          future: [],
        });
      },
      undo: () => {
        set((state) => {
          const previous = state.past[state.past.length - 1];
          if (!previous) {
            return state;
          }

          return {
            past: state.past.slice(0, -1),
            present: previous,
            future: [clonePresentState(state.present), ...state.future].slice(0, 59),
            selectedSlotIndex: null,
            selectedAnnotationId: null,
            selectedAdaptivePhotoId: null,
            // 手势被历史操作打断：基线已过期，作废
            transientBase: null,
          };
        });
      },
      redo: () => {
        set((state) => {
          const next = state.future[0];
          if (!next) {
            return state;
          }

          return {
            past: [...state.past, clonePresentState(state.present)].slice(-59),
            present: next,
            future: state.future.slice(1),
            selectedSlotIndex: null,
            selectedAnnotationId: null,
            selectedAdaptivePhotoId: null,
            // 同 undo：打断进行中的手势时丢弃基线
            transientBase: null,
          };
        });
      },
      selectSlot: (index) => {
        set({
          selectedSlotIndex: index,
          selectedAnnotationId: null,
          selectedAdaptivePhotoId: null,
        });
      },
      selectAnnotation: (id) => {
        set({
          selectedSlotIndex: null,
          selectedAnnotationId: id,
          selectedAdaptivePhotoId: null,
        });
      },
      selectAdaptivePhoto: (photoId) => {
        set({
          selectedAdaptivePhotoId: photoId,
          selectedSlotIndex: null,
          selectedAnnotationId: null,
        });
      },
      setLayout: (layoutId) => {
        get().commit((draft) => {
          draft.layoutId = layoutId;
          draft.slotItems = normalizeSlots(layoutId, draft.slotItems, draft.canvas.layoutMode);
        });
        set((state) => ({
          selectedSlotIndex:
            state.selectedSlotIndex !== null &&
            state.selectedSlotIndex <
              normalizeSlots(layoutId, state.present.slotItems, state.present.canvas.layoutMode)
                .length
              ? state.selectedSlotIndex
              : null,
        }));
      },
      updateCanvas: (patch) => {
        let modeChanged = false;
        get().commit((draft) => {
          modeChanged =
            patch.layoutMode !== undefined && patch.layoutMode !== draft.canvas.layoutMode;
          draft.canvas = {
            ...draft.canvas,
            ...patch,
          };
          // 切换布局模式即清空自适应树：进入时从空画布手动摆（需求决定），
          // 离开时丢弃可避免残留树的照片在 grid 模式下被自动填充误收编。
          if (modeChanged) {
            draft.adaptiveTree = null;
          }
        });
        if (modeChanged) {
          set({
            selectedSlotIndex: null,
            selectedAnnotationId: null,
            selectedAdaptivePhotoId: null,
          });
        }
      },
      assignPhotoToSlot: (index, photoId) => {
        get().commit((draft) => {
          // 同一张图在画布里只保留一份：先清掉其它槽位对该图的引用，再落入目标槽位。
          // 否则「导入自动填充 + 手动拖放指定槽位」会短暂产生重复，且对账保留的是
          // 先出现的自动填充位，用户指定的目标槽位反而被清掉。
          draft.slotItems = draft.slotItems.map((item, slotIndex) =>
            slotIndex !== index && item.photoId === photoId ? createEmptySlotState() : item,
          );
          const next = draft.slotItems[index];
          // 换图时重置位移/缩放/旋转：这些调整是针对旧图构图的，
          // 直接套给新图会把图推出槽位可视区；同图重复赋值则保持调整。
          draft.slotItems[index] =
            next && next.photoId === photoId
              ? next
              : {
                  ...createEmptySlotState(),
                  photoId,
                };
        });
        set({
          selectedSlotIndex: index,
          selectedAnnotationId: null,
        });
      },
      clearSlot: (index) => {
        get().commit((draft) => {
          draft.slotItems[index] = createEmptySlotState();
        });
      },
      swapSlots: (from, to) => {
        if (from === to) {
          return;
        }

        get().commit((draft) => {
          const current = draft.slotItems[from];
          draft.slotItems[from] = draft.slotItems[to];
          draft.slotItems[to] = current;
        });
      },
      updateSlot: (index, patch) => {
        get().commit((draft) => {
          draft.slotItems[index] = {
            ...draft.slotItems[index],
            ...patch,
          };
        });
      },
      resetSlot: (index) => {
        get().commit((draft) => {
          draft.slotItems[index] = {
            ...createEmptySlotState(),
            photoId: draft.slotItems[index]?.photoId ?? null,
          };
        });
      },
      removePhotoReferences: (photoId) => {
        get().commit((draft) => {
          draft.slotItems = draft.slotItems.map((item) =>
            item.photoId === photoId
              ? {
                  ...createEmptySlotState(),
                }
              : item,
          );
          if (draft.adaptiveTree) {
            draft.adaptiveTree = removeAdaptivePhoto(draft.adaptiveTree, photoId);
          }
        });
        if (get().selectedAdaptivePhotoId === photoId) {
          set({ selectedAdaptivePhotoId: null });
        }
      },
      insertAdaptivePhoto: (targetPhotoId, direction, newPhotoId) => {
        const tree = get().present.adaptiveTree;
        if (tree && hasAdaptivePhoto(tree, newPhotoId)) {
          return;
        }
        get().commit((draft) => {
          // null 目标 = 画布外沿拖放：根节点分割，新照片占一整行/一列
          draft.adaptiveTree =
            targetPhotoId === null
              ? insertAdaptiveRoot(draft.adaptiveTree, direction, newPhotoId)
              : insertAdaptivePhoto(draft.adaptiveTree, targetPhotoId, direction, newPhotoId);
        });
      },
      replaceAdaptivePhoto: (targetPhotoId, newPhotoId) => {
        get().commit((draft) => {
          draft.adaptiveTree = replaceAdaptivePhoto(draft.adaptiveTree, targetPhotoId, newPhotoId);
        });
        // 目标照片已被换掉：旧的选中态与取景一并失效
        if (get().selectedAdaptivePhotoId === targetPhotoId) {
          set({ selectedAdaptivePhotoId: null });
        }
      },
      setAdaptiveSplitRatio: (path, ratio) => {
        get().commit((draft) => {
          draft.adaptiveTree = setAdaptiveSplitRatio(draft.adaptiveTree, path, ratio);
        });
      },
      setAdaptivePhotoFit: (photoId, fit) => {
        get().commit((draft) => {
          draft.adaptiveTree = setAdaptivePhotoFit(draft.adaptiveTree, photoId, fit);
        });
      },
      removeAdaptivePhoto: (photoId) => {
        get().commit((draft) => {
          draft.adaptiveTree = removeAdaptivePhoto(draft.adaptiveTree, photoId);
        });
        // 被移除的照片还处于选中态则一并清掉，避免面板指向不存在的叶子
        if (get().selectedAdaptivePhotoId === photoId) {
          set({ selectedAdaptivePhotoId: null });
        }
      },
      clearAdaptiveCanvas: () => {
        get().commit((draft) => {
          draft.adaptiveTree = null;
        });
        set({ selectedAdaptivePhotoId: null });
      },
      // 文件夹直览状态（当前文件夹 / 最近使用 / 隐藏条目）已上提到全局
      // `useFileSourceStore`：文件来源是应用级能力，不再属于拼图。
      setRestorePending: (pending) => {
        set({ restorePending: pending });
      },
      addAnnotation: (kind) => {
        const annotation = createAnnotation(kind);
        get().commit((draft) => {
          draft.annotations.push(annotation);
        });
        set({
          selectedAnnotationId: annotation.id,
          selectedSlotIndex: null,
          selectedAdaptivePhotoId: null,
        });
      },
      updateAnnotation: (id, patch) => {
        get().commit((draft) => {
          draft.annotations = draft.annotations.map((item) =>
            item.id !== id
              ? item
              : item.type === 'text'
                ? {
                    ...item,
                    ...(patch as Partial<typeof item>),
                  }
                : item.type === 'arrow'
                  ? {
                      ...item,
                      ...(patch as Partial<typeof item>),
                    }
                  : {
                      ...item,
                      ...(patch as Partial<typeof item>),
                    },
          );
        });
      },
      removeAnnotation: (id) => {
        get().commit((draft) => {
          draft.annotations = draft.annotations.filter((item) => item.id !== id);
        });
        set((state) => ({
          selectedAnnotationId:
            state.selectedAnnotationId === id ? null : state.selectedAnnotationId,
        }));
      },
    }),
    {
      name: 'copicseal-collage-state',
      // 逐帧更新（拖拽、滑杆连打）会高频触发持久化，改走合并写入的存储
      storage: createJSONStorage(() => coalescedLocalStorage),
      partialize: (state) => ({
        present: state.present,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as
          | (Partial<CollageStoreState> & {
              /** 旧版拼图状态里的文件夹字段：已迁往全局文件来源，读取后直接丢弃 */
              folderPath?: string | null;
              recentFolders?: string[];
            })
          | undefined;
        if (!persisted?.present) {
          return currentState;
        }

        const restPersisted = { ...persisted };
        // 旧版拼图状态里的文件夹字段迁到全局 `useFileSourceStore`（见该文件的首次迁移），
        // 这里直接丢弃，避免旧键残留进拼图状态
        delete restPersisted.folderPath;
        delete restPersisted.recentFolders;

        // 持久化的槽位引用着上次会话的直览照片（id = 文件路径）：
        // 先挂起画布对账，等这些路径懒导入回填完成后再放行，否则会把槽位清空。
        const hasSlotPhotos = persisted.present.slotItems?.some((item) => item.photoId) ?? false;
        const hasAdaptivePhotos =
          collectAdaptivePhotoIds(persisted.present.adaptiveTree ?? null).length > 0;

        // 旧版画布状态里的导出设置已迁往全局导出预设（`useExportPresetStore`），读取后直接丢弃
        const nextPresent = {
          ...currentState.present,
          ...persisted.present,
          slotItems: normalizeSlots(
            persisted.present.layoutId ?? currentState.present.layoutId,
            persisted.present.slotItems ?? currentState.present.slotItems,
            persisted.present.canvas?.layoutMode ?? currentState.present.canvas.layoutMode,
          ),
          annotations: normalizeAnnotations(
            persisted.present.annotations ?? currentState.present.annotations,
          ),
        };
        delete (nextPresent as Record<string, unknown>).exportSettings;

        return {
          ...currentState,
          ...restPersisted,
          present: nextPresent,
          restorePending: hasSlotPhotos || hasAdaptivePhotos,
        };
      },
    },
  ),
);
