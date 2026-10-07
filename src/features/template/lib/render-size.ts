import type { ExportSizing } from '@/shared/types/export';
import { resolveFrameAspect, type TemplateBackground } from '../background';

/** 探针基准：仅用于量出画布几何与照片宽度，随后会被解算结果覆盖。 */
const PROBE_BASE = 1000;

/** 模板内照片元素的句柄；预览靠它对齐「照片原始宽度」并等待图片加载。 */
const PHOTO_SELECTOR = '[data-co-photo]';

export interface RenderTarget {
  width: number;
  height: number;
}

/** 一次探针量到的几何。画布与照片都是 `--co-base` 的倍数，因此一次测量即可线性反解。 */
export interface RenderProbe {
  /** 探针基准下的画布宽度 */
  canvasWidth: number;
  /** 探针基准下的画布高度 */
  canvasHeight: number;
  /** 模板内照片元素的布局宽度；量不到时为 0 */
  photoWidth: number;
  /** 照片的原始像素宽度（`naturalWidth`）；未加载时为 0 */
  photoPixelWidth: number;
}

function getFrameElement(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-co-frame]');
}

function getCanvasElement(root: HTMLElement): HTMLElement | null {
  const box = root.querySelector<HTMLElement>('[data-co-canvas-box]');
  const canvas = box?.firstElementChild;
  return canvas instanceof HTMLElement ? canvas : null;
}

function getPhotoElement(root: HTMLElement): HTMLImageElement | null {
  return root.querySelector<HTMLImageElement>(PHOTO_SELECTOR);
}

/**
 * 非侵入地量一次画布高宽比（高 / 宽）。
 *
 * 比例与 `--co-base` 无关（几何全是基准的倍数），直接读当前布局即可，
 * **不写探针基准**——预览「适应」档走这条路，探针的临时尺寸不会闪进预览。
 * 返回 null 表示画布此刻还没挂载或量不出有效尺寸。
 */
function measureCanvasAspect(root: HTMLElement): number | null {
  const canvas = getCanvasElement(root);
  if (!canvas) {
    return null;
  }

  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const aspect = height / width;
  return Number.isFinite(aspect) && aspect > 0 ? aspect : null;
}

/**
 * 在给定基准下量一次渲染几何。
 *
 * 写入 `--co-base` 会立即触发布局，因此调用方必须处在 paint 之前的 layout effect 里，
 * 探针值不会被看到。返回 null 表示画布尚未可测量。
 */
function probeRenderGeometry(root: HTMLElement, base: number): RenderProbe | null {
  root.style.setProperty('--co-base', `${base}px`);

  const canvas = getCanvasElement(root);
  if (!canvas) {
    return null;
  }

  const canvasWidth = canvas.offsetWidth;
  const canvasHeight = canvas.offsetHeight;
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return null;
  }

  const photo = getPhotoElement(root);

  return {
    canvasWidth,
    canvasHeight,
    photoWidth: photo?.offsetWidth ?? 0,
    photoPixelWidth: photo?.naturalWidth ?? 0,
  };
}

/** 画布高宽比（高 / 宽）；比例与基准无关，探针量一次即可。 */
function canvasAspectOf(probe: RenderProbe): number {
  return probe.canvasHeight / probe.canvasWidth;
}

/** contain 反解：让画布在可用区内等比放下，主导轴精确命中。 */
function solveBase(aspect: number, availableWidth: number, availableHeight: number): number {
  return Math.round(Math.min(availableWidth, availableHeight / aspect));
}

/**
 * 把渲染区调整到目标尺寸。
 *
 * 无背景：画框贴合画布，目标尺寸只作 contain 约束，主导轴精确命中，
 * 另一轴按画布比例推导（1280×720 + 方形画布会得到 720×720）。
 *
 * 有背景：画框精确等于目标尺寸，画布在扣除内边距后的内容盒内 contain，
 * 剩余空间由背景填充（1280×720 依旧是 1280×720）。
 *
 * 全程只写 `--co-frame` / `--co-base` 与画框的像素尺寸（画框属框架层，
 * 不受"模板内禁止绝对单位"的约束）。返回 false 表示 DOM 尚未可测量。
 */
