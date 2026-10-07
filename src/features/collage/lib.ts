import type {
  CollageAnnotation,
  CollageAspectPreset,
  CollageCanvasState,
  CollageSlotState,
} from './types';

export const COLLAGE_GRID_UNITS = 12;

export const COLLAGE_RATIO_OPTIONS: Array<{
  label: Exclude<CollageAspectPreset, 'custom'>;
  width: number;
  height: number;
}> = [
  { label: '1:1', width: 1, height: 1 },
  { label: '16:9', width: 16, height: 9 },
  { label: '9:16', width: 9, height: 16 },
  { label: '4:3', width: 4, height: 3 },
  { label: '3:4', width: 3, height: 4 },
  { label: '16:10', width: 16, height: 10 },
];

export function createEmptySlotState(): CollageSlotState {
  return {
    photoId: null,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
    borderRadius: null,
  };
}

export function getDefaultCanvasState(): CollageCanvasState {
  return {
    layoutMode: 'grid',
    aspectPreset: '1:1',
    customRatioWidth: 4,
    customRatioHeight: 5,
    backgroundColor: '#ffffff',
    backgroundImage: null,
    gap: 12,
    padding: 20,
    borderRadius: 18,
    shadow: 18,
    fillMode: 'cover',
    adaptiveFollowContent: true,
  };
}

export function createAnnotation(kind: CollageAnnotation['type']): CollageAnnotation {
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (kind === 'text') {
    return {
      id,
      type: 'text',
      x: 0.12,
      y: 0.12,
      width: 0.22,
      height: 0.1,
      rotation: 0,
      color: '#111827',
      text: '文字',
      fontSize: 20,
    };
  }

  if (kind === 'arrow') {
    return {
      id,
      type: 'arrow',
      x: 0.18,
      y: 0.22,
      width: 0.28,
      height: 0.06,
      rotation: 0,
      color: '#ef4444',
      strokeWidth: 6,
    };
  }

  return {
    id,
    type: kind,
    x: 0.14,
    y: 0.14,
    width: 0.24,
    height: 0.2,
    rotation: 0,
    color: '#ef4444',
    strokeWidth: 4,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 自由比例的安全范围：画布边角把手拖拽与自定义宽:高输入共用，避免极端比例撑爆预览 */
export const MIN_CANVAS_RATIO = 0.2;
export const MAX_CANVAS_RATIO = 5;

export function getAspectRatioValue(canvas: CollageCanvasState): number {
  if (canvas.aspectPreset === 'custom') {
    return Math.max(canvas.customRatioWidth, 1) / Math.max(canvas.customRatioHeight, 1);
  }

  const preset = COLLAGE_RATIO_OPTIONS.find((item) => item.label === canvas.aspectPreset);
  return preset ? preset.width / preset.height : 1;
}

export function getAspectRatioText(canvas: CollageCanvasState): string {
  if (canvas.aspectPreset === 'custom') {
    return `${canvas.customRatioWidth}:${canvas.customRatioHeight}`;
  }

  return canvas.aspectPreset;
}

export async function measureImageAsset(src: string): Promise<{ width: number; height: number }> {
  try {
    const response = await fetch(src);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const result = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return result;
  } catch {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = async () => {
        try {
          await image.decode();
        } catch {
          // ignore decode errors and fall back to natural size
        }
        resolve({
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
        });
      };
      image.onerror = () => reject(new Error('图片尺寸读取失败'));
      image.src = src;
    });
  }
}
