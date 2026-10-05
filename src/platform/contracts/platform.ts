import type { ExportOptions, ExportRunContext } from '@/shared/types/export';
import type { ImportedPhoto } from '@/shared/types/photo';
import type {
  AppConfig,
  BrowseThumbnailMeta,
  CacheCleanupResult,
  CachedImageMeta,
  CacheOverview,
  DirectoryNode,
  FolderImageFile,
  FontInfo,
  ImageFileMeta,
  RootDirectory,
} from './index';
import type { ImportProgressSnapshot } from './services';

export interface AssetServiceContract {
  processDroppedFiles(
    files: FileList | File[],
    options?: ImportPhotoOptions,
  ): Promise<ImportedPhoto[]>;
  clearAssetCaches(): void;
}

export interface ImportPhotoOptions {
  onPhotoImported?: (photo: ImportedPhoto) => void;
  onPhotoUpdated?: (photo: ImportedPhoto) => void;
  onProgress?: (progress: ImportProgressSnapshot) => void;
}

export interface ExportServiceContract {
  exportSingle(
    element: HTMLElement,
    options: ExportOptions,
    sourcePath?: string,
    context?: ExportRunContext,
  ): Promise<void>;
  createExportTask(total: number): string;
  getExportTaskState(
    taskId: string,
  ): { total: number; completed: number; cancelled: boolean } | null;
  cancelExportTask(taskId: string): void;
}

export interface FileServiceContract {
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

export interface StorageServiceContract {
  getConfig(): Promise<AppConfig>;
  updateConfig(config: AppConfig): Promise<void>;
  listSystemFonts(): Promise<FontInfo[]>;
}

export interface CacheServiceContract {
  getThumbnailCache(path: string): string | null;
  setThumbnailCache(path: string, value: string): void;
  clearThumbnailCache(): void;
  getPreviewResourceCache(key: string): string | null;
  setPreviewResourceCache(key: string, value: string): void;
  clearPreviewResourceCache(): void;
}

export interface Platform {
  readonly assets: AssetServiceContract;
  readonly export: ExportServiceContract;
  readonly files: FileServiceContract;
  readonly storage: StorageServiceContract;
  readonly cache: CacheServiceContract;
}
