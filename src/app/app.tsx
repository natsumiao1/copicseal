import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { type AppRoute, navigate, normalizeRoute } from '@/app/routes';
import CollagePage from '@/features/collage';
import { SettingsPage } from '@/features/settings';
import TemplatePage from '@/features/template';
import { checkForUpdate } from '@/platform';
import { CoErrorBoundary } from '@/shared/components/co-error-boundary';
import { CoTopNav } from '@/shared/components/co-top-nav';
import { cn } from '@/shared/lib/utils';
import { NavigationProvider } from '@/shared/providers/navigation-provider';
import { PageActivityProvider } from '@/shared/providers/page-activity-provider';
import { PhotoProvider } from '@/shared/providers/photo-provider';
import { useWindowStyle, WindowStyleProvider } from '@/shared/providers/window-style-provider';
import { Toaster } from '@/shared/ui/toaster';
import './app.css';

function renderPage(route: AppRoute) {
  if (route === '/settings') {
    return <SettingsPage />;
  }

  return route === '/template' ? <TemplatePage /> : <CollagePage />;
}

function AppContent() {
  const [route, setRoute] = useState<AppRoute>(() => normalizeRoute(window.location.pathname));
  // 访问过的页面保持挂载：页面内容（素材、模板参数、拼图布局）都是 React 会话状态，
  // 一旦卸载就会丢失。切换功能改为只切换可见性，卸载只发生在应用退出时。
  const [visitedRoutes, setVisitedRoutes] = useState<AppRoute[]>(() => [route]);
  const { variant, frameMode } = useWindowStyle();

  useEffect(() => {
    const normalized = normalizeRoute(window.location.pathname);
    if (normalized !== window.location.pathname) {
      navigate(normalized);
    }
    setRoute(normalized);

    const handlePopState = () => {
      setRoute(normalizeRoute(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    setVisitedRoutes((prev) => (prev.includes(route) ? prev : [...prev, route]));
  }, [route]);

  // 启动后静默检查一次更新：失败不打扰用户，发现新版本时提示到设置页安装，
  // 同时把待安装的更新预热给设置页使用。
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const update = await checkForUpdate();
        if (!cancelled && update) {
          toast.info(`发现新版本 ${update.version}`, {
            description: '可在「设置 → 关于」中下载并安装',
          });
        }
      } catch {
        // 静默失败：检查更新不应影响启动流程。
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 首次进入某页时 render 早于上面的 effect，这里先补上当前页，避免闪一帧空白。
  const renderedRoutes = visitedRoutes.includes(route) ? visitedRoutes : [...visitedRoutes, route];

  // targetId 会写进地址栏 hash，由目标页读取后定位到对应设置项
  const handleRouteChange = (nextRoute: AppRoute, targetId?: string) => {
    navigate(nextRoute, targetId);
    setRoute(nextRoute);
  };

  return (
    <div
      className={cn(
        'flex h-screen flex-col overflow-hidden bg-background text-foreground',
        variant === 'win' && frameMode === 'frameless' && 'rounded-lg border border-border',
      )}
      data-window-style={variant}
      data-window-frame-mode={frameMode}
    >
      {/* 功能选择（边框水印 / 拼图 / 设置）放在顶部，左侧整条让给全局文件来源面板 */}
      <CoTopNav route={route} onRouteChange={handleRouteChange} />
      {/*
        素材会话全局只有一份：切功能时带着同一批照片走。
        拖放与粘贴只在功能页可见时响应，避免在设置页误导入。
      */}
      <PhotoProvider active={route !== '/settings'}>
        <NavigationProvider onNavigate={handleRouteChange}>
          <div className="relative min-h-0 min-w-0 flex-1">
            {renderedRoutes.map((pageRoute) => {
              const active = pageRoute === route;

              return (
                <PageActivityProvider key={pageRoute} active={active}>
                  {/*
                    隐藏页用 visibility 而非 display 保留布局：预览自适应、面板尺寸与滚动位置
                    都依赖真实布局尺寸，保留布局可以让切回时不需要重新测量。
                  */}
                  <div
                    className={cn(
                      'absolute inset-0 h-full w-full',
                      !active && 'pointer-events-none invisible',
                    )}
                    aria-hidden={!active}
                    inert={!active}
                  >
                    {renderPage(pageRoute)}
                  </div>
                </PageActivityProvider>
              );
            })}
          </div>
          {/* Toaster 放在 Provider 内部：toast 的描述节点由 Toaster 渲染，上下文按渲染
              位置解析，放外面的话里面的「更改」跳转按钮拿不到导航函数 */}
          <Toaster />
        </NavigationProvider>
      </PhotoProvider>
    </div>
  );
}

function App() {
  // 最外层兜底：任一页面渲染抛错时显示错误卡片，而不是清空整窗
  return (
    <CoErrorBoundary>
      <WindowStyleProvider>
        <AppContent />
      </WindowStyleProvider>
    </CoErrorBoundary>
  );
}

export default App;
