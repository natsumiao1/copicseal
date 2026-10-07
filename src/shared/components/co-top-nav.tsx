import { Grid3x3, LayoutPanelLeft, LayoutTemplate, Settings2, Sparkles } from 'lucide-react';
import { useEffect } from 'react';
import type { AppRoute } from '@/app/routes';
import { platform } from '@/platform';
import { CoWindowControls } from '@/shared/components/co-window-controls';
import type { WorkbenchPanelId } from '@/shared/layouts/business-workbench';
import {
  setWorkbenchPanelVisible,
  WORKBENCH_PANEL_IDS,
  WORKBENCH_PANELS,
} from '@/shared/layouts/business-workbench';
import { cn } from '@/shared/lib/utils';
import { useWindowStyle } from '@/shared/providers/window-style-provider';
import { useWorkbenchDockStore } from '@/shared/store/use-workbench-dock-store';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/shared/ui/tooltip';

interface CoTopNavProps {
  route: AppRoute;
  onRouteChange: (route: AppRoute) => void;
}

const items: Array<{
  route: AppRoute;
  label: string;
  icon: typeof LayoutTemplate;
}> = [
  { route: '/template', label: '边框水印', icon: LayoutTemplate },
  { route: '/collage', label: '拼图', icon: Grid3x3 },
];

/** 系统菜单回流的 id 是字符串，落回前先校验属于已知停靠面板。 */
function isPanelId(id: string): id is WorkbenchPanelId {
  return (WORKBENCH_PANEL_IDS as readonly string[]).includes(id);
}

/**
 * 顶部导航条：功能选择（边框水印 / 拼图 / 设置）、视图菜单与窗口控件都收在这一行。
 *
 * 功能选择移到顶部后，左侧让给了全局文件来源（文件夹 / 内容停靠面板），
 * 因此这里不再占据固定宽度的侧栏。整条同时是无边框窗口的拖拽区，mac 的悬浮
 * 红绿灯与 win 的自定义按钮分别通过左侧留白与右侧控件避开。
 *
 * 「视图」菜单按平台分两条路：macOS 交给系统菜单栏原生菜单（勾选状态由这里同步
 * 过去、点击事件回流到这里），Windows 保留本组件里的下拉。`Cmd/Ctrl+,` 打开设置。
 */
export function CoTopNav({ route, onRouteChange }: CoTopNavProps) {
  const { variant, frameMode } = useWindowStyle();
  const frameless = frameMode === 'frameless';
  // 订阅共享布局：面板被关闭 / 恢复后勾选状态随之刷新
  const dockLayout = useWorkbenchDockStore((state) => state.layout);
  const dockApi = useWorkbenchDockStore((state) => state.apis[route]);
  const isMac = variant === 'mac';

  // mac：把当前工作台的视图勾选状态同步给系统菜单栏「视图」菜单；
  // 停靠面板开合与路由切换都会改写 dockApi / dockLayout，这里随之重推
  useEffect(() => {
    if (!isMac) {
      return;
    }
    void platform.menu.syncViewMenu(
      WORKBENCH_PANEL_IDS.map((id) => ({
        id,
        title: WORKBENCH_PANELS[id].title,
        checked: dockApi
          ? dockApi.getPanel(id) !== undefined
          : dockLayout?.panels[id] !== undefined,
        // 设置页没有工作台时菜单项置灰，与下拉的 disabled 行为一致
        enabled: Boolean(dockApi),
      })),
    );
  }, [isMac, dockApi, dockLayout]);

  // mac：系统菜单栏事件回流——勾选切换按当前路由应用，「设置…」打开设置页
  useEffect(() => {
    if (!isMac) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void platform.menu
      .onNativeMenuEvent((event) => {
        if (event.type === 'viewToggle') {
          if (isPanelId(event.id)) {
            setWorkbenchPanelVisible(route, event.id, event.checked);
          }
          return;
        }
        onRouteChange('/settings');
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error: unknown) => {
        console.error('[top-nav] 订阅系统菜单事件失败', error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isMac, route, onRouteChange]);

  // Cmd+,（Windows 为 Ctrl+,）打开设置：mac 的原生菜单快捷键优先命中，这里兜底其余情形
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        onRouteChange('/settings');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onRouteChange]);

  return (
    <TooltipProvider>
      <header
        data-tauri-drag-region={frameless ? true : undefined}
        className={cn(
          'relative flex h-12 shrink-0 items-center gap-1 border-b border-sidebar-border bg-[linear-gradient(90deg,color-mix(in_oklch,var(--color-muted),white_15%)_0%,var(--color-background)_100%)] pl-3',
          // win 无边框模式：自定义窗口按钮贴窗口右缘，不留外边距
          variant === 'win' && frameless ? 'pr-0' : 'pr-3',
          // mac 无边框模式：系统红绿灯悬浮在窗口左上角，导航让出这段横向距离
          variant === 'mac' && frameless && 'pl-20',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="可图匠"
              className="flex h-9 items-center gap-2 rounded-2xl border border-border/80 bg-card px-3 text-primary shadow-sm transition-transform hover:-translate-y-0.5"
              onClick={() => onRouteChange('/template')}
            >
              <Sparkles className="size-4.5" />
              <span className="text-xs font-semibold tracking-tight">可图匠</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>可图匠</TooltipContent>
        </Tooltip>

        <nav
          className="flex items-center gap-1"
          data-tauri-drag-region={frameless ? true : undefined}
        >
          {items.map((item) => {
            const Icon = item.icon;
            const active = route === item.route;

            return (
              <button
                key={item.route}
                type="button"
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-all',
                  active
                    ? 'border-primary/30 bg-primary text-primary-foreground shadow-[0_12px_28px_-16px_var(--color-primary)]'
                    : 'border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-foreground',
                )}
                onClick={() => onRouteChange(item.route)}
              >
                <Icon className="size-4" />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex h-full items-center gap-1" data-tauri-drag-region="false">
          {/* mac 的「视图」在系统菜单栏，这里只留 Windows 的下拉入口 */}
          {isMac ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={!dockApi}
                  className={cn(
                    'flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-all',
                    'border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-foreground',
                    'disabled:pointer-events-none disabled:opacity-40',
                  )}
                >
                  <LayoutPanelLeft className="size-4" />
                  视图
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                {WORKBENCH_PANEL_IDS.map((id) => (
                  <DropdownMenuCheckboxItem
                    key={id}
                    checked={
                      dockApi
                        ? dockApi.getPanel(id) !== undefined
                        : dockLayout?.panels[id] !== undefined
                    }
                    onCheckedChange={(checked) =>
                      setWorkbenchPanelVisible(route, id, checked === true)
                    }
                    // 保持菜单打开，方便连续勾选多个面板
                    onSelect={(event) => event.preventDefault()}
                  >
                    {WORKBENCH_PANELS[id].title}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="设置"
                aria-current={route === '/settings' ? 'page' : undefined}
                className={cn(
                  'flex size-9 items-center justify-center rounded-xl border transition-all',
                  route === '/settings'
                    ? 'border-primary/30 bg-primary text-primary-foreground shadow-[0_12px_28px_-16px_var(--color-primary)]'
                    : 'border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-foreground',
                )}
                onClick={() => onRouteChange('/settings')}
              >
                <Settings2 className="size-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>设置</TooltipContent>
          </Tooltip>
          <CoWindowControls />
        </div>
      </header>
    </TooltipProvider>
  );
}