export function applyRenderSize(
  root: HTMLElement,
  background: TemplateBackground,
  target: RenderTarget,
): boolean {
  const frame = getFrameElement(root);
  if (!frame) {
    return false;
  }

  if (background.mode === 'none') {
    frame.style.width = '';
    frame.style.height = '';
    root.style.removeProperty('--co-frame');

    const probe = probeRenderGeometry(root, PROBE_BASE);
    if (!probe) {
      return false;
    }

    const base = solveBase(canvasAspectOf(probe), target.width, target.height);
    root.style.setProperty('--co-base', `${base}px`);
    return true;
  }

  frame.style.width = `${target.width}px`;
  frame.style.height = `${target.height}px`;
  root.style.setProperty('--co-frame', `${target.width}px`);

  // 内边距统一以画框宽度为基准，竖直方向也不依赖画框高度
  const contentWidth = target.width * (1 - background.paddingHorizontal * 2);
  const contentHeight = target.height - target.width * background.paddingVertical * 2;
  if (contentWidth <= 0 || contentHeight <= 0) {
    return false;
  }

  const probe = probeRenderGeometry(root, contentWidth);
  if (!probe) {
    return false;
  }

  const base = solveBase(canvasAspectOf(probe), contentWidth, contentHeight);
  root.style.setProperty('--co-base', `${base}px`);
  return true;
}

/**
 * 由探针结果解算出「照片按原始宽度百分之多少显示」所需的目标框。
 *
 * 百分比是相对照片原始像素宽度定义的：100 即 1:1。画布几何全是 `--co-base` 的倍数，
 * 所以先量出照片宽度与画布宽度的比例，再换算成命中目标像素数所需的画布宽。
 * 有背景时目标框就是画框（背景铺满这块框）：画框比例优先取「画框比例」的手动覆盖值，
 * 自动时反推为刚好包住画布与内边距的比例；再按该比例做内边距展开，预览里照片与
 * 内边距的相对关系就与导出一致。
 *
 * 返回 null 表示照片原始宽度还未知，或背景参数（内边距 / 画框比例）已经不可能装下画布。
 */
export function derivePhotoPercentTarget(
  probe: RenderProbe,
  background: TemplateBackground,
  percent: number,
): RenderTarget | null {
  if (probe.photoPixelWidth <= 0) {
    return null;
  }

  // 模板没渲染出照片元素时退回以画布宽度对齐原图宽度，保证任何模板下基准都确定
  const unitWidth = probe.photoWidth > 0 ? probe.photoWidth : probe.canvasWidth;
  const canvasWidth = ((percent / 100) * probe.photoPixelWidth * probe.canvasWidth) / unitWidth;
  if (canvasWidth <= 0) {
    return null;
  }

  const canvasHeight = canvasWidth * canvasAspectOf(probe);

  if (background.mode === 'none') {
    return { width: canvasWidth, height: canvasHeight };
  }

  const horizontal = background.paddingHorizontal * 2;
  const vertical = background.paddingVertical * 2;
  if (horizontal >= 1) {
    return null;
  }

  // 自动比例即「画框刚好包住画布与内边距」，与历史公式恒等；手动覆盖优先
  const frameAspect =
    resolveFrameAspect(background) ?? canvasAspectOf(probe) * (1 - horizontal) + vertical;
  if (frameAspect <= vertical) {
    return null;
  }

  const frameWidth = Math.max(
    canvasWidth / (1 - horizontal),
    canvasHeight / (frameAspect - vertical),
  );
  return { width: frameWidth, height: frameWidth * frameAspect };
}

/** 预览的取尺寸意图。 */
export type PreviewSizeIntent = { kind: 'fit' } | { kind: 'photoPercent'; percent: number };

