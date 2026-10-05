import type { ReactNode } from 'react';
import { CoContentPanel } from '@/shared/components/co-content-panel';
import { CoFavoriteFolders } from '@/shared/components/co-favorite-folders';
import { CoFolderTree } from '@/shared/components/co-folder-tree';
import {
  BusinessWorkbench,
  type BusinessWorkbenchPanels,
  type BusinessWorkbenchProps,
} from '@/shared/layouts/business-workbench';

/** 页面提供页头、预览区与属性区；文件夹 / 内容两块面板由这里统一注入。 */
export type CoFileSourceWorkbenchProps = Omit<BusinessWorkbenchProps, 'panels'> & {
  workspace: ReactNode;
  properties: () => ReactNode;
};

/**
 * 挂载全局文件来源的工作台。
 *
 * 边框水印与拼图都用它开页：文件夹树、收藏夹与内容直览作为三块停靠面板
 * （收藏夹与文件夹默认同组、共用两个 tab），和页面的预览区、调整区一起交给
 * dockview 排布——可换位、可拖宽、可合并成 tab。
 * 面板集合与整体布局持久化在 `useWorkbenchDockStore`，两个功能页共用一份，
 * 页面自身不再各建素材区。
 */
export function CoFileSourceWorkbench({
  workspace,
  properties,
  ...workbench
}: CoFileSourceWorkbenchProps) {
  const panels: BusinessWorkbenchPanels = {
    folder: <CoFolderTree />,
    favorites: <CoFavoriteFolders />,
    content: <CoContentPanel />,
    workspace,
    properties,
  };

  return <BusinessWorkbench {...workbench} panels={panels} />;
}
