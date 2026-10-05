import type {
  DockviewApi,
  DockviewReadyEvent,
  DockviewTheme,
  SerializedDockview,
} from 'dockview-react';
import { DockviewReact, themeLight } from 'dockview-react';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import type { AppRoute } from '@/app/routes';
import { useWorkbenchDockStore } from '@/shared/store/use-workbench-dock-store';
import 'dockview-react/dist/styles/dockview.css';
import './business-workbench.css';

/**
 * 工作台的五个停靠面板：文件夹 / 收藏夹 / 内容 / 预览区 / 调整区。
 *
 * 每个面板都是一个矩形区域，顶部带 tab 条；面板之间可以拖动换位、四向分割，
 * 拖到另一个面板中心则合并成同组的两个 tab。默认布局里「收藏夹」与「文件夹」
 * 同组，即第一栏的两个 tab。布局整体持久化（见 `useWorkbenchDockStore`），
 * 关闭的面板从顶栏「视图」菜单恢复。
 */
export const WORKBENCH_PANELS = {
  folder: { title: '文件夹', minimumWidth: 140, defaultRatio: 0.15 },
  favorites: { title: '收藏夹', minimumWidth: 140, defaultRatio: 0.15 },
  content: { title: '内容', minimumWidth: 170, defaultRatio: 0.2 },
  workspace: { title: '预览区', minimumWidth: 240, defaultRatio: 0.45 },
  properties: { title: '调整区', minimumWidth: 180, defaultRatio: 0.2 },
} as const satisfies Record<string, { title: string; minimumWidth: number; defaultRatio: number }>;

export type WorkbenchPanelId = keyof typeof WORKBENCH_PANELS;

export const WORKBENCH_PANEL_IDS = Object.keys(WORKBENCH_PANELS) as WorkbenchPanelId[];

/**
 * 默认布局的一行四栏叶子（从左到右）；「收藏夹」并入「文件夹」组，不单独占栏。
 *
 * 校正默认比例时按这份清单核对叶子数——直接用 `WORKBENCH_PANEL_IDS` 会因为
 * 同组多出的 tab 数量不符而整段跳过。
 */
const DEFAULT_LAYOUT_LEAVES: readonly WorkbenchPanelId[] = [
  'folder',
  'content',
  'workspace',
  'properties',
];

/** dockview 主题：在内置 light 主题上开 4px 面板缝隙，样式变量见 `business-workbench.css`。 */
const WORKBENCH_THEME: DockviewTheme = {
  ...themeLight,
  name: 'copicseal',
  className: 'dockview-theme-light co-dockview',
  gap: 4,
};

/** 各功能页提供给工作台的面板内容。 */
export interface BusinessWorkbenchPanels {
  /** 文件夹树（全局文件来源注入） */
  folder: ReactNode;
  /** 收藏的文件夹列表（全局文件来源注入） */
  favorites: ReactNode;
  /** 内容直览（全局文件来源注入） */
  content: ReactNode;
  /** 页面的预览工作区 */
  workspace: ReactNode;
  /** 页面的属性面板；懒求值，内容随选中项变化 */
  properties: () => ReactNode;
}

export interface BusinessWorkbenchProps {
  /** 页头（功能工具条），固定在停靠区上方，不参与停靠 */
  header: ReactNode;
  /** 本页身份：顶栏「视图」菜单按路由取本页的 dockview 实例 */
  routeKey: AppRoute;
  panels: BusinessWorkbenchPanels;
}

const WorkbenchPanelsContext = createContext<BusinessWorkbenchPanels | null>(null);

/**
 * 面板内容渲染器工厂。
 *
 * dockview 在建面板时捕获一次组件引用，之后 `components` 表变了也不会更新已有面板，
 * 所以这里用稳定的模块级组件 + Context 读取最新插槽：页面改 props 时 Context 变化，
 * 面板通过 portal 照常重渲染。
 */
function createPanelContent(render: (panels: BusinessWorkbenchPanels) => ReactNode) {
  function PanelContent() {
    const panels = useContext(WorkbenchPanelsContext);
    return (
      <div className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden">
        {panels ? render(panels) : null}
      </div>
    );
  }
  PanelContent.displayName = 'WorkbenchPanelContent';
  return PanelContent;
}