/**
 * 解算预览目标框。
 *
 * fit：与导出同源——画框比例的手动覆盖值优先，否则按画布（照片）比例 contain 进
 * 预览可用区，四周留白（letterbox）。预览展示的形状即导出的形状，背景不再铺满预览区。
 *
 * photoPercent：按照片原始像素宽度的百分比反解，见 `derivePhotoPercentTarget`。
 *
 * 返回 null 表示此刻还量不出目标框（画布未挂载、尺寸为 0、照片未加载），调用方应保持原尺寸。
 */
export function resolvePreviewSizeTarget(
  root: HTMLElement,
  background: TemplateBackground,
  intent: PreviewSizeIntent,
  available: RenderTarget,
): RenderTarget | null {
  if (intent.kind === 'fit') {
    if (available.width <= 0 || available.height <= 0) {
      return null;
    }

    // 只读当前布局拿比例，不写探针基准，预览不会闪探针尺寸
    const aspect = resolveFrameAspect(background) ?? measureCanvasAspect(root);
    if (aspect === null) {
      return null;
    }

    const width = Math.min(available.width, available.height / aspect);
    if (!Number.isFinite(width) || width <= 0) {
      return null;
    }

    return { width: Math.floor(width), height: Math.floor(width * aspect) };
  }

  const probe = probeRenderGeometry(root, PROBE_BASE);
  if (!probe) {
    return null;
  }

  return derivePhotoPercentTarget(probe, background, intent.percent);
}

/**
 * 由预设的「图像调整尺寸」解算导出目标框。
 *
 * - `scale`：按照片原始像素的百分比反解（100 即 1:1），与预览的 photoPercent 同源；
 * - `fit`：画框比例的手动覆盖值优先，否则按画布（照片）比例给目标框，主导轴精确
 *   命中给定像素；`noUpscale` 时不越过照片原始像素（有背景时画框即成片尺寸，
 *   主导轴就是输出长 / 宽边）。
 *
 * 探针测量会写入 1000px 的临时基准，因此必须与 `applyRenderSize` 在同一任务里
 * 连续调用（中间不能有 await），否则预览会闪一下探针尺寸。
 * 返回 null 表示照片未加载或画布此刻不可测量。
 */
export function resolveExportSizeTarget(
  root: HTMLElement,
  background: TemplateBackground,
  sizing: ExportSizing,
): RenderTarget | null {
  if (sizing.mode === 'scale') {
    const probe = probeRenderGeometry(root, PROBE_BASE);
    if (!probe) {
      return null;
    }
    return derivePhotoPercentTarget(probe, background, sizing.percent);
  }

  // fit：画框比例手动覆盖优先（无需探针）；自动时回落画布（照片）比例
  let aspect = resolveFrameAspect(background);
  if (aspect === null) {
    const probe = probeRenderGeometry(root, PROBE_BASE);
    if (!probe) {
      return null;
    }
    aspect = canvasAspectOf(probe);
  }
  if (!Number.isFinite(aspect) || aspect <= 0) {
    return null;
  }

  const { axis, px, noUpscale } = sizing;
  let width: number;
  let height: number;

  if (axis === 'width') {
    width = px;
    height = px * aspect;
  } else if (axis === 'height') {
    width = px / aspect;
    height = px;
  } else if (axis === 'long') {
    // 长边命中：aspect ≤ 1 时长边是宽，否则是高
    if (aspect <= 1) {
      width = px;
      height = px * aspect;
    } else {
      width = px / aspect;
      height = px;
    }
  } else if (aspect <= 1) {
    // 短边命中：aspect ≤ 1 时短边是高
    width = px / aspect;
    height = px;
  } else {
    width = px;
    height = px * aspect;
  }

  if (noUpscale) {
    const photo = getPhotoElement(root);
    const naturalWidth = photo?.naturalWidth ?? 0;
    const naturalHeight = photo?.naturalHeight ?? 0;
    if (naturalWidth > 0 && naturalHeight > 0) {
      const shrink = Math.min(naturalWidth / width, naturalHeight / height, 1);
      if (shrink < 1) {
        width *= shrink;
        height *= shrink;
      }
    }
  }

  return { width: Math.round(width), height: Math.round(height) };
}
