import { Grid3x3 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { prepareElementForSnapshot } from '@/core/renderer';
import { collectAdaptivePhotoIds } from '@/features/collage/adaptive';
import { useCollageHistoryShortcuts } from '@/features/collage/hooks/use-collage-history-shortcuts';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import { exportSingle, resolveProfileOutputDir } from '@/platform';
import {
  CoExportPresetPanel,
  type ExportPresetRunState,
} from '@/shared/components/co-export-preset-panel';
import { CoFileSourceWorkbench } from '@/shared/components/co-file-source-workbench';
import {
  notifyExportedDirectory,
  notifyExportFailed,
} from '@/shared/components/co-open-directory-link';
import { CoWindowHeader } from '@/shared/components/co-window-header';
import { usePhotoImportByPath } from '@/shared/hooks/use-photo-import-by-path';
import { usePhotos } from '@/shared/hooks/use-photos';
import {
  BusinessWorkbenchPropertiesPane,
  BusinessWorkbenchWorkspace,
} from '@/shared/layouts/business-workbench';
import type { ExportPresetProfile, ExportSizing } from '@/shared/types/export';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { CollageCanvas, CollagePropertiesPanel, CollageToolbar } from '../exports';

/** 拼图导出文件名的自动命名主干：拼图是整块画布，没有单张原图名可沿用。 */
const COLLAGE_BASE_NAME = '拼图';

/**
 * 预设的「图像调整尺寸」→ 拼图抓图倍率与输出宽高。
 *
 * 拼图没有照片原始像素可参照：缩放百分比相对画布当前渲染尺寸（预览区变化会
 * 随之漂移，属已知缺口），调整大小至按画布对应边折算倍率，`noUpscale` 不放大
 * 到画布像素之上。输出宽高仅用于自动命名 `{拼图}@{宽}x{高}`。
 */
function resolveCollageSizing(element: HTMLElement, sizing: ExportSizing) {
  const canvasWidth = element.offsetWidth;
  const canvasHeight = element.offsetHeight;
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    throw new Error('画布尚未就绪，无法解算导出尺寸');
  }

  let scale: number;
  if (sizing.mode === 'scale') {
    scale = sizing.percent / 100;
  } else {
    const basis =
      sizing.axis === 'long'
        ? Math.max(canvasWidth, canvasHeight)
        : sizing.axis === 'short'
          ? Math.min(canvasWidth, canvasHeight)
          : sizing.axis === 'width'
            ? canvasWidth
            : canvasHeight;
    scale = sizing.px / basis;
    if (sizing.noUpscale) {
      scale = Math.min(scale, 1);
    }
  }

  // 过小的倍率会让快照失败，兜一个下限（0.05 约等于 16px 的极小输出）
  scale = Math.min(Math.max(scale, 0.05), 16);
  return {
    scale,
    width: Math.round(canvasWidth * scale),
    height: Math.round(canvasHeight * scale),
  };
}

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

function CollagePropertiesPane() {
  return (
    <BusinessWorkbenchPropertiesPane>
      <ScrollArea className="min-h-0 flex-1">
        <CollagePropertiesPanel />
      </ScrollArea>
    </BusinessWorkbenchPropertiesPane>
  );
}

export function CollagePage() {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const { photos } = usePhotos();
  const restorePending = useCollageStore((state) => state.restorePending);
  const setRestorePending = useCollageStore((state) => state.setRestorePending);
  const { ensureByPath } = usePhotoImportByPath();
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

  /**
   * 进行中的导出（与「边框水印」页同构）：挂在所属预设行上显示进度。
   * 拼图没有批量语义，任务恒为单张画布。
   */
  const [exportRun, setExportRun] = useState<ExportPresetRunState | null>(null);

  /** 按预设导出当前画布：目录、冲突、格式画质与尺寸意图全部来自预设。 */
  const exportCanvas = async (profile: ExportPresetProfile) => {
    const element = previewRef.current;
    if (!element) {
      return;
    }

    try {
      // 拼图没有单一原图，source-dir 在解析时回落到设置的导出目录
      const outputDir = await resolveProfileOutputDir(profile);
      const { scale, width, height } = resolveCollageSizing(element, profile.sizing);
      await prepareElementForSnapshot(element);
      await exportSingle(
        element,
        {
          presets: [
            {
              id: profile.id,
              format: profile.format,
              width,
              height,
              scale,
              quality: profile.quality,
            },
          ],
          dpi: 72,
          // 拼图画布是合成结果，没有可搬运的原图 EXIF
          preserveExif: false,
        },
        undefined,
        { baseName: COLLAGE_BASE_NAME, outputDir, conflict: profile.conflict },
      );
      notifyExportedDirectory(outputDir);
    } catch (error) {
      notifyExportFailed(error);
    }
  };

  /**
   * 导出面板入口：拖拽与行内按钮都导出当前画布——拖来的照片只是触发器，
   * 不参与画布内容（见 docs/requirements.md §5.5）。
   */
  const handleExportTrigger = (profile: ExportPresetProfile) => {
    if (exportRun !== null || photos.length === 0) {
      return;
    }

    setExportRun({ presetId: profile.id, completed: 0, total: 1, taskId: null });
    void exportCanvas(profile).finally(() => setExportRun(null));
  };

  return (
    <CoFileSourceWorkbench
      routeKey="/collage"
      header={<CollageHeader />}
      workspace={
        <BusinessWorkbenchWorkspace>
          <CollageCanvas previewRef={previewRef} />
        </BusinessWorkbenchWorkspace>
      }
      properties={() => <CollagePropertiesPane />}
      export={() => (
        <CoExportPresetPanel
          run={exportRun}
          singleLabel="导出画布"
          showExportAll={false}
          disabled={photos.length === 0}
          onExport={handleExportTrigger}
          // 单张任务没有可取消的调度器（total 恒为 1，面板不会显示取消按钮）
          onCancel={() => undefined}
        />
      )}
    />
  );
}