const PANEL_COMPONENTS: Record<WorkbenchPanelId, ReturnType<typeof createPanelContent>> = {
  folder: createPanelContent((panels) => panels.folder),
  favorites: createPanelContent((panels) => panels.favorites),
  content: createPanelContent((panels) => panels.content),
  workspace: createPanelContent((panels) => panels.workspace),
  properties: createPanelContent((panels) => panels.properties()),
};

/**
 * 运行时校验持久化的布局形状：结构完好，面板 id 与组件名都在当前面板清单之内，
 * 且网格引用的每个 view 都能在面板注册表里找到。
 *
 * localStorage 里的内容可能来自旧版本或被手动改坏：组件名缺失时 dockview 会回落成
 * `"unknown"` 渲染出空组件直接崩，网格引用游离 view 也会让反序列化失败，
 * 所以先挡一道，不合格就回退默认布局。
 */
function isUsableLayout(value: unknown): value is SerializedDockview {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const layout = value as SerializedDockview;
  if (!layout.grid?.root || !layout.panels || typeof layout.panels !== 'object') {
    return false;
  }
  const known = new Set<string>(WORKBENCH_PANEL_IDS);
  const entries = Object.entries(layout.panels);
  if (!entries.every(([id, panel]) => known.has(id) && known.has(panel.contentComponent ?? ''))) {
    return false;
  }
  type LayoutNode = SerializedDockview['grid']['root'];
  const walk = (node: LayoutNode | undefined): boolean => {
    if (!node || typeof node !== 'object') {
      return false;
    }
    if (node.type === 'branch') {
      return Array.isArray(node.data) && node.data.every(walk);
    }
    if (Array.isArray(node.data) || !Array.isArray(node.data?.views)) {
      return false;
    }
    return node.data.views.every((viewId) => layout.panels[viewId] !== undefined);
  };
  return walk(layout.grid.root);
}

/** 默认布局的构建顺序：一行四栏，从左到右；首栏是文件夹 + 收藏夹两个 tab。 */
function buildDefaultLayout(api: DockviewApi) {
  api.addPanel({
    id: 'folder',
    component: 'folder',
    title: WORKBENCH_PANELS.folder.title,
    minimumWidth: WORKBENCH_PANELS.folder.minimumWidth,
  });
  // 与文件夹同组（同栏两个 tab），不额外占用一栏
  api.addPanel({
    id: 'favorites',
    component: 'favorites',
    title: WORKBENCH_PANELS.favorites.title,
    minimumWidth: WORKBENCH_PANELS.favorites.minimumWidth,
    position: { referencePanel: 'folder', direction: 'within' },
    inactive: true,
  });
  api.getPanel('folder')?.api.setActive();
  api.addPanel({
    id: 'content',
    component: 'content',
    title: WORKBENCH_PANELS.content.title,
    minimumWidth: WORKBENCH_PANELS.content.minimumWidth,
    position: { referencePanel: 'folder', direction: 'right' },
    initialWidth: 260,
  });
  api.addPanel({
    id: 'workspace',
    component: 'workspace',
    title: WORKBENCH_PANELS.workspace.title,
    minimumWidth: WORKBENCH_PANELS.workspace.minimumWidth,
    position: { referencePanel: 'content', direction: 'right' },
  });
  api.addPanel({
    id: 'properties',
    component: 'properties',
    title: WORKBENCH_PANELS.properties.title,
    minimumWidth: WORKBENCH_PANELS.properties.minimumWidth,
    position: { referencePanel: 'workspace', direction: 'right' },
    initialWidth: 300,
  });
  applyDefaultRatios(api);
}

/**
 * 把默认布局的面板宽度校正到目标比例。
 *
 * dockview 对 `initialWidth` 只是「尽力而为」，直接按 addPanel 的结果落地宽度
 * 不可控；这里读出序列化布局、改写默认四栏叶子的 size 后写回，让首屏稳定在
 * 文件夹 15% / 内容 20% / 预览区 45% / 调整区 20%。结构与预期不符时保持原样。
 */
