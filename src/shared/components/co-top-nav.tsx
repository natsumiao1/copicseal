import { Grid3x3, LayoutPanelLeft, LayoutTemplate, Settings2, Sparkles } from 'lucide-react';
import type { AppRoute } from '@/app/routes';
import { CoWindowControls } from '@/shared/components/co-window-controls';
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

/**
 * 顶部导航条：功能选择（边框水印 / 拼图 / 设置）、视图菜单与窗口控件都收在这一行。
 *
 * 功能选择移到顶部后，左侧让给了全局文件来源（文件夹 / 内容停靠面板），
 * 因此这里不再占据固定宽度的侧栏。「视图」菜单勾选显示四个停靠面板，
 * 关闭的面板从这里恢复。整条同时是无边框窗口的拖拽区，mac 的悬浮
 * 红绿灯与 win 的自定义按钮分别通过左侧留白与右侧控件避开。
 */
export function CoTopNav({ route, onRouteChange }: CoTopNavProps) {
  const { variant, frameMode } = useWindowStyle();
  const frameless = frameMode === 'frameless';
  // 订阅共享布局：面板被关闭 / 恢复后勾选状态随之刷新
  const dockLayout = useWorkbenchDockStore((state) => state.layout);
  const dockApi = useWorkbenchDockStore((state) => state.apis[route]);

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
