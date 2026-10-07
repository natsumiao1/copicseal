import { Copy, LayoutTemplate } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { prepareElementForSnapshot, waitForDomStability, waitForImages } from '@/core/renderer';
import { runScheduledExports } from '@/core/scheduler';
import {
  DEFAULT_TEMPLATE_BACKGROUND,
  TEMPLATE_BACKGROUND_FIELDS,
  type TemplateBackground,
  toTemplateBackground,
} from '@/features/template/background';
import { applyRenderSize, resolveExportSizeTarget } from '@/features/template/lib/render-size';
import { getBuiltinTemplateSchema } from '@/features/template/runtime/template-registry';
import {
  cancelExportTask,
  type ExportOptions,
  type ExportRunContext,
  exportSingle,
  getExportTaskState,
  resolveProfileOutputDir,
} from '@/platform';
import {
  CoExportPresetPanel,
  type ExportPresetRunState,
  type ExportPresetTrigger,
} from '@/shared/components/co-export-preset-panel';
import { CoFileSourceWorkbench } from '@/shared/components/co-file-source-workbench';
import {
  notifyExportedDirectory,
  notifyExportFailed,
} from '@/shared/components/co-open-directory-link';
import { CoPanelSection } from '@/shared/components/co-panel-section';
import { CoWindowHeader } from '@/shared/components/co-window-header';
import { usePhotoImportByPath } from '@/shared/hooks/use-photo-import-by-path';
import { usePhotos } from '@/shared/hooks/use-photos';
import {
  BusinessWorkbenchPropertiesPane,
  BusinessWorkbenchWorkspace,
} from '@/shared/layouts/business-workbench';
import type { ExportPresetProfile } from '@/shared/types/export';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  PhotoPalettePicker,
  TemplateExifCard,
  TemplatePreview,
  TemplatePropsPanel,
  TemplateSelector,
} from '../exports';
import { ensurePhotoExif } from '../hooks/use-photo-exif';
import { type PhotoPaletteState, usePhotoPalette } from '../hooks/use-photo-palette';
import {
  getTemplatePhotoConfig,
  type TemplateApplyScope,
  useTemplatePhotoConfig,
  useTemplateStore,
} from '../store/use-template-store';

function TemplateHeader() {
  return <CoWindowHeader icon={LayoutTemplate} title="边框水印" description="模板渲染与导出" />;
}

/** 一键应用提示里的范围名，与按钮文案保持一致。 */
const APPLY_SCOPE_LABELS: Record<TemplateApplyScope, string> = {
  template: '模板与参数',
  background: '背景',
};

/**
 * 一键应用按钮。
 *
 * 模板与参数合并成一个动作：参数脱离所属模板没有意义，分开应用只会得到
 * 一份与模板不匹配的残值。
 */
function ApplyToOthersButton({
  label,
  count,
  onClick,
}: {
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <Button type="button" variant="outline" size="sm" className="w-full" onClick={onClick}>
      <Copy data-icon="inline-start" />
      {label}（{count} 张）
    </Button>
  );
}