function applyDefaultRatios(api: DockviewApi) {
  try {
    const json = api.toJSON();
    const root = json.grid.root;
    if (
      root.type !== 'branch' ||
      !Array.isArray(root.data) ||
      root.data.length !== DEFAULT_LAYOUT_LEAVES.length
    ) {
      return;
    }
    const leaves = root.data;
    const known = new Set<string>(DEFAULT_LAYOUT_LEAVES);
    let total = 0;
    for (const leaf of leaves) {
      if (leaf.type !== 'leaf' || Array.isArray(leaf.data)) {
        return;
      }
      const panelId = leaf.data.views?.[0];
      const ratio = panelId
        ? WORKBENCH_PANELS[panelId as WorkbenchPanelId]?.defaultRatio
        : undefined;
      if (!panelId || !known.has(panelId) || ratio === undefined) {
        return;
      }
      leaf.size = Math.round(ratio * 1000);
      total += leaf.size;
    }
    root.size = total;
    api.fromJSON(json);
  } catch (error) {
    // 比例校正失败不影响布局可用，保留 addPanel 的原始宽度即可
    console.warn('[workbench] 默认布局比例校正失败:', error);
  }
}

/**
 * 恢复被关闭的面板：优先并入指定的同组面板（收藏夹 → 文件夹），
 * 否则停靠到当前激活面板右侧（首次恢复时布局里还没有激活面板则直接铺开）。
 */
const PANEL_RESTORE_GROUPING: Partial<Record<WorkbenchPanelId, WorkbenchPanelId>> = {
  favorites: 'folder',
};

function addPanelAtRestorePosition(api: DockviewApi, id: WorkbenchPanelId) {
  const grouping = PANEL_RESTORE_GROUPING[id];
  const grouped = grouping ? api.getPanel(grouping) : undefined;
  const reference = grouped ?? api.activePanel;
  api.addPanel({
    id,
    component: id,
    title: WORKBENCH_PANELS[id].title,
    minimumWidth: WORKBENCH_PANELS[id].minimumWidth,
    ...(reference
      ? {
          position: {
            referencePanel: reference,
            direction: grouped ? 'within' : 'right',
          },
        }
      : {}),
  });
}

/**
 * 给升级前保存的布局补挂「收藏夹」tab：默认布局自带它，只有旧布局缺失，
 * 首次加载时并入文件夹组。补挂一次后由 `favoritesSeeded` 记住，
 * 之后用户手动关闭 / 移走它，重启仍以布局本身为准。
 */
function ensureFavoritesPanel(api: DockviewApi, store: typeof useWorkbenchDockStore) {
  if (store.getState().favoritesSeeded) {
    return;
  }
  try {
    if (!api.getPanel('favorites') && api.getPanel('folder')) {
      api.addPanel({
        id: 'favorites',
        component: 'favorites',
        title: WORKBENCH_PANELS.favorites.title,
        minimumWidth: WORKBENCH_PANELS.favorites.minimumWidth,
        position: { referencePanel: 'folder', direction: 'within' },
        // 并入已有 tab 组时不抢「文件夹」的激活态
        inactive: true,
      });
      api.getPanel('folder')?.api.setActive();
      // 补挂结果立刻写回共享布局：防抖回写会被 StrictMode 的重挂载清掉，
      // 只留种子标记而布局里没有收藏夹，下次启动既不补挂也看不到它
      store.getState().setLayout(api.toJSON());
    }
    store.getState().markFavoritesSeeded();
  } catch (error) {
    console.warn('[workbench] 补挂收藏夹面板失败:', error);
  }
}

/**
 * 顶栏「视图」菜单的显隐开关：作用于指定路由当前挂载的工作台实例。
 *
 * 该实例的布局变化会写回共享布局，再同步到另一页，所以两页看到的面板集合始终一致。
 */
export function setWorkbenchPanelVisible(route: AppRoute, id: WorkbenchPanelId, visible: boolean) {
  const api = useWorkbenchDockStore.getState().apis[route];
  if (!api) {
    return;
  }
  const panel = api.getPanel(id);
  if (visible && !panel) {
    addPanelAtRestorePosition(api, id);
  } else if (!visible && panel) {
    panel.api.close();
  }
}

