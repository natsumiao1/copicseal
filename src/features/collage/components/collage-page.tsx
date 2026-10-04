import { Grid3x3 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { prepareElementForSnapshot } from '@/core/renderer';
import { runScheduledExports } from '@/core/scheduler';
import { collectAdaptivePhotoIds } from '@/features/collage/adaptive';
import { CollageBrowsePanel } from '@/features/collage/components/collage-browse-panel';
import { CollageFolderTree } from '@/features/collage/components/collage-folder-tree';
import { useCollageHistoryShortcuts } from '@/features/collage/hooks/use-collage-history-shortcuts';
import { useCollagePhotoImport } from '@/features/collage/hooks/use-collage-photo-import';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import { exportSingle, platform, resolveExportDirectory } from '@/platform';
import {
  notifyExportedDirectory,
  notifyExportFailed,
} from '@/shared/components/co-open-directory-link';
import { CoWindowHeader } from '@/shared/components/co-window-header';
import { usePhotos } from '@/shared/hooks/use-photos';
import {
  BusinessWorkbench,
  BusinessWorkbenchPropertiesPane,
  BusinessWorkbenchWorkspace,
} from '@/shared/layouts/business-workbench';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/shared/ui/resizable';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { CollageCanvas, CollagePropertiesPanel, CollageToolbar } from '../exports';

/** 拼图导出文件名的自动命名主干：拼图是整块画布，没有单张原图名可沿用。 */
const COLLAGE_BASE_NAME = '拼图';

function CollageHeader() {
  return (
    <CoWindowHeader
      icon={Grid3x3}
      title="拼图"
      description="布局编辑与导出"
      actions={<CollageToolbar />}
    />
  );
}

/** 左侧素材区：文件夹树 + 图片预览栏（文件夹直览）。 */
function CollageLeftRail() {
  const folderPath = useCollageStore((state) => state.folderPath);
  const openFolder = useCollageStore((state) => state.openFolder);

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0 min-w-0">
      <ResizablePanel
        defaultSize={200}
        minSize={150}
        maxSize={320}
        className="min-h-0 min-w-0"
        style={{ overflow: 'hidden' }}
      >
        <CollageFolderTree selectedPath={folderPath} onSelect={openFolder} />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel minSize={180} className="min-h-0 min-w-0" style={{ overflow: 'hidden' }}>
        <CollageBrowsePanel />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function CollagePropertiesPane({
  onExportCurrent,
  onExportBatch,
}: {
  onExportCurrent: Parameters<typeof CollagePropertiesPanel>[0]['onExportCurrent'];
  onExportBatch: Parameters<typeof CollagePropertiesPanel>[0]['onExportBatch'];
}) {
  return (
    <BusinessWorkbenchPropertiesPane>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 py-3">
          <CollagePropertiesPanel onExportCurrent={onExportCurrent} onExportBatch={onExportBatch} />
        </div>
      </ScrollArea>
    </BusinessWorkbenchPropertiesPane>
  );
}

export function CollagePage() {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const { photos } = usePhotos();
  const restorePending = useCollageStore((state) => state.restorePending);
  const setRestorePending = useCollageStore((state) => state.setRestorePending);
  const { ensureByPath } = useCollagePhotoImport();
  // 撤销/重做快捷键：随拼图页挂载/卸载，避免在其他页面误拦 Cmd+Z
  useCollageHistoryShortcuts();

  // 重启恢复：持久化的槽位与自适应树以文件路径为 photoId，逐个懒导入回填
  // （缓存大多还在，命中即秒回），完成后放行画布对账；导入失败的路径由对账按失效图清掉。
  useEffect(() => {
    if (!restorePending) {
      return;
    }

    const slotPaths: string[] = [];
    const seen = new Set<string>();
    const collect = (photoId: string | null | undefined) => {
      if (photoId && !seen.has(photoId)) {
        seen.add(photoId);
        slotPaths.push(photoId);
      }
    };
    for (const slot of useCollageStore.getState().present.slotItems) {
      collect(slot.photoId);
    }
    for (const photoId of collectAdaptivePhotoIds(
      useCollageStore.getState().present.adaptiveTree,
    )) {
      collect(photoId);
    }

    let cancelled = false;
    void (async () => {
      for (const path of slotPaths) {
        if (cancelled) {
          return;
        }
        await ensureByPath(path);
      }
      if (!cancelled) {
        setRestorePending(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ensureByPath, restorePending, setRestorePending]);

  const handleExportCurrent: Parameters<typeof CollagePropertiesPanel>[0]['onExportCurrent'] =
    async (options) => {
      if (!previewRef.current) {
        return;
      }

      try {
        // 直接写到配置里的「保存目录」，不再弹保存对话框
        const outputDir = await resolveExportDirectory();
        await prepareElementForSnapshot(previewRef.current);
        await exportSingle(previewRef.current, options, undefined, {
          baseName: COLLAGE_BASE_NAME,
          outputDir,
        });
        notifyExportedDirectory(outputDir);
      } catch (error) {
        notifyExportFailed(error);
      }
    };

  const handleExportBatch: Parameters<typeof CollagePropertiesPanel>[0]['onExportBatch'] = async (
    options,
  ) => {
    if (!previewRef.current || photos.length === 0) {
      return;
    }

    try {
      const outputDir = await resolveExportDirectory();

      await runScheduledExports({
        items: photos,
        runner: async () => {
          if (!previewRef.current) {
            return;
          }
          await prepareElementForSnapshot(previewRef.current);
          await exportSingle(previewRef.current, options, undefined, {
            baseName: COLLAGE_BASE_NAME,
            outputDir,
          });
        },
      });

      notifyExportedDirectory(outputDir);
    } catch (error) {
      notifyExportFailed(error);
    }
  };

  return (
    <BusinessWorkbench
      header={<CollageHeader />}
      leftRail={platform.capabilities.files.folderBrowse ? <CollageLeftRail /> : undefined}
      workspace={
        <BusinessWorkbenchWorkspace>
          <CollageCanvas previewRef={previewRef} />
        </BusinessWorkbenchWorkspace>
      }
      properties={() => (
        <CollagePropertiesPane
          onExportCurrent={handleExportCurrent}
          onExportBatch={handleExportBatch}
        />
      )}
    />
  );
}
