import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { coalescedLocalStorage } from '@/shared/lib/coalesced-storage';
import {
  createExportPresetId,
  createExportPresetProfile,
  nextExportPresetName,
} from '@/shared/lib/export-preset-profile';
import type { ExportPresetProfile } from '@/shared/types/export';

/** 预设列表的持久化键 */
const STORAGE_KEY = 'copicseal-export-presets';

interface ExportPresetStoreState {
  /**
   * 全局共享的导出预设：两页共用一份，持久化，重启后恢复。
   *
   * 首启种子一个「默认预设」（id 固定为 default）；全部删光后保持为空，
   * 面板显示空态引导新建。
   */
  presets: ExportPresetProfile[];
  /** 新建预设；同 id 已存在时视为编辑保存 */
  upsertPreset: (profile: ExportPresetProfile) => void;
  removePreset: (id: string) => void;
  /** 复制预设：紧跟在源预设之后插入，名字自动顺延 */
  duplicatePreset: (id: string) => void;
}

export const useExportPresetStore = create<ExportPresetStoreState>()(
  persist(
    (set) => ({
      // 首启种子：id 固定，保证升级到该版本的用户开箱就有一个可用预设
      presets: [{ ...createExportPresetProfile('default'), name: '默认预设' }],

      upsertPreset: (profile) =>
        set((state) => ({
          presets: state.presets.some((item) => item.id === profile.id)
            ? state.presets.map((item) => (item.id === profile.id ? profile : item))
            : [...state.presets, profile],
        })),

      removePreset: (id) =>
        set((state) => ({ presets: state.presets.filter((item) => item.id !== id) })),

      duplicatePreset: (id) =>
        set((state) => {
          const index = state.presets.findIndex((item) => item.id === id);
          if (index < 0) {
            return state;
          }

          const copy: ExportPresetProfile = {
            ...structuredClone(state.presets[index]),
            id: createExportPresetId(),
            name: nextExportPresetName(state.presets),
          };
          const presets = [...state.presets];
          presets.splice(index + 1, 0, copy);
          return { presets };
        }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => coalescedLocalStorage),
      // 只持久化预设列表
      partialize: (state) => ({ presets: state.presets }),
    },
  ),
);
