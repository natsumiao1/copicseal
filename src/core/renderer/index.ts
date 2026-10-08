export async function waitForDomStability(frameCount = 2) {
  for (let i = 0; i < frameCount; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

export async function prepareElementForSnapshot(element: HTMLElement) {
  if (!element.isConnected) {
    throw new Error('Snapshot target is not mounted');
  }

  await waitForDomStability();
}

function decodeImage(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    image.addEventListener('load', done, { once: true });
    image.addEventListener('error', done, { once: true });
  });
}

/**
 * 按导出实际需要的像素数预先降采样一张图片，返回 data URL。
 *
 * 取像素必须走「fetch 字节 → blob URL → 画布」：直接给 `<img>` 设 `crossOrigin` 重新加载
 * 在 Tauri 的 asset 协议下会静默失败（拿不到 naturalWidth，等于什么也没做），
 * 而 fetch 该协议是可行的（带 Access-Control-Allow-Origin），blob URL 又是同源，
 * 画布不会被污染。返回 null 表示无需降采样或读取失败——调用方保持原样。
 */
async function toCappedDataUrl(
  src: string,
  maxWidth: number,
  maxHeight: number,
): Promise<string | null> {
  if (!src || src.startsWith('data:') || maxWidth <= 0 || maxHeight <= 0) {
    return null;
  }

  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`读取图片失败: ${response.status}`);
  }

  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const image = new Image();
    image.src = objectUrl;
    await decodeImage(image);

    const { naturalWidth, naturalHeight } = image;
    if (naturalWidth <= 0 || naturalHeight <= 0) {
      throw new Error('图片无法解码');
    }

    const ratio = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
    if (ratio >= 1) {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(naturalHeight * ratio));
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法创建画布上下文');
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    console.log(
      `[snapshot] 内联图片降采样 ${naturalWidth}x${naturalHeight} → ${canvas.width}x${canvas.height}`,
    );
    return canvas.toDataURL('image/jpeg', 0.92);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function extractCssUrl(value: string): string | null {
  const match = /url\((['"]?)(.*?)\1\)/.exec(value);
  return match?.[2] ?? null;
}

/** 从 CSS transform 矩阵取缩放幅度：`sqrt(a²+b²)`，旋转不改变像素密度、被自然消掉。 */
function transformScale(value: string): number {
  if (!value || value === 'none') {
    return 1;
  }
  const match = /^matrix\(([^)]+)\)$/.exec(value.trim());
  if (!match) {
    return 1;
  }
  const parts = match[1].split(',').map((item) => Number.parseFloat(item.trim()));
  if (parts.length < 4 || parts.some((item) => !Number.isFinite(item))) {
    return 1;
  }
  return Math.hypot(parts[0], parts[1]);
}

/**
 * 节点相对导出根元素的累积缩放：自身与祖先（至根元素前）的 transform 缩放相乘。
 *
 * 槽位取景 / 自由布局把 `scale(1~3)` 写在 transform 里，它会线性放大照片的实际
 * 像素需求；测量必须把这条链折进来，否则降采样目标会偏小，快照拿不足的栅格去
 * 放大，格内取景的导出结果发糊。
 */
export function elementContentScale(node: Element, root: HTMLElement): number {
  let scale = 1;
  let current: Element | null = node;
  while (current && current !== root) {
    scale *= transformScale(getComputedStyle(current).transform);
    current = current.parentElement;
  }
  return scale;
}

/**
 * 图片按 object-fit 实际绘制出的尺寸（源像素口径）——降采样目标的基准。
 *
 * 输出端真正消耗的像素 = 绘制尺寸 × 倍率。cover 按撑满盒的轴算、contain 按贴合
 * 盒的轴算、fill 即盒子本身；再乘 transform 累积缩放。源像素未知（尚未加载）时
 * 回落盒子尺寸，与历史行为一致。
 */
function paintedImageSize(
  image: HTMLImageElement,
  root: HTMLElement,
  scale: number,
): { width: number; height: number } {
  const factor = Math.max(scale, 1) * elementContentScale(image, root);
  const boxWidth = image.clientWidth;
  const boxHeight = image.clientHeight;
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;

  if (naturalWidth > 0 && naturalHeight > 0 && boxWidth > 0 && boxHeight > 0) {
    const fit = getComputedStyle(image).objectFit;
    if (fit === 'fill') {
      return { width: Math.ceil(boxWidth * factor), height: Math.ceil(boxHeight * factor) };
    }
    const ratio =
      fit === 'contain'
        ? Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight)
        : Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight);
    return {
      width: Math.ceil(naturalWidth * ratio * factor),
      height: Math.ceil(naturalHeight * ratio * factor),
    };
  }

  return { width: Math.ceil(boxWidth * factor), height: Math.ceil(boxHeight * factor) };
}

