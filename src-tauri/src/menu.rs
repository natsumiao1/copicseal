//! macOS 系统菜单栏：应用菜单（含「设置…」快捷键）、编辑菜单与「视图」菜单。
//!
//! 「视图」菜单勾选七块停靠面板的显隐：勾选清单由前端按当前路由同步
//! （`sync_view_menu`），点击勾选项时 muda 先翻转状态、再派发菜单事件，
//! 这里以 `view-menu-toggle` 事件回流前端应用；「设置…」触发 `open-settings`。
//!
//! 其他平台不装菜单：`sync_view_menu` 为空操作，顶栏「视图」下拉与
//! `Cmd/Ctrl+,` 键盘监听覆盖同样的交互。

use serde::Deserialize;
#[cfg(target_os = "macos")]
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder,
};
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager, Wry};

/// 同步给原生「视图」菜单的一条停靠面板状态。
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewMenuItemInput {
    /// 停靠面板 id。
    pub id: String,
    /// 菜单显示标题。
    pub title: String,
    /// 面板当前是否显示。
    pub checked: bool,
    /// 面板是否可切换（设置页无工作台时为 false，菜单项置灰）。
    pub enabled: bool,
}

/// 菜单回流事件：视图勾选切换。
#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewTogglePayload {
    id: String,
    checked: bool,
}

/// 菜单回流事件名：视图勾选切换（payload `{ id, checked }`）。
#[cfg(target_os = "macos")]
pub const EVENT_VIEW_TOGGLE: &str = "view-menu-toggle";
/// 菜单回流事件名：打开设置页（无 payload）。
#[cfg(target_os = "macos")]
pub const EVENT_OPEN_SETTINGS: &str = "open-settings";
/// 「设置…」菜单项 id。
#[cfg(target_os = "macos")]
const ID_OPEN_SETTINGS: &str = "open-settings";
/// 视图勾选项 id 前缀，后面拼停靠面板 id。
#[cfg(target_os = "macos")]
const ID_VIEW_PREFIX: &str = "view-panel-";

/// 原生「视图」菜单句柄：首次同步按前端清单创建勾选项，之后复用更新。
#[cfg(target_os = "macos")]
pub struct ViewMenuState {
    view_menu: Submenu<Wry>,
    items: Mutex<Vec<CheckMenuItem<Wry>>>,
}

/// 构建并挂载 macOS 系统菜单栏（应用 / 编辑 / 视图），仅在 macOS 调用。
#[cfg(target_os = "macos")]
pub fn setup_menu(app: &mut tauri::App) -> tauri::Result<()> {
    // 「设置…」带 `Cmd/Ctrl+,` 快捷键；个别环境解析失败时退回无快捷键版本
    //（打开设置仍有顶栏 ⚙ 按钮与前端键盘监听兜底）
    let settings = match MenuItemBuilder::new("设置…")
        .id(ID_OPEN_SETTINGS)
        .accelerator("CmdOrCtrl+,")
        .build(app)
    {
        Ok(item) => item,
        Err(error) => {
            println!("[menu] 设置快捷键解析失败，退回无快捷键版本: {error}");
            MenuItemBuilder::new("设置…")
                .id(ID_OPEN_SETTINGS)
                .build(app)?
        }
    };

    let app_menu = SubmenuBuilder::new(app, "可图匠")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // 编辑菜单为 webview 提供标准撤销与剪贴板快捷键（Cmd+Z / Cmd+C 等）
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .build()?;

    // 「视图」菜单先建空壳，勾选项在前端首次 sync 时挂入
    let view_menu = SubmenuBuilder::new(app, "视图").build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu])
        .build()?;
    app.set_menu(menu)?;

    app.manage(ViewMenuState {
        view_menu: view_menu.clone(),
        items: Mutex::new(Vec::new()),
    });

    app.handle().on_menu_event(|handle, event| {
        let id = event.id().0.as_str();
        if id == ID_OPEN_SETTINGS {
            let _ = handle.emit(EVENT_OPEN_SETTINGS, ());
            return;
        }
        let Some(panel_id) = id.strip_prefix(ID_VIEW_PREFIX) else {
            return;
        };
        let state = handle.state::<ViewMenuState>();
        let Ok(items) = state.items.lock() else {
            return;
        };
        // muda 在派发事件前已翻转勾选状态，这里读到的就是点击后的新值
        let Some(item) = items.iter().find(|item| item.id().0 == event.id().0) else {
            return;
        };
        let Ok(checked) = item.is_checked() else {
            return;
        };
        let _ = handle.emit(
            EVENT_VIEW_TOGGLE,
            ViewTogglePayload {
                id: panel_id.to_string(),
                checked,
            },
        );
    });

    Ok(())
}

/// 把当前路由的停靠面板显隐同步给原生「视图」菜单；其他平台没有菜单，空操作。
#[tauri::command]
pub fn sync_view_menu(app: AppHandle, items: Vec<ViewMenuItemInput>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let state = app.state::<ViewMenuState>();
        let mut slot = state
            .items
            .lock()
            .map_err(|_| "视图菜单状态锁已失效".to_string())?;

        if slot.len() != items.len() {
            // 清单数量变化（防御路径）：先从菜单摘除旧项，再整组重建
            for existing in slot.drain(..) {
                let _ = state.view_menu.remove(&existing);
            }
            for input in &items {
                let item = CheckMenuItemBuilder::new(&input.title)
                    .id(format!("{ID_VIEW_PREFIX}{}", input.id))
                    .checked(input.checked)
                    .enabled(input.enabled)
                    .build(&app)
                    .map_err(|error| format!("创建视图菜单项失败: {error}"))?;
                state
                    .view_menu
                    .append(&item)
                    .map_err(|error| format!("挂载视图菜单项失败: {error}"))?;
                slot.push(item);
            }
            return Ok(());
        }

        for (item, input) in slot.iter().zip(items.iter()) {
            item.set_text(&input.title)
                .map_err(|error| format!("更新视图菜单标题失败: {error}"))?;
            item.set_checked(input.checked)
                .map_err(|error| format!("更新视图菜单勾选失败: {error}"))?;
            item.set_enabled(input.enabled)
                .map_err(|error| format!("更新视图菜单可用状态失败: {error}"))?;
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, items);
        Ok(())
    }
}
