import type { Platform } from './contracts/platform';
import { assetService } from './services/asset-service';
import { cacheService } from './services/cache-service';
import { exportService } from './services/export-service';
import { fileService } from './services/file-service';
import { storageService } from './services/storage-service';

/**
 * Application-wide platform facade. Feature code depends on this object only.
 *
 * 产品只交付 Tauri 桌面形态：这里是业务与宿主的唯一边界，没有宿主探测与降级编排，
 * 各能力域直接由 Tauri 实现组装，宿主能力的增减只改 `providers/tauri` 内部实现。
 */
export function createPlatform(): Platform {
  return {
    assets: assetService,
    export: exportService,
    files: fileService,
    storage: storageService,
    cache: cacheService,
  };
}

export const platform = createPlatform();
