import type { StateStorage } from 'zustand/middleware';

/**
 * 合并窗口（毫秒）：窗口内的连续写入只保留最新值，窗口结束时落盘一笔。
 *
 * 拖动停靠面板、拖拽画布这类逐帧更新会让 zustand persist 每次 `set` 都同步写一次
 * `localStorage`；合并后热路径不再逐步落盘。
 */
const COALESCE_WINDOW_MS = 150;

/**
 * 带合并写入的 `localStorage` 包装，供各 store 的 `persist` 使用。
 *
 * 写入策略是「首笔立即 + 尾笔合并」：
 * - 窗口外的第一笔直接落盘——单次改动（选目录、切开关）仍然即时生效；
 * - 窗口内的后续写入只进 `pending`，窗口结束统一写一次——连续拖动只留下周期性快照；
 * - 页面隐藏 / 卸载时立即冲刷，避免关窗丢掉窗口内最后一笔。
 *
 * 因此最坏情况是进程被强杀时丢掉一个窗口（150ms）内的尾部改动。
 */
function createCoalescedLocalStorage(): StateStorage {
  /** key → 窗口内最新值 */
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) {
      return;
    }
    for (const [key, value] of pending) {
      try {
        window.localStorage.setItem(key, value);
      } catch (error) {
        // 配额满 / 隐私模式等：持久化失败不应中断编辑流程，留日志便于排查
        console.warn('[persist] 写入本地存储失败:', key, error);
      }
    }
    pending.clear();
  };

  // 页面切后台或关闭时同步落盘；正常流程里这两类事件都会先于销毁触发
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  });

  return {
    // 读时优先取未落盘的最新值：合并窗口内若发生重新水合，拿到的必须是新状态
    getItem: (name) => pending.get(name) ?? window.localStorage.getItem(name),
    setItem: (name, value) => {
      pending.set(name, value);
      if (timer !== null) {
        return;
      }
      flush();
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, COALESCE_WINDOW_MS);
    },
    removeItem: (name) => {
      pending.delete(name);
      window.localStorage.removeItem(name);
    },
  };
}

/** 全应用共用一份：多个 store 的写入合并进同一个窗口与冲刷时机 */
export const coalescedLocalStorage = createCoalescedLocalStorage();