function TemplatePropertiesPanel({
  activeTemplateId,
  onTemplateChange,
  templateParams,
  onTemplateParamsChange,
  background,
  onBackgroundChange,
  hasPhoto,
  otherPhotoCount,
  onApplyToOthers,
  palette,
}: {
  activeTemplateId: string;
  onTemplateChange: (templateId: string) => void;
  templateParams: Record<string, unknown>;
  onTemplateParamsChange: (next: Record<string, unknown>) => void;
  background: TemplateBackground;
  onBackgroundChange: (next: TemplateBackground) => void;
  hasPhoto: boolean;
  otherPhotoCount: number;
  onApplyToOthers: (scope: TemplateApplyScope) => void;
  palette: PhotoPaletteState;
}) {
  const templateSchema = getBuiltinTemplateSchema(activeTemplateId);

  if (!hasPhoto) {
    return (
      <BusinessWorkbenchPropertiesPane>
        <ScrollArea className="min-h-0 flex-1">
          <p className="px-3 py-3 text-xs leading-6 text-muted-foreground">
            导入图片后即可调整这张照片的模板、参数与背景。
          </p>
        </ScrollArea>
      </BusinessWorkbenchPropertiesPane>
    );
  }

  return (
    <BusinessWorkbenchPropertiesPane>
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y divide-border/60">
          <TemplateSelector
            activeTemplateId={activeTemplateId}
            onTemplateChange={onTemplateChange}
          />
          {templateSchema ? (
            <CoPanelSection
              variant="flat"
              title="模板参数"
              description="每个模板有自己的可调项，换了模板就会回到新模板的默认值。"
            >
              <div className="space-y-3">
                <TemplatePropsPanel
                  schema={templateSchema}
                  value={templateParams}
                  onChange={onTemplateParamsChange}
                />
                {otherPhotoCount > 0 ? (
                  <ApplyToOthersButton
                    label="模板与参数应用到其他"
                    count={otherPhotoCount}
                    onClick={() => onApplyToOthers('template')}
                  />
                ) : null}
              </div>
            </CoPanelSection>
          ) : null}
          <CoPanelSection
            variant="flat"
            title="背景"
            description="起始值随模板变化，可按当前照片单独调整。"
          >
            <div className="space-y-3">
              <TemplatePropsPanel
                schema={{ fields: TEMPLATE_BACKGROUND_FIELDS }}
                value={background}
                onChange={(next) => onBackgroundChange(toTemplateBackground(next))}
                extras={{
                  // 主题色盘只挂在颜色字段下：该字段本身只在纯色模式可见
                  color: (
                    <PhotoPalettePicker
                      colors={palette.colors}
                      selected={background.color}
                      loading={palette.loading}
                      failed={palette.failed}
                      onPick={(color) => onBackgroundChange({ ...background, color })}
                    />
                  ),
                }}
              />
              {otherPhotoCount > 0 ? (
                <ApplyToOthersButton
                  label="背景应用到其他"
                  count={otherPhotoCount}
                  onClick={() => onApplyToOthers('background')}
                />
              ) : null}
            </div>
          </CoPanelSection>
          <CoPanelSection variant="flat" title="EXIF 信息">
            <TemplateExifCard />
          </CoPanelSection>
        </div>
      </ScrollArea>
    </BusinessWorkbenchPropertiesPane>
  );
}

/** 去掉扩展名，作为导出文件名主干。 */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 预设 → 导出管线参数：目标框由 sizeAdapter 解算，这里只带格式、画质与元数据开关。 */
function buildExportOptions(profile: ExportPresetProfile): ExportOptions {
  return {
    presets: [
      {
        id: profile.id,
        // 宽高与倍率不参与模板解算：自动命名用 sizeAdapter 实际命中的目标框
        width: 0,
        height: 0,
        scale: 1,
        format: profile.format,
        quality: profile.quality,
      },
    ],
    dpi: 72,
    preserveExif: profile.includeExif,
    stripGps: profile.includeExif && profile.stripGps,
  };
}

/**
 * 构造模板导出上下文。
 *
 * 尺寸适配器在抓图前就地解算预设的「图像调整尺寸」：探针测量与 `applyRenderSize`
 * 必须连续执行（见 `resolveExportSizeTarget` 的说明），返回实际命中的目标框供
 * 自动命名。背景按目标照片自己的配置解算——批量导出时每张图的画框语义可能不同。
 *
 * 预览根节点以参数传入：解算发生在抓图前一刻，必须读到最新的 `previewRef.current`。
 */
function createRunContext(
  previewRef: RefObject<HTMLDivElement | null>,
  name: string | undefined,
  outputDir: string | null,
  profile: ExportPresetProfile,
  photoBackground: TemplateBackground,
): ExportRunContext {
  return {
    baseName: name ? stripExtension(name) : undefined,
    outputDir,
    conflict: profile.conflict,
    sizeAdapter: {
      prepare: async () => {
        const element = previewRef.current;
        if (!element) {
          throw new Error('预览未就绪，无法解算导出尺寸');
        }
        const target = resolveExportSizeTarget(element, photoBackground, profile.sizing);
        if (!target) {
          throw new Error('照片尚未加载完成，无法解算导出尺寸');
        }
        applyRenderSize(element, photoBackground, target);
        await waitForDomStability();
        return target;
      },
    },
  };
}

