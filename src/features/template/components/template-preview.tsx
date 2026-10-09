import { ImageIcon, LayoutTemplate } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { TemplateBackground } from '@/features/template/background';
import {
  applyRenderSize,
  type PreviewSizeIntent,
  resolvePreviewSizeTarget,
} from '@/features/template/lib/render-size';
import { TemplateRuntime } from '@/features/template/runtime';
import { resolveBuiltinTemplate } from '@/features/template/runtime/template-registry';
import { useElementSize } from '@/shared/hooks/use-element-size';
import { usePhotos } from '@/shared/hooks/use-photos';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { usePhotoExif } from '../hooks/use-photo-exif';
import { TemplateBackgroundFrame } from './template-background-frame';

type TemplateZoomMode = 'fit' | 50 | 100 | 200;

const ZOOM_OPTIONS: TemplateZoomMode[] = ['fit', 50, 100, 200];

/** 模板内照片元素的句柄；预览靠它对齐「照片原始宽度」并等待图片加载。 */
const PHOTO_SELECTOR = '[data-co-photo]';

interface TemplatePreviewProps {
  templateId: string;
  /** 当前用户参数，渲染前由 TemplateRuntime 按模板自己的 schema 兜底归一 */
  params: Record<string, unknown>;
  background: TemplateBackground;
  previewRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * 画布与预览视口之间的留白（px）。
 *
 * 画框按比例 contain 进预览区（不再铺满），四周统一留出边距：无背景时给描边与投影
 * 留余量，有背景时让画框不贴边。同一个值既要作为滚动内容的 padding，又要从视口尺寸
 * 里扣掉才是可用区，两边必须同源，因此不写成 Tailwind 的 `p-*`，避免改了类名忘了改解算。
 */
const PREVIEW_GUTTER = 16;

export function TemplatePreview({
  templateId,
  params,
  background,
  previewRef,
}: TemplatePreviewProps) {
  const { currentPhoto } = usePhotos();
  const { exif } = usePhotoExif(currentPhoto);
  const [zoomMode, setZoomMode] = useState<TemplateZoomMode>('fit');
  // 照片加载完成的纪元：推进它即可让自适应重算一次
  const [imageEpoch, setImageEpoch] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewport = useElementSize(viewportRef);

  const template = resolveBuiltinTemplate(templateId);

  /**
   * 影响渲染尺寸的全部输入。
   *
   * 这些值不直接参与测量计算，但任何一个变化都必须重新自适应；
   * 作为指纹既表达了这层真实依赖，也避免同一状态下重复测量。
   */
  const fitKey = [
    'fit',
    zoomMode,
    templateId,
    currentPhoto?.id ?? '',
    imageEpoch,
    `${Math.round(viewport.width)}x${Math.round(viewport.height)}`,
    JSON.stringify(background),
    JSON.stringify(params),
  ].join('|');

  /**
   * 等待照片加载完成。
   *
   * 画布高宽比由照片真实比例决定：占位比例（`useImageAspect` 的 fallback）下解算出的
   * 尺寸会偏；缩放档位更必须先知道照片原始像素宽度才能反解。图片就绪后推进纪元，
   * 自适应随之重算一次。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 模板或照片切换会换掉照片元素，必须重新挂监听；纪元变化则用于重挂一次
  useLayoutEffect(() => {
    const image = previewRef?.current?.querySelector<HTMLImageElement>(PHOTO_SELECTOR);
    if (!image || image.naturalWidth > 0) {
      return;
    }

    const handleLoad = () => setImageEpoch((value) => value + 1);
    image.addEventListener('load', handleLoad, { once: true });
    return () => image.removeEventListener('load', handleLoad);
  }, [previewRef, templateId, currentPhoto?.id, imageEpoch]);

  /**
   * 预览自适应：直接改写画框尺寸与 `--co-frame` / `--co-base`，不叠加任何 CSS transform。
   *
   * 可用区取滚动视口扣掉留白后的内容盒，与滚动内容的 padding 完全一致；
   * 目标框由 `resolvePreviewSizeTarget` 解算，画布高度由内容比例决定，
   * 所以先探针量一次比例，再线性反解出基准。整个过程在 paint 之前完成，探针值不会被看到。
   */
  useLayoutEffect(() => {
    const element = previewRef?.current;
    if (!element) {
      return;
    }

    if (element.dataset.fitKey === fitKey) {
      return;
    }

    const available = {
      width: viewport.width - PREVIEW_GUTTER * 2,
      height: viewport.height - PREVIEW_GUTTER * 2,
    };
    if (available.width <= 0 || available.height <= 0) {
      return;
    }

    const intent: PreviewSizeIntent =
      zoomMode === 'fit' ? { kind: 'fit' } : { kind: 'photoPercent', percent: zoomMode };
    const target = resolvePreviewSizeTarget(element, background, intent, available);

    // 目标框暂时量不出来（照片未加载）时保持原尺寸，等 load 推进纪元后再算
    if (!target || !applyRenderSize(element, background, target)) {
      return;
    }

    element.dataset.fitKey = fitKey;
  }, [fitKey, previewRef, background, zoomMode, viewport.width, viewport.height]);

  if (!currentPhoto) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 text-center text-muted-foreground">
        <LayoutTemplate className="size-14 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">边框水印预览</h1>
          <p className="mt-2 text-sm leading-6">
            从左侧文件来源点选一张图片，或直接把图片拖进来，
            <br />
            这里会显示真实模板渲染结果。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center">
      <div className="relative flex min-h-0 w-full flex-1">
        <ScrollArea
          viewportRef={viewportRef}
          scrollbarOrientation="both"
          className="min-h-0 w-full flex-1"
        >
          <div
            className="box-border flex items-center justify-center"
            style={{
              padding: PREVIEW_GUTTER,
              // 最小尺寸等于视口：装得下时居中，装不下时随内容一起增长而不是被裁掉。
              // 向下取整，避免亚像素让滚动区凭空多出 1px 而出现滚动条
              minWidth: Math.floor(viewport.width),
              minHeight: Math.floor(viewport.height),
            }}
          >
            {/*
              画框描边与投影只作预览提示，画在快照目标之外，不会进入导出结果。
              有背景时画框以背景自身为边界（背景已与留白区分），不再叠描边。
            */}
            <div
              className={background.mode === 'none' ? 'shadow-xl ring-1 ring-foreground/15' : ''}
            >
              <div ref={previewRef}>
                <TemplateBackgroundFrame background={background} photoUrl={currentPhoto.previewUrl}>
                  <TemplateRuntime
                    templateId={templateId}
                    photoUrl={currentPhoto.previewUrl}
                    exif={exif}
                    params={params}
                  />
                </TemplateBackgroundFrame>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>

      <div className="flex w-full items-center justify-between gap-4 border-t border-border/80 px-4 py-2 text-xs text-muted-foreground">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{currentPhoto.name}</p>
          <p>{(currentPhoto.size / 1024 / 1024).toFixed(1)} MB</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {ZOOM_OPTIONS.map((option) => {
            const active = zoomMode === option;

            return (
              <Button
                key={option.toString()}
                variant={active ? 'default' : 'outline'}
                size="sm"
                onClick={() => setZoomMode(option)}
              >
                {option === 'fit' ? '适应' : `${option}%`}
              </Button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <ImageIcon className="size-3.5" />
          <span>{template.meta.name}</span>
        </div>
      </div>
    </div>
  );
}
