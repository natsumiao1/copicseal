export type {
  BrowseThumbnailMeta,
  CacheCleanupResult,
  CachedImageMeta,
  CacheOverview,
  DirectoryNode,
  FolderImageFile,
  ImageFileMeta,
  RootDirectory,
} from './index';

import type {
  BrowseThumbnailMeta,
  CacheCleanupResult,
  CachedImageMeta,
  CacheOverview,
  DirectoryNode,
  FolderImageFile,
  ImageFileMeta,
  RootDirectory,
} from './index';

export interface FileAdapter {
  readImageFile(path: string): Promise<ImageFileMeta>;
  writeBinaryFile(path: string, contents: number[]): Promise<void>;
  listImageFilesInDirectory(path: string): Promise<string[]>;
  listSubdirectories(path: string): Promise<DirectoryNode[]>;
  listRootDirectories(): Promise<RootDirectory[]>;
  listFolderImages(path: string): Promise<FolderImageFile[]>;
  ensureBrowseThumbnail(path: string, cacheDir: string): Promise<BrowseThumbnailMeta>;
  importImageToCache(path: string, cacheDir: string): Promise<CachedImageMeta>;
  importImageBytesToCache(
    name: string,
    contents: number[],
    cacheDir: string,
  ): Promise<CachedImageMeta>;
  getCacheOverview(cacheDir: string): Promise<CacheOverview>;
  clearCache(
    cacheDir: string,
    scope?: 'all' | 'thumbnails' | 'previews',
    /** 正在使用的素材路径，清理时保留它们的副本 */
    keepPaths?: readonly string[],
  ): Promise<CacheOverview>;
  cleanupCache(
    cacheDir: string,
    maxAgeDays: number,
    keepPaths?: readonly string[],
  ): Promise<CacheCleanupResult>;
}
