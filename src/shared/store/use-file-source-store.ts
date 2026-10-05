import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { coalescedLocalStorage } from '@/shared/lib/coalesced-storage';

/** 本状态的持久化键 */
const STORAGE_KEY = 'copicseal-file-source-state';
/** 拼图页直览状态的旧持久化键，仅用于把已选文件夹迁移到全局文件来源 */
const LEGACY_STORAGE_KEY = 'copicseal-collage-state';

interface FileSourceStoreState {
  /** 当前直览的文件夹；持久化用于会话恢复 */
  folderPath: string | null;
  /** 最近打开的文件夹（新→旧），供文件夹树「最近使用」节点展示；持久化 */
  recentFolders: string[];
  /** 收藏的文件夹（新→旧），供收藏夹面板展示；只收藏文件夹，不收藏文件；持久化 */
  favoriteFolders: string[];
  /** 本次会话从直览列表「移除」的路径（仅隐藏，不删文件）；不持久化 */
  removedPaths: string[];
  openFolder: (path: string) => void;
  /** 收藏 / 取消收藏一个文件夹（按路径去重） */
  toggleFavoriteFolder: (path: string) => void;
  hideEntry: (path: string) => void;
}

interface LegacyCollagePersistedState {
  state?: {
    folderPath?: string | null;
    recentFolders?: string[];
  };
}

/** 持久化载荷形状（面板布局已迁出到 `useWorkbenchDockStore`） */
interface FileSourcePersistedState {
  folderPath?: string | null;
  recentFolders?: string[];
  favoriteFolders?: string[];
}

/**
 * 首次迁移：新键不存在时，从拼图页的旧持久化里继承上次打开的文件夹。
 *
 * 文件来源由「只属于拼图」提升为全局通用，老用户上次选中的文件夹不应丢失；
 * 迁移只读一次，之后一律以新键为准。
 */
function readLegacyFolderState(): Pick<FileSourceStoreState, 'folderPath' | 'recentFolders'> {
  try {
    if (window.localStorage.getItem(STORAGE_KEY) !== null) {
      return { folderPath: null, recentFolders: [] };
    }
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return { folderPath: null, recentFolders: [] };
    }
    const parsed = JSON.parse(raw) as LegacyCollagePersistedState;
    return {
      folderPath: parsed.state?.folderPath ?? null,
      recentFolders: Array.isArray(parsed.state?.recentFolders) ? parsed.state.recentFolders : [],
    };
  } catch (error) {
    console.warn('[file-source] 读取历史文件夹失败:', error);
    return { folderPath: null, recentFolders: [] };
  }
}

const legacyFolderState = readLegacyFolderState();

export const useFileSourceStore = create<FileSourceStoreState>()(
  persist(
    (set) => ({
      folderPath: legacyFolderState.folderPath,
      recentFolders: legacyFolderState.recentFolders,
      favoriteFolders: [],
      removedPaths: [],
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
      toggleFavoriteFolder: (path) => {
        set((state) => ({
          favoriteFolders: state.favoriteFolders.includes(path)
            ? state.favoriteFolders.filter((item) => item !== path)
            : [path, ...state.favoriteFolders],
        }));
      },
      hideEntry: (path) => {
        set((state) =>
          state.removedPaths.includes(path)
            ? state
            : { removedPaths: [...state.removedPaths, path] },
        );
      },
    }),
    {
      name: STORAGE_KEY,
      // 与其余持久化 store 共用合并写入的存储（见 `coalesced-storage`）
      storage: createJSONStorage(() => coalescedLocalStorage),
      partialize: (state) => ({
        folderPath: state.folderPath,
        recentFolders: state.recentFolders,
        favoriteFolders: state.favoriteFolders,
      }),
      // 逐字段合并：不把旧字段（历史折叠开关等）原样灌进状态树
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as FileSourcePersistedState;
        return {
          ...currentState,
          folderPath: persisted.folderPath ?? currentState.folderPath,
          recentFolders: persisted.recentFolders ?? currentState.recentFolders,
          favoriteFolders: persisted.favoriteFolders ?? currentState.favoriteFolders,
        };
      },
    },
  ),
);
