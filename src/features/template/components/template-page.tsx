import { Copy, LayoutTemplate, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { prepareElementForSnapshot, waitForDomStability, waitForImages } from '@/core/renderer';
import { runScheduledExports } from '@/core/scheduler';
import {
  DEFAULT_TEMPLATE_BACKGROUND,
  TEMPLATE_BACKGROUND_FIELDS,
  type TemplateBackground,
  toTemplateBackground,
} from '@/features/template/background';
import { isValidPreset } from '@/features/template/lib/export-preset';
import { applyRenderSize } from '@/features/template/lib/render-size';
import { getBuiltinTemplateSchema } from '@/features/template/runtime/template-registry';
import {
  type ExportOptions,
  type ExportRunContext,
  exportSingle,
  resolveExportDirectory,
} from '@/platform';
import { CoFileSourceWorkbench } from '@/shared/components/co-file-source-workbench';
import {
  notifyExportedDirectory,
  notifyExportFailed,
} from '@/shared/components/co-open-directory-link';
import { CoPanelSection } from '@/shared/components/co-panel-section';
import { CoWindowHeader } from '@/shared/components/co-window-header';
import { usePhotos } from '@/shared/hooks/use-photos';
import {
  BusinessWorkbenchPropertiesPane,
  BusinessWorkbenchWorkspace,
} from '@/shared/layouts/business-workbench';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  PhotoPalettePicker,
  TemplateExifCard,
  TemplateExportPanel,
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

/** 导出动作的两种模式：当前照片 / 全部照片。 */
type ExportMode = 'single' | 'batch';

interface TemplateExportActionsProps {
  /** 正在进行的导出；null 表示空闲，两个按钮都可点 */
  exporting: ExportMode | null;
  /** 档位是否齐备；不齐时禁用导出并提示去补目标宽高 */
  ready: boolean;
  onExport: (mode: ExportMode) => void;
}

function TemplateExportActions({ exporting, ready, onExport }: TemplateExportActionsProps) {
  const busy = exporting !== null || !ready;

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onExport('single')}>
        {exporting === 'single' ? (
          <Loader2 data-icon="inline-start" className="animate-spin" />
        ) : null}
        导出当前
      </Button>
      <Button size="sm" disabled={busy} onClick={() => onExport('batch')}>
        {exporting === 'batch' ? (
          <Loader2 data-icon="inline-start" className="animate-spin" />
        ) : null}
        批量导出
      </Button>
    </div>
  );
}

function TemplateHeader({ exporting, ready, onExport }: TemplateExportActionsProps) {
  return (
    <CoWindowHeader
      icon={LayoutTemplate}
      title="边框水印"
      description="模板渲染与导出"
      actions={<TemplateExportActions exporting={exporting} ready={ready} onExport={onExport} />}
    />
  );
}

