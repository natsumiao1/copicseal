import { elementContentScale } from '@/core/renderer';
import type { ExportSizing } from '@/shared/types/export';

/**
 * object-fit 盒与源像素的盈缩比（照片密度，单位 = 源像素/盒像素的倒数即 盒/源）。
 *
 * - contain：贴合轴决定密度（letterbox 留白不参与）
 * - 其余（cover / fill 等）：撑满轴决定密度；fill 是逐轴拉伸，取 max 对
 *   「不放大」是保守且正确的口径（两轴都不许超过源像素 ⇔ 密度取大者）
 */
function fitDensity(
  boxWidth: number,
  boxHeight: number,
  naturalWidth: number,
  naturalHeight: number,
  fit: string,
): number {
  const ratioWidth = boxWidth / naturalWidth;
  const ratioHeight = boxHeight / naturalHeight;
  return fit === 'contain' ? Math.min(ratioWidth, ratioHeight) : Math.max(ratioWidth, ratioHeight);
}

/**
 * 画质上限：画布内所有位图按「最紧的一张恰好 1:1」收敛出的导出倍率。
 *
 * 每张照片的输出像素 = 盒子渲染尺寸 × object-fit 盈缩 × 取景 transform 缩放 × 倍率，
 * 倍率超过 `1 / 密度` 即对该张插值放大。取全画布最小值后：需求像素最多的大槽位
 * 照片原样输出（1:1），其余一律真实缩小——这正是「以最大图为基准、小图缩小适配」；
 * 边框 / 间隙 / 文字标注是 CSS 绘制，随倍率重新光栅化，不构成约束。
 *
 * 返回 null 表示没有可测量的照片（空画布 / 尚未加载）。
 */
async function resolveCollageSourceCap(element: HTMLElement): Promise<number | null> {
  let cap = Infinity;

  for (const image of Array.from(element.querySelectorAll('img'))) {
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    const boxWidth = image.clientWidth;
    const boxHeight = image.clientHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
      continue;
    }

    const fit = getComputedStyle(image).objectFit;
    const density =
      fitDensity(boxWidth, boxHeight, naturalWidth, naturalHeight, fit) *
      elementContentScale(image, element);
    if (density > 0) {
      cap = Math.min(cap, 1 / density);
    }
  }

  const backgroundCap = await resolveBackgroundSourceCap(element);
  if (backgroundCap !== null) {
    cap = Math.min(cap, backgroundCap);
  }

  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * 画布背景照片（`background-size: cover`）的 1:1 倍率。
 *
 * 背景也是位图，同样不许被插值放大；尽力而为——无背景 / 解码失败返回 null，
 * 不参与上限也不阻断导出。
 */
async function resolveBackgroundSourceCap(element: HTMLElement): Promise<number | null> {
  // 背景层是「渐变遮罩 + url(...)」混排，正则只取其中的照片
  const url = /url\((['"]?)(.*?)\1\)/.exec(getComputedStyle(element).backgroundImage)?.[2];
  if (!url) {
    return null;
  }

  const image = new Image();
  image.src = url;
  if (!image.complete) {
    await new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    });
  }

  const boxWidth = element.clientWidth;
  const boxHeight = element.clientHeight;
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return null;
  }

  const density = fitDensity(boxWidth, boxHeight, image.naturalWidth, image.naturalHeight, 'cover');
  return density > 0 ? 1 / density : null;
}

/**
 * 预设的「图像调整尺寸」→ 拼图抓图倍率与输出宽高。
 *
 * - `auto`（自动，以原图为基准）：倍率完全由画布位图的源像素算出（见
 *   `resolveCollageSourceCap`）——最紧的一张恰好 1:1、其余缩小适配，量不出
 *   照片（空画布）时按画布渲染尺寸导出。
 * - `scale`：百分比相对画布当前渲染尺寸（预览区变化会随之漂移，属已知缺口）。
 * - `fit`：按画布对应边折算倍率。
 * - `scale` / `fit` 在 `noUpscale` 时以画布位图源像素收敛倍率；量不出照片时
 *   回落「不放大到画布渲染像素之上」的历史口径。
 *
 * 输出宽高仅用于自动命名 `{拼图}@{宽}x{高}`。
 */
export async function resolveCollageSizing(element: HTMLElement, sizing: ExportSizing) {
  const canvasWidth = element.offsetWidth;
  const canvasHeight = element.offsetHeight;
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    throw new Error('画布尚未就绪，无法解算导出尺寸');
  }

  let scale: number;
  if (sizing.mode === 'auto') {
    scale = (await resolveCollageSourceCap(element)) ?? 1;
  } else if (sizing.mode === 'scale') {
    scale = sizing.percent / 100;
    if (sizing.noUpscale) {
      scale = Math.min(scale, (await resolveCollageSourceCap(element)) ?? 1);
    }
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
      scale = Math.min(scale, (await resolveCollageSourceCap(element)) ?? 1);
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