/**
 * 快照前把照片压到导出实际需要的分辨率，返回还原函数。
 *
 * snapdom 会把每张图片内联成 data URL 塞进 SVG。照片背景会让同一张原图被内联两次
 * （前景 `<img>` + 背景图层），原图较大时整个 SVG 超出 WebKit 的处理上限，
 * 内联的图片会整块丢失，导出结果只剩白板（背景模式为「图片」时必然触发）。
 *
 * 降采样到「实际绘制尺寸（object-fit 盈缩 × transform 取景缩放）× 输出倍率」不会
 * 损失可见画质——这正是导出结果实际用到的像素数——
 * 同时把内联体积压回安全范围。整个过程是尽力而为：任何一步失败都保持原图不动。
 */
export async function capEmbeddedImages(
  element: HTMLElement,
  options: { scale?: number } = {},
): Promise<() => void> {
  const scale = Math.max(options.scale ?? 1, 1);
  const restores: Array<() => void> = [];

  const targets: Array<{
    maxWidth: number;
    maxHeight: number;
    src: string;
    apply: (dataUrl: string) => void;
    restore: () => void;
  }> = [];

  for (const image of Array.from(element.querySelectorAll('img'))) {
    const src = image.currentSrc || image.src;
    const painted = paintedImageSize(image, element, scale);
    targets.push({
      maxWidth: painted.width,
      maxHeight: painted.height,
      src,
      apply: (dataUrl) => {
        image.src = dataUrl;
      },
      restore: () => {
        image.src = src;
      },
    });
  }

  for (const layer of Array.from(element.querySelectorAll<HTMLElement>('[data-co-background]'))) {
    // 背景层几何与模糊都写成 calc(var(--co-frame) …)；快照克隆里那份自定义属性不保证还在，
    // 解析失败会让整层退化成 0×0。这里先固化成解析后的像素值，快照完成再还原。
    // 只认解析成像素的结果：拿到 auto 说明此刻本来就不可用，写进去只会把图层弄塌。
    const computed = getComputedStyle(layer);
    const offsets = [computed.top, computed.right, computed.bottom, computed.left];
    if (offsets.every((value) => value.endsWith('px'))) {
      // inset/filter 都是 React 自己在写的属性，覆盖后必须回写原值。
      // 用 removeProperty 会把 React 那份 calc(...) 一起删掉，图层失去定位退回静态位置，
      // 表现为背景图与画布叠在一起、模糊背景消失。
      const previousInset = layer.style.inset;
      const previousFilter = layer.style.filter;
      layer.style.inset = offsets.join(' ');
      if (computed.filter && computed.filter !== 'none') {
        layer.style.filter = computed.filter;
      }
      restores.push(() => {
        layer.style.inset = previousInset;
        layer.style.filter = previousFilter;
      });
    }

    // 照片背景已改成图层内的 <img>（见 TemplateBackgroundFrame），这里兼容仍用 CSS 背景图的写法
    const src = extractCssUrl(layer.style.backgroundImage || '');
    if (!src) {
      continue;
    }

    targets.push({
      maxWidth: Math.ceil(layer.clientWidth * scale),
      maxHeight: Math.ceil(layer.clientHeight * scale),
      src,
      apply: (dataUrl) => {
        layer.style.backgroundImage = `url("${dataUrl}")`;
      },
      // 同样回写原值而不是 removeProperty
      restore: () => {
        layer.style.backgroundImage = `url("${src}")`;
      },
    });
  }

  await Promise.all(
    targets.map(async (target) => {
      try {
        const dataUrl = await toCappedDataUrl(target.src, target.maxWidth, target.maxHeight);
        if (!dataUrl) {
          return;
        }

        target.apply(dataUrl);
        restores.push(target.restore);
      } catch (error) {
        console.warn('[snapshot] 图片降采样失败，改用原图:', error);
      }
    }),
  );

  return () => {
    for (const restore of restores.reverse()) {
      try {
        restore();
      } catch {
        // 还原失败不应影响导出结果
      }
    }
  };
}

/**
 * 等待元素内的图片加载完成。
 *
 * 模板画布高度由图片真实比例决定，若在图片就绪前测量，会拿到占位比例
 * 导致解算出的基准偏差，因此导出前必须先过这一关。
 */
export async function waitForImages(element: HTMLElement) {
  const images = Array.from(element.querySelectorAll('img'));

  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }

          const done = () => resolve();
          image.addEventListener('load', done, { once: true });
          image.addEventListener('error', done, { once: true });
        }),
    ),
  );
}
