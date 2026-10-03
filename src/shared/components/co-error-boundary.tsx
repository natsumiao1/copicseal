import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/shared/ui/button';

interface CoErrorBoundaryProps {
  children: ReactNode;
}

interface CoErrorBoundaryState {
  error: Error | null;
}

/**
 * 全局错误边界：任一页面渲染抛错时降级为错误卡片并提供重载入口，
 * 避免 React 卸载整棵组件树导致整窗白屏。
 *
 * React 内置的错误边界只能用 class 实现，因此这是
 * 「尽量不写 class 组件」规则的唯一例外（见 AGENTS.md）。
 */
export class CoErrorBoundary extends Component<CoErrorBoundaryProps, CoErrorBoundaryState> {
  state: CoErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): CoErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('页面渲染出错', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-5 bg-background px-6 text-center text-foreground">
        <div className="space-y-2">
          <h1 className="text-base font-semibold">页面出错了</h1>
          <p className="max-w-lg break-all text-xs leading-5 text-muted-foreground">
            {error.message}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={this.handleReset}>
            重试
          </Button>
          <Button size="sm" onClick={this.handleReload}>
            重新加载
          </Button>
        </div>
      </div>
    );
  }
}
