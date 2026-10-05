import { Minus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  closeWindow,
  getWindowMaximized,
  isNativeWindowAvailable,
  minimizeWindow,
  onWindowResize,
  toggleMaximizeWindow,
} from '@/platform';
import { useWindowStyle } from '@/shared/providers/window-style-provider';

function RestoreWindowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="size-4">
      <title>还原窗口</title>
      <path d="M5.5 4.5H11.5V10.5H5.5z" />
      <path d="M4.5 6.5H3.5V12.5H9.5V11.5" />
    </svg>
  );
}

async function runWindowAction(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    console.error('Window action failed:', error);
  }
}

/**
 * 无边框窗口的自定义标题栏按钮（最小化 / 最大化 / 关闭）。
 *
 * 挂在顶部导航条右端：功能选择上移到顶部后，这一行就是窗口的最上沿，
 * 窗口控件随之从页面头部迁到导航条，保持「按钮贴窗口右上角」的系统习惯。
 * mac 没有自定义控件（红绿灯由系统悬浮），此时返回 null。
 */
export function CoWindowControls() {
  const { variant, frameMode } = useWindowStyle();
  const [isMaximized, setIsMaximized] = useState(false);
  // 只有 win 的无边框窗口才需要自定义控件：mac 用系统红绿灯，有边框窗口用系统标题栏
  const enabled = isNativeWindowAvailable() && variant === 'win' && frameMode === 'frameless';

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let unlisten: (() => void) | undefined;

    const syncMaximized = async () => {
      try {
        setIsMaximized(await getWindowMaximized());
      } catch (error) {
        console.error('Read window maximize state failed:', error);
      }
    };

    void syncMaximized();

    onWindowResize(() => {
      void syncMaximized();
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error) => {
        console.error('Listen window resize failed:', error);
      });

    return () => {
      unlisten?.();
    };
  }, [enabled]);

  if (!enabled) {
    return null;
  }

  return (
    <div className="flex h-full items-stretch" data-tauri-drag-region="false">
      <button
        type="button"
        aria-label="最小化窗口"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        onClick={() => void runWindowAction(minimizeWindow)}
      >
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? '还原窗口' : '最大化窗口'}
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        onClick={() => void runWindowAction(toggleMaximizeWindow)}
      >
        {isMaximized ? <RestoreWindowIcon /> : <Square className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="关闭窗口"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-[#e81123] hover:text-white"
        onClick={() => void runWindowAction(closeWindow)}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
