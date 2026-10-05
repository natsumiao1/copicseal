import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { platform } from '@/platform';
import type { ImageTags } from '@/platform/contracts';
import { coalescedLocalStorage } from '@/shared/lib/coalesced-storage';
import type { ColorLabel, FilterCriteria } from '@/shared/lib/image-filter';

/** 本状态的持久化键 */
const STORAGE_KEY = 'copicseal-filter-state';

/** 标签读取进度：`loading` 期间标签维度的条件暂不生效（见 `resolveCriteria`）。 */
export type TagsStatus = 'idle' | 'loading' | 'ready';

/** 筛选器面板的四个条件区，用于折叠状态。 */
export type FilterSectionKey = 'rating' | 'label' | 'ratio' | 'type';

interface FilterStoreState extends FilterCriteria {
  /** 当前文件夹的标签数据（path → XMP 星级 / 颜色标签）；不持久化 */
  tags: Record<string, ImageTags>;
  tagsStatus: TagsStatus;
  /** `tags` 对应的目录；与当前目录不一致时视为未就绪 */
  tagsFolder: string | null;
  /** 已折叠的条件区（`FilterSectionKey` 列表）；持久化 */
  collapsedSections: FilterSectionKey[];
  toggleRating: (rating: number) => void;
  toggleLabel: (label: ColorLabel) => void;
  toggleType: (type: string) => void;
  toggleRatio: (ratio: string) => void;
  /** 折叠 / 展开一个条件区 */
  toggleCollapsedSection: (section: FilterSectionKey) => void;
  /** 清空全部筛选条件（不清标签缓存与折叠状态） */
  clearCriteria: () => void;
  /** 为指定目录批量读取 XMP 标签；同目录已读过则跳过 */
  loadTags: (paths: string[], folder: string) => Promise<void>;
}

interface FilterPersistedState {
  ratings?: number[];
  labels?: ColorLabel[];
  types?: string[];
  ratios?: string[];
  collapsedSections?: FilterSectionKey[];
}

/** 按项切换选中集合的通用逻辑（已选则移除，未选则加入）。 */
function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item];
}

export const useFilterStore = create<FilterStoreState>()(
  persist(
    (set, get) => ({
      ratings: [],
      labels: [],
      types: [],
      ratios: [],
      collapsedSections: [],
      tags: {},
      tagsStatus: 'idle',
      tagsFolder: null,
      toggleRating: (rating) => set((state) => ({ ratings: toggle(state.ratings, rating) })),
      toggleLabel: (label) => set((state) => ({ labels: toggle(state.labels, label) })),
      toggleType: (type) => set((state) => ({ types: toggle(state.types, type) })),
      toggleRatio: (ratio) => set((state) => ({ ratios: toggle(state.ratios, ratio) })),
      toggleCollapsedSection: (section) =>
        set((state) => ({ collapsedSections: toggle(state.collapsedSections, section) })),
      clearCriteria: () => set({ ratings: [], labels: [], types: [], ratios: [] }),
      loadTags: async (paths, folder) => {
        const state = get();
        if (state.tagsFolder === folder && state.tagsStatus !== 'idle') {
          return; // 本目录已读取或读取中
        }
        set({ tags: {}, tagsFolder: folder, tagsStatus: 'loading' });
        try {
          const result = await platform.files.readImageTags(paths);
          if (get().tagsFolder !== folder) {
            return; // 读取期间已切换目录，丢弃过期结果
          }
          const tags: Record<string, ImageTags> = {};
          for (const item of result) {
            tags[item.path] = item;
          }
          set({ tags, tagsStatus: 'ready' });
        } catch (error) {
          console.warn('[filter] 读取图片标签失败:', error);
          if (get().tagsFolder === folder) {
            // 失败按「全部无标签」处理：保持条件生效语义，筛选结果为 0
            set({ tags: {}, tagsStatus: 'ready' });
          }
        }
      },
    }),
    {
      name: STORAGE_KEY,
      // 与其余持久化 store 共用合并写入的存储（见 `coalesced-storage`）
      storage: createJSONStorage(() => coalescedLocalStorage),
      // 只持久化筛选条件与各区折叠状态；标签数据是按目录读出来的派生结果
      partialize: (state) => ({
        ratings: state.ratings,
        labels: state.labels,
        types: state.types,
        ratios: state.ratios,
        collapsedSections: state.collapsedSections,
      }),
      // 逐字段合并：容忍旧版本缺字段
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as FilterPersistedState;
        return {
          ...currentState,
          ratings: persisted.ratings ?? currentState.ratings,
          labels: persisted.labels ?? currentState.labels,
          types: persisted.types ?? currentState.types,
          ratios: persisted.ratios ?? currentState.ratios,
          collapsedSections: persisted.collapsedSections ?? currentState.collapsedSections,
        };
      },
    },
  ),
);