export function TemplatePage() {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const { photos, currentIndex, setCurrentIndex, currentPhoto } = usePhotos();
  // 模板、参数与背景都取自当前照片自己的配置
  const config = useTemplatePhotoConfig(currentPhoto?.id);
  const setTemplate = useTemplateStore((state) => state.setTemplate);
  const setParams = useTemplateStore((state) => state.setParams);
  const setBackground = useTemplateStore((state) => state.setBackground);
  const applyToOthers = useTemplateStore((state) => state.applyToOthers);
  const prune = useTemplateStore((state) => state.prune);
  // 拖入的照片可能还没进会话：按路径懒导入
  const { ensureByPath } = usePhotoImportByPath();
  // 导出期间挂起预览自适应，否则它会覆盖导出解算出的 --co-base
  const [capturing, setCapturing] = useState(false);
  /**
   * 进行中的导出：挂在所属预设行上显示进度 + 可取消的任务 id。
   *
   * 导出入口在「导出」面板的预设行（拖照片 / 行内按钮），状态放页面级，
   * 保证转圈、进度与禁用是同一份；`taskId` 由调度器创建后回填（见
   * `runScheduledExports`），取消走它。
   */
  const [exportRun, setExportRun] = useState<ExportPresetRunState | null>(null);
  /** 拖入的照片尚未导入时挂起的任务；会话列表更新后由下方 effect 接手 */
  const [pendingDrop, setPendingDrop] = useState<{
    profile: ExportPresetProfile;
    path: string;
  } | null>(null);
  const otherPhotoCount = Math.max(photos.length - (currentPhoto ? 1 : 0), 0);

  // 素材被移除后回收它的配置；prune 在无变化时返回原 state，不会引起额外渲染
  useEffect(() => {
    prune(photos.map((photo) => photo.id));
  }, [photos, prune]);

  const palette = usePhotoPalette(currentPhoto);

  /**
   * 纯色背景的默认色。
   *
   * 首次在某张照片上进入纯色模式时，直接把照片的第一个主题色写进背景色：用户不必
   * 点色盘就已经拿到主色调。颜色一旦不等于默认值（说明用户自己挑过），或这张照片
   * 已经补过一次，就不再介入，避免覆盖用户的选择。
   */
  const paletteAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    const photoId = currentPhoto?.id;

    // 导出期间不写配置：批量导出会逐张切换照片，此时必须让导出严格按各自配置渲染
    if (capturing || !photoId) {
      return;
    }

    if (palette.colors.length === 0 || paletteAppliedRef.current === photoId) {
      return;
    }

    if (
      config.background.mode !== 'color' ||
      config.background.color !== DEFAULT_TEMPLATE_BACKGROUND.color
    ) {
      return;
    }

    paletteAppliedRef.current = photoId;
    setBackground(photoId, { ...config.background, color: palette.colors[0] });
  }, [capturing, currentPhoto?.id, palette.colors, config.background, setBackground]);

  const handleApplyToOthers = (scope: TemplateApplyScope) => {
    if (!currentPhoto || otherPhotoCount === 0) {
      return;
    }

    applyToOthers(
      photos.map((photo) => photo.id),
      currentPhoto.id,
      scope,
    );
    toast.success(`已把${APPLY_SCOPE_LABELS[scope]}应用到其余 ${otherPhotoCount} 张照片`);
  };

  /**
   * 启动一次导出：`indexes` 是待导出的照片下标（当前 / 拖拽 / 全部同一条路径）。
   *
   * 逐张切换预览并按各自配置渲染；输出目录、冲突策略与元数据开关都来自预设。
   * 单张失败只跳过该张，不中断整批。
   *
   * memo 成稳定引用给下方挂起导出的 effect 当依赖；闭包只读 ref 与模块级函数，
   * 变化信号（会话列表、当前下标、任务状态）都在 deps 里。
   */
  const beginRun = useCallback(
    (profile: ExportPresetProfile, indexes: number[]) => {
      const items = indexes.flatMap((index) => {
        const photo = photos[index];
        return photo ? [{ index, photo }] : [];
      });
      if (exportRun !== null || items.length === 0) {
        return;
      }

      setExportRun({ presetId: profile.id, completed: 0, total: items.length, taskId: null });

      void (async () => {
        const originalIndex = currentIndex;
        setCapturing(true);
        let skipped = 0;
        let exported = 0;
        let lastDir: string | null = null;

        try {
          const finishedTaskId = await runScheduledExports({
            items,
            onTaskCreated: (taskId) => setExportRun((prev) => (prev ? { ...prev, taskId } : prev)),
            onProgress: (completed, total) =>
              setExportRun((prev) => (prev ? { ...prev, completed, total } : prev)),
            runner: async ({ index, photo }) => {
              try {
                // 先切到目标照片，预览会按它自己的模板与参数重渲染
                if (index !== originalIndex) {
                  setCurrentIndex(index);
                  await new Promise((resolve) => setTimeout(resolve, 120));
                }
                // EXIF 未就绪就抓图，模板里的机型与拍摄参数会是空的
                await ensurePhotoExif(photo);
                const element = previewRef.current;
                if (!element) {
                  return;
                }
                await waitForImages(element);
                await prepareElementForSnapshot(element);
                const outputDir = await resolveProfileOutputDir(profile, photo.path);
                await exportSingle(
                  element,
                  buildExportOptions(profile),
                  photo.path,
                  createRunContext(
                    previewRef,
                    photo.name,
                    outputDir,
                    profile,
                    getTemplatePhotoConfig(photo.id).background,
                  ),
                );
                lastDir = outputDir;
                exported += 1;
              } catch (error) {
                skipped += 1;
                console.warn('照片导出失败:', photo.name, error);
              }
            },
          });

          // 取消在两张照片之间生效，这里给出明确反馈（当前那张已导出完成）
          if (getExportTaskState(finishedTaskId)?.cancelled) {
            toast.info('已取消批量导出');
          }
          if (skipped > 0) {
            toast.warning(`${skipped} 张照片导出失败，已跳过`);
          }
          if (exported > 0) {
            notifyExportedDirectory(lastDir);
          }
        } catch (error) {
          notifyExportFailed(error);
        } finally {
          setCapturing(false);
          setCurrentIndex(originalIndex);
          setExportRun(null);
        }
      })();
    },
    [currentIndex, exportRun, photos, setCurrentIndex],
  );

  /** 导出面板入口：把触发方式翻译成照片下标序列，交给 beginRun。 */
  const handleExportTrigger = (profile: ExportPresetProfile, trigger: ExportPresetTrigger) => {
    if (exportRun !== null) {
      return;
    }

    if (trigger.kind === 'all') {
      beginRun(
        profile,
        photos.map((_, index) => index),
      );
      return;
    }

    if (trigger.kind === 'single') {
      if (currentPhoto) {
        beginRun(profile, [currentIndex]);
      }
      return;
    }

    // 拖入的照片可能还没进会话：先挂起，懒导入把列表更新后由下方 effect 接手
    const found = photos.findIndex(
      (photo) => photo.id === trigger.path || photo.path === trigger.path,
    );
    if (found >= 0) {
      beginRun(profile, [found]);
    } else {
      setPendingDrop({ profile, path: trigger.path });
      void ensureByPath(trigger.path);
    }
  };

  // 懒导入完成（会话照片列表变化）后接手挂起的拖拽导出；挂起任务清空即刻返回
  useEffect(() => {
    if (!pendingDrop) {
      return;
    }
    const index = photos.findIndex(
      (photo) => photo.id === pendingDrop.path || photo.path === pendingDrop.path,
    );
    if (index < 0) {
      return;
    }
    const { profile } = pendingDrop;
    setPendingDrop(null);
    beginRun(profile, [index]);
  }, [pendingDrop, photos, beginRun]);

  /** 取消进行中的导出：置位后调度器在下一张照片前停下。 */
  const handleCancelExport = () => {
    if (exportRun?.taskId) {
      cancelExportTask(exportRun.taskId);
    }
  };

  return (
    <CoFileSourceWorkbench
      routeKey="/template"
      header={<TemplateHeader />}
      workspace={
        <BusinessWorkbenchWorkspace>
          <div className="flex h-full w-full min-h-0 min-w-0 items-center justify-center">
            <TemplatePreview
              templateId={config.templateId}
              params={config.params}
              background={config.background}
              previewRef={previewRef}
              suspendAutoFit={capturing}
            />
          </div>
        </BusinessWorkbenchWorkspace>
      }
      properties={() => (
        <TemplatePropertiesPanel
          activeTemplateId={config.templateId}
          onTemplateChange={(templateId) => {
            if (currentPhoto) {
              setTemplate(currentPhoto.id, templateId);
            }
          }}
          templateParams={config.params}
          onTemplateParamsChange={(next) => {
            if (currentPhoto) {
              setParams(currentPhoto.id, next);
            }
          }}
          background={config.background}
          onBackgroundChange={(next) => {
            if (currentPhoto) {
              setBackground(currentPhoto.id, next);
            }
          }}
          hasPhoto={currentPhoto !== null}
          otherPhotoCount={otherPhotoCount}
          onApplyToOthers={handleApplyToOthers}
          palette={palette}
        />
      )}
      export={() => (
        <CoExportPresetPanel
          run={exportRun}
          singleLabel="导出当前照片"
          showExportAll
          disabled={!currentPhoto}
          onExport={handleExportTrigger}
          onCancel={handleCancelExport}
        />
      )}
    />
  );
}
