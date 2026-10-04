import * as tauriApi from './tauri/api';

/**
 * The only host access point in the application. Services consume this runtime facade.
 * 产品仅交付 Tauri 桌面形态，这里直接暴露 Tauri API，不再做宿主切换。
 */
export const platformRuntime: typeof tauriApi = tauriApi;

/** 读取原图 EXIF，`source` 为本地文件路径（缓存副本或原文件）。 */
export async function readExifSource(source: string) {
  return platformRuntime.readExif(source);
}
