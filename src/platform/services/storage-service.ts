import type { StorageServiceContract } from '@/platform/contracts/platform';
import { getConfig, listSystemFonts, updateConfig } from '@/platform/providers/tauri/api';

/**
 * 配置与系统字体的实现：直接绑定宿主命令封装。
 *
 * 与 `file-service` 同理，多宿主时期的 adapter 中转层已移除，
 * `StorageServiceContract` 仍是业务与宿主的唯一边界。
 */
export const storageService: StorageServiceContract = {
  getConfig,
  updateConfig,
  listSystemFonts,
};

export type {
  AppConfig,
  CacheConfig,
  ComarkTemplateRecord,
  FontInfo,
  TemplateListConfig,
  TemplatePreset,
  UpsertComarkTemplatePayload,
  UserDevice,
} from '@/platform/contracts';
