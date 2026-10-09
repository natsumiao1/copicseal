import type { FileServiceContract } from '@/platform/contracts/platform';
import {
  cleanupCache,
  clearBrowseThumbnail,
  clearCache,
  ensureBrowseThumbnail,
  getCacheOverview,
  importImageBytesToCache,
  importImageToCache,
  listFolderImages,
  listImageFilesInDirectory,
  listRootDirectories,
  listSubdirectories,
  moveToTrash,
  readImageFile,
  readImageTags,
  stripImageExif,
  writeBinaryFile,
} from '@/platform/providers/tauri/api';

/**
 * 文件与缓存能力的实现：直接绑定宿主命令封装。
 *
 * 产品只有 Tauri 一个宿主，早期为多宿主预留的 adapter 中转层已移除——
 * `FileServiceContract` 仍是业务与宿主的唯一边界，宿主细节只在 `providers/tauri`。
 */
export const fileService: FileServiceContract = {
  readImageFile,
  writeBinaryFile,
  listImageFilesInDirectory,
  listSubdirectories,
  listRootDirectories,
  listFolderImages,
  readImageTags,
  ensureBrowseThumbnail,
  clearBrowseThumbnail,
  moveToTrash,
  stripImageExif,
  importImageToCache,
  importImageBytesToCache,
  getCacheOverview,
  clearCache,
  cleanupCache,
};

export type {
  BrowseThumbnailMeta,
  CacheCleanupResult,
  CachedImageMeta,
  CacheOverview,
  DirectoryNode,
  FolderImageFile,
  ImageFileMeta,
  ImageTags,
  RootDirectory,
} from '@/platform/contracts';
