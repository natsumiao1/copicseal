import { create } from 'zustand';

/** 字体下拉悬浮预览的目标标注 id + 预览字体（`fontFamily` 为 undefined 表示「默认字体」） */
export interface CollageFontPreview {
  id: string;
  fontFamily?: string;
}

/**
 * 字体悬浮预览状态：只影响画布渲染，不入历史、不持久化，下拉关闭 /
 * 鼠标离开选项区 / 编辑器卸载即清除。
 *
 * 单独成店而非放进 `useCollageStore`：预览在悬浮选项时高频写入，若挂在主 store 上，
 * 整店订阅的属性面板会随每次悬浮重渲染，连带 Radix Select 重跑 `position()`
 * 把下拉开合过程中的高度 / scrollTop 重置——触控板滚动刚推出去就被拉回顶部。
 * 拆出后悬浮写入只触发画布（唯一消费方）重渲染。
 */
interface FontPreviewStoreState {
  fontPreview: CollageFontPreview | null;
  setFontPreview: (preview: CollageFontPreview | null) => void;
}

export const useFontPreviewStore = create<FontPreviewStoreState>()((set) => ({
  fontPreview: null,
  setFontPreview: (preview) => set({ fontPreview: preview }),
}));
