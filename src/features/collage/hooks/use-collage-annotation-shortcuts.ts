import { useEffect } from 'react';
import { useCollageStore } from '@/features/collage/store/use-collage-store';

/** 输入态：焦点在这些控件上时交还原生编辑行为，不接管快捷键。 */
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
 * 拼图文字标注快捷键：
 * `Delete` / `Backspace` 删除选中的标注，`Esc` 取消选中。
 *
 * 只作用于 `selectedAnnotationId`，不影响槽位 / 自适应照片的选择；
 * 焦点在输入控件上时不拦截（文案编辑里的 Delete/Esc 交还原生行为）。
 */
export function useCollageAnnotationShortcuts(): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) {
        return;
      }

      const state = useCollageStore.getState();
      if (state.selectedAnnotationId === null) {
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        state.removeAnnotation(state.selectedAnnotationId);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        state.selectAnnotation(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