export function BusinessWorkbench({ header, routeKey, panels }: BusinessWorkbenchProps) {
  // 每个 dockview 实例一套订阅；StrictMode 双挂载时先清上一套再挂新一套
  const cleanupRef = useRef<(() => void) | null>(null);

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      const store = useWorkbenchDockStore;

      cleanupRef.current?.();
      cleanupRef.current = null;

      // 恢复共享布局；首次启动或恢复失败时按默认布局重建
      const saved = store.getState().layout;
      let restored = false;
      if (saved && isUsableLayout(saved)) {
        try {
          api.fromJSON(saved);
          restored = true;
        } catch (error) {
          console.warn('[workbench] 恢复停靠布局失败，回退默认布局:', error);
        }
      }
      if (!restored) {
        buildDefaultLayout(api);
      }
      // 升级前保存的布局里没有收藏夹 tab，首次加载补挂进文件夹组（默认布局自带时为空操作）
      ensureFavoritesPanel(api, store);

      store.getState().registerApi(routeKey, api);

      // 首次启动：默认布局立刻落盘，之后的改动走下面的防抖回写
      if (!store.getState().layout) {
        store.getState().setLayout(api.toJSON());
      }

      // 本页布局变化 → 防抖写回共享布局（另一页与重启后都以此为准）
      let writeTimer: number | undefined;
      const layoutDisposable = api.onDidLayoutChange(() => {
        window.clearTimeout(writeTimer);
        writeTimer = window.setTimeout(() => {
          const next = api.toJSON();
          const state = store.getState();
          if (JSON.stringify(next) !== JSON.stringify(state.layout)) {
            state.setLayout(next);
          }
        }, 250);
      });

      // 共享布局变化（另一页或视图菜单触发）→ 同步到本页；内容一致时跳过避免回环
      const unsubscribe = store.subscribe((state, previous) => {
        if (state.layout === previous.layout || !state.layout) {
          return;
        }
        try {
          if (JSON.stringify(api.toJSON()) !== JSON.stringify(state.layout)) {
            api.fromJSON(state.layout);
          }
        } catch (error) {
          console.warn('[workbench] 同步停靠布局失败:', error);
        }
      });

      cleanupRef.current = () => {
        window.clearTimeout(writeTimer);
        try {
          layoutDisposable.dispose();
        } catch (error) {
          // dockview 实例可能先于本回调被卸载（StrictMode 双挂载），订阅已随之失效
          console.warn('[workbench] 释放布局监听失败:', error);
        }
        unsubscribe();
        store.getState().registerApi(routeKey, null);
      };
    },
    [routeKey],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {header}
      <WorkbenchPanelsContext.Provider value={panels}>
        <div className="min-h-0 min-w-0 flex-1">
          <DockviewReact
            components={PANEL_COMPONENTS}
            theme={WORKBENCH_THEME}
            onReady={handleReady}
            disableFloatingGroups
          />
        </div>
      </WorkbenchPanelsContext.Provider>
    </div>
  );
}

interface BusinessWorkbenchWorkspaceProps {
  children: ReactNode;
}

export function BusinessWorkbenchWorkspace({ children }: BusinessWorkbenchWorkspaceProps) {
  return (
    <section className="relative flex min-h-0 min-w-0 h-full flex-1 items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,var(--color-accent),transparent_45%),linear-gradient(180deg,color-mix(in_oklch,var(--color-background),white_55%)_0%,var(--color-background)_100%)]">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_oklch,var(--color-border),transparent_35%)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklch,var(--color-border),transparent_35%)_1px,transparent_1px)] bg-size-[32px_32px] opacity-35" />
      <div className="relative flex h-full w-full min-h-0 min-w-0">{children}</div>
    </section>
  );
}

interface BusinessWorkbenchPropertiesPaneProps {
  children: ReactNode;
}

export function BusinessWorkbenchPropertiesPane({
  children,
}: BusinessWorkbenchPropertiesPaneProps) {
  return <aside className="relative flex h-full min-w-0 flex-col bg-card/90">{children}</aside>;
}
