import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { COLLAGE_LAYOUTS } from '../layouts';
import { createAnnotation, createEmptySlotState, getDefaultCanvasState } from '../lib';
import type {
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
        get().commit((draft) => {
          draft.canvas = {
            ...draft.canvas,
            ...patch,
          };
        });
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
          draft.slotItems[index] = {
            ...draft.slotItems[index],
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
        });
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
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<CollageStoreState> | undefined;
        if (!persisted?.present) {
          return currentState;
        }

        return {
          ...currentState,
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
        };
      },
    },
  ),
);
