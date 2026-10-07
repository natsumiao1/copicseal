import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { check, type Update } from '@tauri-apps/plugin-updater';
import type {
  AppConfig,
  AppUpdateInfo,
  AppUpdateInstallOptions,
  AppUpdateProgress,
  AppVersion,
  BrowseThumbnailMeta,
  CacheCleanupResult,
  CachedImageMeta,
  CacheOverview,
  ComarkTemplateRecord,
  DirectoryNode,
  ExifData,
  FolderImageFile,
  FontInfo,
  ImageFileMeta,
  ImageTags,
  NativeMenuEvent,
  RootDirectory,
  UpsertComarkTemplatePayload,
  ViewMenuItemState,
  WindowFrameMode,
} from '@/platform/contracts';

export type {
  AppConfig,
  AppUpdateInfo,
  AppUpdateInstallOptions,
  AppUpdateProgress,
  AppVersion,
  BrowseThumbnailMeta,
  CacheCleanupResult,
  CacheConfig,
  CachedImageMeta,
  CacheOverview,
  ComarkTemplateRecord,
  DirectoryNode,
  EnabledTemplate,
  ExifData,
  FolderImageFile,
  FontConfig,
  FontInfo,
  ImageFileMeta,
  ImageTags,
  OutputConfig,
  OutputPreset,
  RootDirectory,
  TemplateListConfig,
  TemplatePreset,
  TemplateRegistry,
  UpsertComarkTemplatePayload,
  UserDevice,
  WindowFrameMode,
} from '@/platform/contracts';

export function readExif(path: string): Promise<ExifData> {
  return invoke('read_exif', { path });
}
export function readImageFile(path: string): Promise<ImageFileMeta> {
  return invoke('read_image_file', { path });
}
export function writeBinaryFile(path: string, contents: number[]): Promise<void> {
  return invoke('write_file', { path, contents });
}
export function listImageFilesInDirectory(path: string): Promise<string[]> {
  return invoke('list_image_files_in_directory', { path });
}
/** 列出目录的直接子目录（不递归、跳过隐藏目录），供文件夹树按需展开。 */
export function listSubdirectories(path: string): Promise<DirectoryNode[]> {
  return invoke('list_subdirectories', { path });
}
/** 文件夹树根节点：用户磁盘 + 系统卷 + 其他磁盘（统一挂在「计算机」下）。 */
export function listRootDirectories(): Promise<RootDirectory[]> {
  return invoke('list_root_directories');
}
/** 列出目录内的受支持图片（路径 + 文件名 + 大小），供文件夹直览使用。 */
export function listFolderImages(path: string): Promise<FolderImageFile[]> {
  return invoke('list_folder_images', { path });
}
/** 批量读取图片的 XMP 标签（星级 / 颜色标签）。 */
export function readImageTags(paths: string[]): Promise<ImageTags[]> {
  return invoke('read_image_tags', { paths });
}
/** 为直览条目按需生成缩略图（直接以原文件为源，不复制原文件）。 */
export function ensureBrowseThumbnail(
  path: string,
  cacheDir: string,
): Promise<BrowseThumbnailMeta> {
  return invoke('ensure_browse_thumbnail', { path, cacheDir });
}
/** 清空直览条目的缩略图缓存，返回是否真的删掉了文件。 */
export function clearBrowseThumbnail(path: string, cacheDir: string): Promise<boolean> {
  return invoke('clear_browse_thumbnail', { path, cacheDir });
}
/** 把文件移入系统回收站（Windows 回收站 / macOS 废纸篓），不做永久删除。 */
export function moveToTrash(path: string): Promise<void> {
  return invoke('move_to_trash', { path });
}
export function listSystemFonts(): Promise<FontInfo[]> {
  return invoke('list_system_fonts');
}
export function getConfig(): Promise<AppConfig> {
  return invoke('get_config');
}
export function updateConfig(config: AppConfig): Promise<void> {
  return invoke('update_config', { config });
}
export function applyWindowFrameMode(mode: WindowFrameMode): Promise<void> {
  return invoke('apply_window_frame_mode', { mode });
}
export function getAppInfo(): Promise<AppVersion> {
  return invoke('get_app_info');
}
export function importImageToCache(path: string, cacheDir: string): Promise<CachedImageMeta> {
  return invoke('import_image_to_cache', { path, cacheDir });
}
export function importImageBytesToCache(
  name: string,
  contents: number[],
  cacheDir: string,
): Promise<CachedImageMeta> {
  return invoke('import_image_bytes_to_cache', { name, contents, cacheDir });
}
export function getCacheOverview(cacheDir: string): Promise<CacheOverview> {
  return invoke('get_cache_overview', { cacheDir });
}
export function clearCache(
  cacheDir: string,
  scope?: 'all' | 'thumbnails' | 'previews',
  keepPaths?: readonly string[],
): Promise<CacheOverview> {
  return invoke('clear_cache', { cacheDir, scope, keepPaths });
}
export function cleanupCache(
  cacheDir: string,
  maxAgeDays: number,
  keepPaths?: readonly string[],
): Promise<CacheCleanupResult> {
  return invoke('cleanup_cache', { cacheDir, maxAgeDays, keepPaths });
}
export function pathExists(path: string): Promise<boolean> {
  return invoke('path_exists', { path });
}
export function openDirectory(path: string): Promise<void> {
  return invoke('open_directory', { path });
}
export function getDeviceId(): Promise<string> {
  return invoke('get_device_id');
}
export function listComarkTemplates(): Promise<ComarkTemplateRecord[]> {
  return invoke('list_comark_templates');
}
export function upsertComarkTemplate(
  payload: UpsertComarkTemplatePayload,
): Promise<ComarkTemplateRecord> {
  return invoke('upsert_comark_template', { payload });
}
export function removeComarkTemplate(id: string): Promise<void> {
  return invoke('remove_comark_template', { id });
}
export function setComarkTemplateEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke('set_comark_template_enabled', { id, enabled });
}
export function extractJpegExif(path: string): Promise<number[]> {
  return invoke('extract_jpeg_exif', { path });
}
export function insertJpegExif(jpegData: number[], exifSegment: number[]): Promise<number[]> {
  return invoke('insert_jpeg_exif', { jpegData, exifSegment });
}