/** 一键应用提示里的范围名，与按钮文案保持一致。 */
const APPLY_SCOPE_LABELS: Record<TemplateApplyScope, string> = {
  template: '模板与参数',
  background: '背景',
  presets: '导出档位',
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
  presets,
  onPresetsChange,
  exportReady,
  hasPhoto,
  baseName,
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
  presets: Parameters<typeof TemplateExportPanel>[0]['presets'];
  onPresetsChange: Parameters<typeof TemplateExportPanel>[0]['onPresetsChange'];
  /** 档位是否齐备；导出按钮在顶栏，这里只用它决定要不要提示补目标宽高 */
  exportReady: boolean;
  hasPhoto: boolean;
  /** 当前照片名（不含扩展名），供档位自动命名使用 */
  baseName: string;
  otherPhotoCount: number;
  onApplyToOthers: (scope: TemplateApplyScope) => void;
  palette: PhotoPaletteState;
}) {
  const templateSchema = getBuiltinTemplateSchema(activeTemplateId);

  if (!hasPhoto) {
    return (
      <BusinessWorkbenchPropertiesPane>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-3 py-3">
            <section className="border border-border/80 bg-background/70 px-4 py-4 text-xs leading-6 text-muted-foreground shadow-sm">
              导入图片后即可调整这张照片的模板、参数、背景与导出档位。
            </section>
          </div>
        </ScrollArea>
      </BusinessWorkbenchPropertiesPane>
    );
  }

  return (
    <BusinessWorkbenchPropertiesPane>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-3 py-3">
          <TemplateSelector
            activeTemplateId={activeTemplateId}
            onTemplateChange={onTemplateChange}
          />
          {templateSchema ? (
            <CoPanelSection
              title="模板参数"
              description="每个模板有自己的可调项，换了模板就会回到新模板的默认值。"
              defaultOpen={false}
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
            title="背景"
            description="起始值随模板变化，可按当前照片单独调整。"
            defaultOpen={false}
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
          <CoPanelSection
            title="导出"
            description="每个档位保存一组尺寸和画质设置。没有背景时按比例套用目标尺寸，正方形画面配 1280×720 会导出 720×720；有背景时成片尺寸就是设定的宽高。"
          >
            <div className="space-y-3">
              <TemplateExportPanel
                presets={presets}
                baseName={baseName}
                ready={exportReady}
                onPresetsChange={onPresetsChange}
              />
              {otherPhotoCount > 0 ? (
                <ApplyToOthersButton
                  label="导出档位应用到其他"
                  count={otherPhotoCount}
                  onClick={() => onApplyToOthers('presets')}
                />
              ) : null}
            </div>
          </CoPanelSection>
          <CoPanelSection title="EXIF 信息" defaultOpen={false}>
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

export function TemplatePage() {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const { photos, currentIndex, setCurrentIndex, currentPhoto } = usePhotos();
  // 模板、参数、背景与档位都取自当前照片自己的配置
  const config = useTemplatePhotoConfig(currentPhoto?.id);
  const setTemplate = useTemplateStore((state) => state.setTemplate);
  const setParams = useTemplateStore((state) => state.setParams);
  const setBackground = useTemplateStore((state) => state.setBackground);
  const setPresets = useTemplateStore((state) => state.setPresets);
  const applyToOthers = useTemplateStore((state) => state.applyToOthers);
  const prune = useTemplateStore((state) => state.prune);
  // 导出期间挂起预览自适应，否则它会覆盖导出解算出的 --co-base
  const [capturing, setCapturing] = useState(false);
  // 导出入口在顶栏，状态放页面级，保证按钮的转圈与禁用是同一份
  const [exporting, setExporting] = useState<ExportMode | null>(null);
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

  /**
   * 构造模板导出上下文。
   *
   * 基准读写落在 snapshot 目标元素上：模板几何全部是 `--co-base` 的倍数，
   * 测量用布局尺寸（offsetWidth/offsetHeight），不受任何外层变换影响。
   * 背景按目标照片自己的配置解算——批量导出时每张图的画框语义可能不同。
   */
  const createRunContext = (
    name: string | undefined,
    outputDir: string | null,
    photoBackground: TemplateBackground,
  ): ExportRunContext => ({
    baseName: name ? stripExtension(name) : undefined,
    outputDir,
    sizeAdapter: {
      prepare: async (target) => {
        const element = previewRef.current;
        if (!element) {
          return;
        }
        applyRenderSize(element, photoBackground, target);
        await waitForDomStability();
      },
    },
  });

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

  const handleExportCurrent = async (options: ExportOptions) => {
    if (!previewRef.current) {
      return;
    }

    setCapturing(true);
    try {
      // 直接写到配置里的「保存目录」，不再弹保存对话框
      const outputDir = await resolveExportDirectory();
      await waitForImages(previewRef.current);
      await prepareElementForSnapshot(previewRef.current);
      await exportSingle(
        previewRef.current,
        options,
        currentPhoto?.path,
        createRunContext(currentPhoto?.name, outputDir, config.background),
      );
      notifyExportedDirectory(outputDir);
    } catch (error) {
      notifyExportFailed(error);
    } finally {
      setCapturing(false);
    }
  };

  const handleExportBatch = async (options: ExportOptions) => {
    if (!previewRef.current || photos.length === 0) {
      return;
    }

    const originalIndex = currentIndex;

    setCapturing(true);
    try {
      // 直接写到配置里的「保存目录」，不再弹保存对话框
      const outputDir = await resolveExportDirectory();
      let skipped = 0;
      let exported = 0;

      await runScheduledExports({
        items: photos,
        runner: async (photo, index) => {
          const photoConfig = getTemplatePhotoConfig(photo.id);
          const presets = photoConfig.presets.filter(isValidPreset);
          if (presets.length === 0) {
            skipped += 1;
            return;
          }

          // 先切到目标照片，预览会按它自己的模板与参数重渲染
          setCurrentIndex(index);
          await new Promise((resolve) => setTimeout(resolve, 120));
          // EXIF 未就绪就抓图，模板里的机型与拍摄参数会是空的
          await ensurePhotoExif(photo);
          if (!previewRef.current) {
            return;
          }
          await waitForImages(previewRef.current);
          await prepareElementForSnapshot(previewRef.current);
          await exportSingle(
            previewRef.current,
            { ...options, presets },
            photo.path,
            createRunContext(photo.name, outputDir, photoConfig.background),
          );
          exported += 1;
        },
      });

      if (skipped > 0) {
        toast.warning(`${skipped} 张照片的档位不完整，已跳过`);
      }
      if (exported > 0) {
        notifyExportedDirectory(outputDir);
      }
    } catch (error) {
      notifyExportFailed(error);
    } finally {
      setCapturing(false);
      setCurrentIndex(originalIndex);
    }
  };

  // 两轴必填：无背景时目标框是 contain 约束，有背景时它就是画框尺寸
  const exportReady = config.presets.every(isValidPreset);

  const buildExportOptions = (): ExportOptions => ({
    presets: config.presets,
    dpi: 72,
    preserveExif: true,
  });

  /** 顶栏导出入口：统一在这里组装档位参数并维护进行中的状态。 */
  const handleExport = (mode: ExportMode) => {
    if (exporting !== null || !exportReady) {
      return;
    }

    setExporting(mode);
    void (
      mode === 'single'
        ? handleExportCurrent(buildExportOptions())
        : handleExportBatch(buildExportOptions())
    ).finally(() => setExporting(null));
  };

  return (
    <CoFileSourceWorkbench
      routeKey="/template"
      header={<TemplateHeader exporting={exporting} ready={exportReady} onExport={handleExport} />}
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
          presets={config.presets}
          onPresetsChange={(next) => {
            if (currentPhoto) {
              setPresets(currentPhoto.id, next);
            }
          }}
          exportReady={exportReady}
          hasPhoto={currentPhoto !== null}
          baseName={currentPhoto ? stripExtension(currentPhoto.name) : 'copicseal-export'}
          otherPhotoCount={otherPhotoCount}
          onApplyToOthers={handleApplyToOthers}
          palette={palette}
        />
      )}
    />
  );
}
