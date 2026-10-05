import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { pathExists, platform } from '@/platform';
import type { FolderImageFile } from '@/platform/contracts';
import { coalescedLocalStorage } from '@/shared/lib/coalesced-storage';

/** 本状态的持久化键 */
const STORAGE_KEY = 'copicseal-file-source-state';
/** 拼图页直览状态的旧持久化键，仅用于把已选文件夹迁移到全局文件来源 */
const LEGACY_STORAGE_KEY = 'copicseal-collage-state';

/** 当前文件夹的枚举进度：内容面板与筛选器共用同一份条目数据。 */
export type EntriesStatus = 'idle' | 'checking' | 'ready' | 'invalid';

/**
 * 目录枚举请求的代际序号：快速切换文件夹时用它丢弃过期响应，
 * 避免慢的那个请求后到、覆盖掉新文件夹的条目。模块级即可——同一时刻只有一份
 * 「当前目录」，两个功能页共用同一个 store 实例。
 */
let entriesRequest = 0;

interface FileSourceStoreState {
  /** 当前直览的文件夹；持久化用于会话恢复 */
  folderPath: string | null;
  /** 收藏的文件夹（新→旧），供收藏夹面板展示；只收藏文件夹，不收藏文件；持久化 */
  favoriteFolders: string[];
  /** 本次会话从直览列表「移除」的路径（仅隐藏，不删文件）；不持久化 */
  removedPaths: string[];
  /** 当前文件夹的图片条目（不复制原文件）；内容面板与筛选器的共同数据源 */
  entries: FolderImageFile[];
  /** 条目枚举进度 */
  entriesStatus: EntriesStatus;
  openFolder: (path: string) => void;
  /** 收藏 / 取消收藏一个文件夹（按路径去重） */
  toggleFavoriteFolder: (path: string) => void;
  hideEntry: (path: string) => void;
  /** 枚举指定文件夹的图片条目（幂等：传 null 清空并回到 idle） */
  loadEntries: (path: string | null) => Promise<void>;
}

interface LegacyCollagePersistedState {
  state?: {
    folderPath?: string | null;
  };
}

/** 持久化载荷形状（面板布局已迁出到 `useWorkbenchDockStore`） */
interface FileSourcePersistedState {
  folderPath?: string | null;
  favoriteFolders?: string[];
}

/**
 * 首次迁移：新键不存在时，从拼图页的旧持久化里继承上次打开的文件夹。
 *
 * 文件来源由「只属于拼图」提升为全局通用，老用户上次选中的文件夹不应丢失；
 * 迁移只读一次，之后一律以新键为准。
 */
function readLegacyFolderState(): string | null {
  try {
    if (window.localStorage.getItem(STORAGE_KEY) !== null) {
      return null;
    }
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as LegacyCollagePersistedState;
    return parsed.state?.folderPath ?? null;
  } catch (error) {
    console.warn('[file-source] 读取历史文件夹失败:', error);
    return null;
  }
}

const legacyFolderPath = readLegacyFolderState();

export const useFileSourceStore = create<FileSourceStoreState>()(
  persist(
    (set, get) => ({
      folderPath: legacyFolderPath,
      favoriteFolders: [],
      removedPaths: [],
      entries: [],
      entriesStatus: 'idle',
      openFolder: (path) => {
        set({
          folderPath: path,
          // 换文件夹 = 换一批列表条目，「移除」隐藏集合随之失效
          removedPaths: [],
        });
        void get().loadEntries(path);
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
      loadEntries: async (path) => {
        entriesRequest += 1;
        const request = entriesRequest;
        if (!path) {
          set({ entries: [], entriesStatus: 'idle' });
          return;
        }

        // 切换中先亮进度态；旧条目保留到新数据到达，避免面板闪空
        set({ entriesStatus: 'checking' });
        try {
          const exists = await pathExists(path);
          if (request !== entriesRequest) {
            return;
          }
          if (!exists) {
            // 路径失效：不伪造目录内容，交给空态提示重新选择
            set({ entries: [], entriesStatus: 'invalid' });
            return;
          }

          const images = await platform.files.listFolderImages(path);
          if (request !== entriesRequest) {
            return;
          }
          set({ entries: images, entriesStatus: 'ready' });
        } catch (error) {
          console.warn('[file-source] 枚举文件夹失败:', path, error);
          if (request === entriesRequest) {
            set({ entriesStatus: 'invalid' });
          }
        }
      },
    }),
    {
      name: STORAGE_KEY,
      // 与其余持久化 store 共用合并写入的存储（见 `coalesced-storage`）
      storage: createJSONStorage(() => coalescedLocalStorage),
      partialize: (state) => ({
        folderPath: state.folderPath,
        favoriteFolders: state.favoriteFolders,
      }),
      // 逐字段合并：不把旧字段（历史折叠开关等）原样灌进状态树
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as FileSourcePersistedState;
        return {
          ...currentState,
          folderPath: persisted.folderPath ?? currentState.folderPath,
          favoriteFolders: persisted.favoriteFolders ?? currentState.favoriteFolders,
        };
      },
    },
  ),
);

// 会话恢复的文件夹在启动时补一次枚举：store 创建阶段拿不到异步结果，
// 又没有组件会在挂载时主动加载（内容面板只消费数据）
const restoredFolder = useFileSourceStore.getState().folderPath;
if (restoredFolder) {
  void useFileSourceStore.getState().loadEntries(restoredFolder);
}