/**
 * 抹掉 EXIF 段里的 GPS 位置信息（删除 IFD0 的 GPSInfo 指针 0x8825）。
 *
 * 结构不符合预期时 Rust 侧原样返回，不会把可读的 EXIF 改坏。
 */
export function stripExifGps(exifSegment: number[]): Promise<number[]> {
  return invoke('strip_exif_gps', { exifSegment });
}

export function onNativeFileDrop(
  handler: Parameters<ReturnType<typeof getCurrentWindow>['onDragDropEvent']>[0],
) {
  if (!isNativeWindowAvailable()) return Promise.resolve(() => undefined);
  return getCurrentWindow().onDragDropEvent(handler);
}
export function isNativeWindowAvailable() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
export function getWindowMaximized() {
  return isNativeWindowAvailable() ? getCurrentWindow().isMaximized() : Promise.resolve(false);
}
export function onWindowResize(handler: () => void) {
  return isNativeWindowAvailable()
    ? getCurrentWindow().onResized(handler)
    : Promise.resolve(() => undefined);
}
export function minimizeWindow() {
  return getCurrentWindow().minimize();
}
export function toggleMaximizeWindow() {
  return getCurrentWindow().toggleMaximize();
}
export function closeWindow() {
  return getCurrentWindow().close();
}
export function openDirectoryDialog() {
  return open({ directory: true, multiple: false });
}
/** 上一次 check() 得到的更新句柄：检查与安装分两步进行，这里保存待安装的更新。 */
let pendingUpdate: Update | null = null;

/** 检查更新；没有新版本时返回 null。检查结果会保留给 installUpdate 使用。 */
export async function checkForUpdate(): Promise<AppUpdateInfo | null> {
  await pendingUpdate?.close().catch(() => undefined);
  pendingUpdate = null;

  const update = await check();
  if (!update) return null;

  pendingUpdate = update;

  return {
    version: update.version,
    current_version: update.currentVersion,
    notes: update.body ?? null,
    date: update.date ?? null,
  };
}

/**
 * 下载并安装待安装的更新。
 *
 * Windows 上安装阶段会由安装器结束并重新拉起应用，因此不会走到 resolve；
 * macOS 上安装完成后需要用户手动重启。
 */
export async function installUpdate(options?: AppUpdateInstallOptions): Promise<void> {
  const update = pendingUpdate ?? (await check());
  if (!update) return;

  pendingUpdate = null;

  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? null;
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength;
    } else {
      return;
    }

    const progress: AppUpdateProgress = {
      downloaded,
      total,
      percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
    };
    options?.onProgress?.(progress);
  });
}
export function toNativeFileUrl(path: string) {
  return isNativeWindowAvailable() ? convertFileSrc(path) : path;
}
export function saveImageDialog(defaultPath: string, extension: string) {
  return save({
    defaultPath,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
}

/** 把当前路由的视图勾选状态同步给系统菜单栏「视图」菜单；无原生菜单的平台由宿主侧空操作。 */
export function syncViewMenu(items: readonly ViewMenuItemState[]): Promise<void> {
  return invoke('sync_view_menu', { items });
}

/**
 * 订阅系统菜单栏事件（视图勾选切换 / 打开设置），返回取消订阅函数。
 *
 * 事件由 Rust 侧 `menu` 模块 emit，事件名与那边的常量保持一致。
 */
export async function onNativeMenuEvent(
  handler: (event: NativeMenuEvent) => void,
): Promise<() => void> {
  const unlistenToggle = await listen<{ id: string; checked: boolean }>(
    'view-menu-toggle',
    (event) => {
      handler({ type: 'viewToggle', id: event.payload.id, checked: event.payload.checked });
    },
  );
  const unlistenSettings = await listen<void>('open-settings', () => {
    handler({ type: 'openSettings' });
  });
  return () => {
    unlistenToggle();
    unlistenSettings();
  };
}
