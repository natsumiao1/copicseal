import type { PlatformProvider } from './contracts';
import { tauriProvider } from './providers/tauri/tauri-platform-provider';

/** 产品仅交付 Tauri 桌面形态，直接绑定唯一 Provider，不做宿主探测。 */
export const platformProvider: PlatformProvider = tauriProvider;

export const platformCapabilities = platformProvider.capabilities;
