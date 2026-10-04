import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  collectAdaptivePhotoIds,
  hasAdaptivePhoto,
  insertAdaptivePhoto,
  insertAdaptiveRoot,
  removeAdaptivePhoto,
  replaceAdaptivePhoto,
} from '../adaptive';
import { COLLAGE_LAYOUTS } from '../layouts';
import { createAnnotation, createEmptySlotState, getDefaultCanvasState } from '../lib';
import type {
  AdaptiveInsertDirection,
  CollageAnnotation,
  CollageCanvasState,
  CollageExportState,
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
    exportSettings: {
      format: 'png',
      quality: 'high',
    },
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
    if (annotation.type === 'text' && annotation.text === '双击右侧修改文字') {
      return {
        ...annotation,
        text: '文字',
        fontSize: Math.min(annotation.fontSize, 20),
        width: Math.min(annotation.width, 0.22),
        height: Math.min(annotation.height, 0.1),
      };
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
  /** 当前打开的直览文件夹；持久化用于会话恢复 */
  folderPath: string | null;
  /** 最近打开的文件夹（新→旧），供文件夹树根节点展示；持久化 */
  recentFolders: string[];
  /** 本次会话从直览列表「移除」的路径（仅隐藏，不删文件）；不持久化 */
  removedPaths: string[];
  /** 重启后等待槽位照片回填期间为 true：画布对账暂停，避免清空持久化的槽位 */
  restorePending: boolean;
  commit: (updater: (draft: CollagePresentState) => void) => void;
  undo: () => void;
  redo: () => void;
  selectSlot: (index: number | null) => void;
  selectAnnotation: (id: string | null) => void;
  setLayout: (layoutId: string) => void;
  updateCanvas: (patch: Partial<CollageCanvasState>) => void;
  updateExportSettings: (patch: Partial<CollageExportState>) => void;
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
  /** 自适应布局：移除照片，父节点自动塌缩 */
  removeAdaptivePhoto: (photoId: string) => void;
  /** 自适应布局：一键清空画布上的全部照片（只清画布，不删除任何文件） */
  clearAdaptiveCanvas: () => void;
  openFolder: (path: string) => void;
  hideEntry: (path: string) => void;
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
      folderPath: null,
      recentFolders: [],
      removedPaths: [],
      restorePending: false,
      commit: (updater) => {
        set((state) => {
          const previous = clonePresentState(state.present);
          const next = clonePresentState(state.present);
          updater(next);
          next.slotItems = normalizeSlots(next.layoutId, next.slotItems, next.canvas.layoutMode);
          next.annotations = normalizeAnnotations(next.annotations);

          if (JSON.stringify(previous) === JSON.stringify(next)) {
            return state;
          }

          return {
            past: [...state.past.slice(-59), previous],
            present: next,
            future: [],
          };
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
          };
        });
      },
      selectSlot: (index) => {
        set({
          selectedSlotIndex: index,
          selectedAnnotationId: null,
        });
      },
      selectAnnotation: (id) => {
        set({
          selectedSlotIndex: null,
          selectedAnnotationId: id,
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
          set({ selectedSlotIndex: null, selectedAnnotationId: null });
        }
      },
      updateExportSettings: (patch) => {
        get().commit((draft) => {
          draft.exportSettings = {
            ...draft.exportSettings,
            ...patch,
          };
        });
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
      },
      removeAdaptivePhoto: (photoId) => {
        get().commit((draft) => {
          draft.adaptiveTree = removeAdaptivePhoto(draft.adaptiveTree, photoId);
        });
      },
      clearAdaptiveCanvas: () => {
        get().commit((draft) => {
          draft.adaptiveTree = null;
        });
      },
      openFolder: (path) => {
        set((state) => ({
          folderPath: path,
          // 换文件夹 = 换一批列表条目，「移除」隐藏集合随之失效
          removedPaths: [],
          recentFolders: [path, ...state.recentFolders.filter((item) => item !== path)].slice(
            0,
            10,
          ),
        }));
      },
      hideEntry: (path) => {
        set((state) =>
          state.removedPaths.includes(path)
            ? state
            : { removedPaths: [...state.removedPaths, path] },
        );
      },
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
      partialize: (state) => ({
        present: state.present,
        folderPath: state.folderPath,
        recentFolders: state.recentFolders,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<CollageStoreState> | undefined;
        if (!persisted?.present) {
          return currentState;
        }

        // 持久化的槽位引用着上次会话的直览照片（id = 文件路径）：
        // 先挂起画布对账，等这些路径懒导入回填完成后再放行，否则会把槽位清空。
        const hasSlotPhotos = persisted.present.slotItems?.some((item) => item.photoId) ?? false;
        const hasAdaptivePhotos =
          collectAdaptivePhotoIds(persisted.present.adaptiveTree ?? null).length > 0;

        return {
          ...currentState,
          ...persisted,
          present: {
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
          },
          folderPath: persisted.folderPath ?? null,
          recentFolders: Array.isArray(persisted.recentFolders) ? persisted.recentFolders : [],
          restorePending: hasSlotPhotos || hasAdaptivePhotos,
        };
      },
    },
  ),
);
