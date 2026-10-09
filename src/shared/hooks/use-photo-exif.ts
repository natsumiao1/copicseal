import { useEffect, useState, useSyncExternalStore } from 'react';
import { type ExifData, readExif } from '@/platform';
import type { ImportedPhoto } from '@/shared/types/photo';

interface PhotoExifState {
  exif: ExifData | null;
  loading: boolean;
}

/**
 * 会话级 EXIF 缓存：预览水印与右侧 EXIF 信息卡片共用同一份读取结果，
 * 避免对同一张图片重复解析。
 */
const exifCache = new Map<string, Promise<ExifData | null>>();

/**
 * 缓存版本号：文件被原地改写（右键去除 EXIF）时自增。
 *
 * `usePhotoExif` 把它当订阅快照用——只删缓存不通知的话，组件不会重新读取，
 * 卡片会一直显示改写前的旧值（切换照片也命中同一份组件状态）。
 */
let exifVersion = 0;
const exifVersionListeners = new Set<() => void>();

function subscribeExifVersion(listener: () => void): () => void {
  exifVersionListeners.add(listener);
  return () => {
    exifVersionListeners.delete(listener);
  };
}

/**
 * 作废某张照片的 EXIF 缓存并通知读取方重新解析。
 *
 * 原图被右键去除 EXIF 后，已入会话的缓存副本也会一并处理；
 * 调它让水印预览与 EXIF 信息卡片立刻拿到改写后的结果。
 */
export function invalidatePhotoExif(photoId: string): void {
  if (!exifCache.delete(photoId)) {
    return;
  }
  exifVersion += 1;
  for (const listener of exifVersionListeners) {
    listener();
  }
}

function resolveExif(photoId: string, source: string): Promise<ExifData | null> {
  const cached = exifCache.get(photoId);
  if (cached) {
    return cached;
  }

  const promise = readExif(source).catch((error) => {
    // 读取失败时移除缓存，切换回该图片时允许重试，同时输出日志便于排查。
    console.warn('[exif] 读取失败:', error);
    exifCache.delete(photoId);
    return null;
  });
  exifCache.set(photoId, promise);
  return promise;
}

/**
 * 按需确保某张照片的 EXIF 已解析完成。
 *
 * 批量导出会连续切换照片，若在 EXIF 就绪前抓图，模板里的机型、光圈、快门
 * 会渲染成空值；因此每张抓图前都要过这一关。结果复用同一份会话缓存。
 */
export function ensurePhotoExif(photo: ImportedPhoto): Promise<ExifData | null> {
  const source = photo.path;
  if (source === undefined || source === '') {
    return Promise.resolve(null);
  }

  return resolveExif(photo.id, source);
}

/** 读取当前图片的 EXIF 信息，含加载状态。 */
export function usePhotoExif(photo: ImportedPhoto | null): PhotoExifState {
  const [state, setState] = useState<PhotoExifState>({ exif: null, loading: false });
  const photoId = photo?.id;
  const source = photo?.path;
  // 缓存被作废（原图被去除 EXIF）时版本号变化，触发下方 effect 重新读取
  const version = useSyncExternalStore(subscribeExifVersion, () => exifVersion);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version 是「EXIF 缓存被作废」的信号，变化时需要重读，效果体内无需引用
  useEffect(() => {
    if (!photoId || source === undefined || source === '') {
      setState({ exif: null, loading: false });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    void resolveExif(photoId, source).then((exif) => {
      if (!cancelled) {
        setState({ exif, loading: false });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [photoId, source, version]);

  return state;
}
