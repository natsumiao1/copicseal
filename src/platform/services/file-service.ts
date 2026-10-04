import type { FileAdapter } from '@/platform/contracts/file';
import type { FileServiceContract } from '@/platform/contracts/platform';

export class FileService implements FileServiceContract {
  constructor(private readonly adapter: FileAdapter) {}

  readImageFile = (path: string) => this.adapter.readImageFile(path);
  writeBinaryFile = (path: string, contents: number[]) =>
    this.adapter.writeBinaryFile(path, contents);
  listImageFilesInDirectory = (path: string) => this.adapter.listImageFilesInDirectory(path);
  listSubdirectories = (path: string) => this.adapter.listSubdirectories(path);
  listRootDirectories = () => this.adapter.listRootDirectories();
  listFolderImages = (path: string) => this.adapter.listFolderImages(path);
  ensureBrowseThumbnail = (path: string, cacheDir: string) =>
    this.adapter.ensureBrowseThumbnail(path, cacheDir);
  importImageToCache = (path: string, cacheDir: string) =>
    this.adapter.importImageToCache(path, cacheDir);
  importImageBytesToCache = (name: string, contents: number[], cacheDir: string) =>
    this.adapter.importImageBytesToCache(name, contents, cacheDir);
  getCacheOverview = (cacheDir: string) => this.adapter.getCacheOverview(cacheDir);
  clearCache = (
    cacheDir: string,
    scope?: 'all' | 'thumbnails' | 'previews',
    keepPaths?: readonly string[],
  ) => this.adapter.clearCache(cacheDir, scope, keepPaths);
  cleanupCache = (cacheDir: string, maxAgeDays: number, keepPaths?: readonly string[]) =>
    this.adapter.cleanupCache(cacheDir, maxAgeDays, keepPaths);
}

export type {
  BrowseThumbnailMeta,
  CacheCleanupResult,
  CachedImageMeta,
  CacheOverview,
  DirectoryNode,
  FolderImageFile,
  ImageFileMeta,
  RootDirectory,
} from '@/platform/contracts';
