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
  ImageTags,
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
  /** 批量读取图片的 XMP 标签（星级 / 颜色标签），供筛选器过滤使用。 */
  readImageTags(paths: string[]): Promise<ImageTags[]>;
  ensureBrowseThumbnail(path: string, cacheDir: string): Promise<BrowseThumbnailMeta>;
  /** 清空直览条目的缩略图缓存（派生数据），返回是否真的删掉了文件。 */
  clearBrowseThumbnail(path: string, cacheDir: string): Promise<boolean>;
  /** 把文件移入系统回收站（Windows 回收站 / macOS 废纸篓），供内容面板右键删除使用。 */
  moveToTrash(path: string): Promise<void>;
  /**
   * 原地去除图片内嵌元数据（EXIF；可选连同内嵌 XMP），供内容面板右键使用。
   * 段 / 块级删除、不重新编码，方向（Orientation）标签保留；
   * 支持 JPEG / PNG / WebP。返回是否真的改写了文件。
   */
  stripImageExif(path: string, removeXmp: boolean): Promise<boolean>;
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

/** 同步给系统菜单栏「视图」菜单的一条停靠面板状态。 */
export interface ViewMenuItemState {
  /** 停靠面板 id。 */
  id: string;
  /** 菜单显示标题。 */
  title: string;
  /** 面板当前是否显示。 */
  checked: boolean;
  /** 面板是否可切换（设置页无工作台时为 false，菜单项置灰）。 */
  enabled: boolean;
}

/** 系统菜单栏回流前端的事件。 */
export type NativeMenuEvent =
  | { type: 'viewToggle'; id: string; checked: boolean }
  | { type: 'openSettings' };

export interface MenuServiceContract {
  /** 把当前路由的视图勾选状态同步给系统菜单栏「视图」菜单；无原生菜单的平台为空操作。 */
  syncViewMenu(items: readonly ViewMenuItemState[]): Promise<void>;
  /** 订阅系统菜单栏事件（视图勾选切换 / 打开设置），返回取消订阅函数。 */
  onNativeMenuEvent(handler: (event: NativeMenuEvent) => void): Promise<() => void>;
}

export interface Platform {
  readonly assets: AssetServiceContract;
  readonly export: ExportServiceContract;
  readonly files: FileServiceContract;
  readonly storage: StorageServiceContract;
  readonly cache: CacheServiceContract;
  readonly menu: MenuServiceContract;
}
