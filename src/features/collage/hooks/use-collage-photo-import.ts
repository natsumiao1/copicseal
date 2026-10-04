import { useCallback, useRef } from 'react';
import { importPhotosViaPaths } from '@/platform/services/asset-service';
import { usePhotos } from '@/shared/hooks/use-photos';

/**
 * 模块级共享（而非 hook 实例级）：懒导入可能同时由预览栏点击、画布落槽、
 * 启动恢复三处触发，各自持有独立 hook 实例时判重会失效，导致同一路径被
 * 并发导入两次、会话里出现同 id 的重复照片。
 */
const inflightImports = new Map<string, Promise<void>>();
const importedPaths = new Set<string>();

/**
 * 文件夹直览的懒导入：条目被「使用」（点击选中、拖入画布、重启回填槽位）时
 * 才把原文件复制进缓存，并以文件路径作为 photo id 加入会话。
 *
 * 路径作为 id 保证跨会话稳定，持久化的画布槽位重启后仍能指向同一张图。
 */
export function useCollagePhotoImport() {
  const { photos, addPhotos, setCurrentIndex } = usePhotos();
  // photos 闭包在 re-render 前是旧的：配合上面的模块级集合做双保险判重
  const photosRef = useRef(photos);
  photosRef.current = photos;

  const ensureByPath = useCallback(
    (path: string): Promise<void> => {
      if (importedPaths.has(path) || photosRef.current.some((photo) => photo.id === path)) {
        return Promise.resolve();
      }

      const existing = inflightImports.get(path);
      if (existing) {
        return existing;
      }

      const task = importPhotosViaPaths([path], {
        onPhotoImported: (photo) => {
          const id = photo.originalPath ?? photo.path;
          importedPaths.add(id);
          addPhotos([{ ...photo, id }]);
        },
      })
        .then(() => {
          inflightImports.delete(path);
        })
        .catch((error) => {
          inflightImports.delete(path);
          console.warn('[collage] 懒导入失败:', path, error);
        });

      inflightImports.set(path, task);
      return task;
    },
    [addPhotos],
  );

  /** 点击直览条目：加入会话（懒导入）并切为当前图片。 */
  const selectByPath = useCallback(
    async (path: string) => {
      const existingIndex = photos.findIndex((photo) => photo.id === path);
      if (existingIndex >= 0) {
        setCurrentIndex(existingIndex);
        return;
      }

      const nextIndex = photos.length;
      await ensureByPath(path);
      setCurrentIndex(nextIndex);
    },
    [ensureByPath, photos, setCurrentIndex],
  );

  return { ensureByPath, selectByPath };
}
