import type { Platform } from './contracts/platform';
import { platformProvider } from './provider-registry';
import { TauriFileAdapter } from './providers/tauri/tauri-file-adapter';
import { TauriStorageAdapter } from './providers/tauri/tauri-storage-adapter';
import { assetService } from './services/asset-service';
import { cacheService } from './services/cache-service';
import { exportService } from './services/export-service';
import { FileService } from './services/file-service';
import { StorageService } from './services/storage-service';

/** Application-wide platform facade. Feature code depends on this object only. */
export function createPlatform(): Platform {
  const fileService = new FileService(new TauriFileAdapter());
  const storageService = new StorageService(new TauriStorageAdapter());
  return {
    assets: assetService,
    export: exportService,
    files: fileService,
    storage: storageService,
    cache: cacheService,
    capabilities: platformProvider.capabilities,
  };
}

export const platform = createPlatform();
