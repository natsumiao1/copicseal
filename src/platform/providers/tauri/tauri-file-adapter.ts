import type { FileAdapter } from '@/platform/contracts/file';
import {
  cleanupCache,
  clearCache,
  ensureBrowseThumbnail,
  getCacheOverview,
  importImageBytesToCache,
  importImageToCache,
  listFolderImages,
  listImageFilesInDirectory,
  listRootDirectories,
  listSubdirectories,
  readImageFile,
  writeBinaryFile,
} from './api';

export class TauriFileAdapter implements FileAdapter {
  readonly readImageFile = readImageFile;
  readonly writeBinaryFile = writeBinaryFile;
  readonly listImageFilesInDirectory = listImageFilesInDirectory;
  readonly listSubdirectories = listSubdirectories;
  readonly listRootDirectories = listRootDirectories;
  readonly listFolderImages = listFolderImages;
  readonly ensureBrowseThumbnail = ensureBrowseThumbnail;
  readonly importImageToCache = importImageToCache;
  readonly importImageBytesToCache = importImageBytesToCache;
  readonly getCacheOverview = getCacheOverview;
  readonly clearCache = clearCache;
  readonly cleanupCache = cleanupCache;
}
