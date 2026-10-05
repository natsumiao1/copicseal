import type { ReactNode } from 'react';
import { CoContentPanel } from '@/shared/components/co-content-panel';
import { CoFavoriteFolders } from '@/shared/components/co-favorite-folders';
import { CoFilterPanel } from '@/shared/components/co-filter-panel';
import { CoFolderTree } from '@/shared/components/co-folder-tree';
import { useSyncFilterTags } from '@/shared/hooks/use-sync-filter-tags';
import {
  BusinessWorkbench,
  type BusinessWorkbenchPanels,
  type BusinessWorkbenchProps,
} from '@/shared/layouts/business-workbench';

/** 页面提供页头、预览区与属性区；文件夹 / 筛选器 / 内容三块面板由这里统一注入。 */
export type CoFileSourceWorkbenchProps = Omit<BusinessWorkbenchProps, 'panels'> & {
  workspace: ReactNode;
  properties: () => ReactNode;
};

/**
 * 挂载全局文件来源的工作台。
 *
 * 边框水印与拼图都用它开页：文件夹树、收藏夹、筛选器与内容直览作为停靠面板
 * （收藏夹与文件夹默认同组共用两个 tab，筛选器停靠在文件夹栏下方），
 * 和页面的预览、调整一起交给 dockview 排布——可换位、可拖宽、可合并成 tab。
 * 面板集合与整体布局持久化在 `useWorkbenchDockStore`，两个功能页共用一份，
 * 页面自身不再各建素材区。
 *
 * 同时挂载标签同步钩子：筛选条件是否生效与面板显隐无关，加载点放在这里。
 */
export function CoFileSourceWorkbench({
  workspace,
  properties,
  ...workbench
}: CoFileSourceWorkbenchProps) {
  useSyncFilterTags();

  const panels: BusinessWorkbenchPanels = {
    folder: <CoFolderTree />,
    favorites: <CoFavoriteFolders />,
    filter: <CoFilterPanel />,
    content: <CoContentPanel />,
    workspace,
    properties,
  };

  return <BusinessWorkbench {...workbench} panels={panels} />;
}
