import type { MenuServiceContract } from '@/platform/contracts/platform';
import { onNativeMenuEvent, syncViewMenu } from '@/platform/providers/tauri/api';

/**
 * 系统菜单栏能力：直接绑定宿主命令与事件封装。
 *
 * 与 `fileService` 同构：业务与宿主的唯一边界是 Contract，
 * 菜单事件的收发细节只在 `providers/tauri`。
 */
export const menuService: MenuServiceContract = {
  syncViewMenu,
  onNativeMenuEvent,
};
