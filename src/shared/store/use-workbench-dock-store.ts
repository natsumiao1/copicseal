import type { DockviewApi, SerializedDockview } from 'dockview-react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { AppRoute } from '@/app/routes';
import { coalescedLocalStorage } from '@/shared/lib/coalesced-storage';

/** 停靠布局的持久化键 */
const STORAGE_KEY = 'copicseal-dock-layout';

interface WorkbenchDockState {
  /**
   * 两个功能页共用的 dockview 停靠布局；持久化，重启后恢复。
   *
   * `null` 表示尚未初始化（首次启动），由第一个挂载的工作台按默认布局
   * 构建后回写；之后任何一页的布局改动都写回这里，再同步给另一页。
   */
  layout: SerializedDockview | null;
  /**
   * 「收藏夹」tab 是否已随布局初始化过。
   *
   * 该功能上线前保存的布局里没有它，工作台首次加载时补挂进文件夹组一次；
   * 补过之后一律以布局为准——用户手动关闭或移走它，重启后保持原样。
   */
  favoritesSeeded: boolean;
  /**
   * 「筛选器」面板是否已随布局初始化过（同 `favoritesSeeded`，补挂到文件夹栏下方）。
   */
  filterSeeded: boolean;
  /**
   * 「导出」面板是否已随布局初始化过（同 `favoritesSeeded`，补挂到调整面板下方）。
   */
  exportSeeded: boolean;
  /** 各功能页工作台的 dockview 实例（不持久化）；顶栏「视图」菜单按当前路由取用 */
  apis: Partial<Record<AppRoute, DockviewApi>>;
  setLayout: (layout: SerializedDockview) => void;
  /** 标记收藏夹 tab 已并入布局（见 `favoritesSeeded`） */
  markFavoritesSeeded: () => void;
  /** 标记筛选器面板已并入布局（见 `filterSeeded`） */
  markFilterSeeded: () => void;
  /** 标记导出面板已并入布局（见 `exportSeeded`） */
  markExportSeeded: () => void;
  /** 注册 / 注销本页的 dockview 实例（传 null 注销） */
  registerApi: (route: AppRoute, api: DockviewApi | null) => void;
}

export const useWorkbenchDockStore = create<WorkbenchDockState>()(
  persist(
    (set) => ({
      layout: null,
      favoritesSeeded: false,
      filterSeeded: false,
      exportSeeded: false,
      apis: {},
      setLayout: (layout) => set({ layout }),
      markFavoritesSeeded: () => set({ favoritesSeeded: true }),
      markFilterSeeded: () => set({ filterSeeded: true }),
      markExportSeeded: () => set({ exportSeeded: true }),
      registerApi: (route, api) =>
        set((state) => ({ apis: { ...state.apis, [route]: api ?? undefined } })),
    }),
    {
      name: STORAGE_KEY,
      // 拖动面板宽度 / 位置同样是逐帧更新，走合并写入的存储
      storage: createJSONStorage(() => coalescedLocalStorage),
      // 只持久化布局与补挂标记；dockview 实例是运行时对象，重启即失效
      partialize: (state) => ({
        layout: state.layout,
        favoritesSeeded: state.favoritesSeeded,
        filterSeeded: state.filterSeeded,
        exportSeeded: state.exportSeeded,
      }),
    },
  ),
);
