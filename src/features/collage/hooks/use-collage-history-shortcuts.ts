import { useEffect } from 'react';
import { useCollageStore } from '@/features/collage/store/use-collage-store';

/** 输入态：焦点在这些控件上时交还原生文本撤销，不接管快捷键。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/**
 * 拼图编辑历史快捷键：
 * `Cmd/Ctrl+Z` 撤销，`Cmd/Ctrl+Shift+Z`（Windows `Ctrl+Y`）重做。
 *
 * 撤销/重做走 store 的 `present` 历史（最多 60 步，不持久化），
 * 覆盖布局切换、间距/边距、槽位调整与自适应树改动；
 * 焦点在输入控件上时不拦截，交还原生文本撤销（如自定义比例输入框）。
 */
export function useCollageHistoryShortcuts(): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }
      // Option+Z 等组合留给输入法/特殊字符，不接管
      if (event.altKey || isEditableTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        useCollageStore.getState().undo();
        return;
      }
      if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        useCollageStore.getState().redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
