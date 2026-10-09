mod comark;
mod config;
mod db;
mod exif;
mod font;
mod fs;
mod menu;
mod system;
mod tags;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let thumbnail_scheduler = fs::create_thumbnail_scheduler();

    tauri::Builder::default()
        .manage(thumbnail_scheduler)
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DATABASE_URL, db::migrations())
                .build(),
        )
        .setup(|app| {
            let config = config::get_config(app.handle().clone()).unwrap_or_default();
            if config.cache.auto_cleanup_on_startup {
                let _ = fs::auto_cleanup_cache(&config.cache.directory, config.cache.max_age_days);
            }
            // 导出目录可能还没被创建过（默认目录是新建的，或者用户刚改过），
            // 先建出来，这样「打开」按钮和导出完成提示里的目录链接立刻可用
            let _ = std::fs::create_dir_all(&config.output.default_path);
            window::apply_main_window_frame_mode(app.handle(), &config.window_frame_mode)?;
            // macOS 系统菜单栏（应用 / 编辑 / 视图 + 设置快捷键）；其他平台无菜单
            #[cfg(target_os = "macos")]
            menu::setup_menu(app)?;

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            fs::read_image_file,
            fs::list_image_files_in_directory,
            fs::list_subdirectories,
            fs::list_root_directories,
            fs::list_folder_images,
            fs::ensure_browse_thumbnail,
            fs::clear_browse_thumbnail,
            fs::move_to_trash,
            fs::write_file,
            fs::convert_heic_to_jpeg,
            fs::import_image_to_cache,
            fs::import_image_bytes_to_cache,
            fs::get_cache_overview,
            fs::clear_cache,
            fs::cleanup_cache,
            fs::path_exists,
            fs::open_directory,
            config::get_config,
            config::update_config,
            config::get_device_id,
            window::apply_window_frame_mode,
            comark::list_comark_templates,
            comark::upsert_comark_template,
            comark::remove_comark_template,
            comark::set_comark_template_enabled,
            exif::read_exif,
            exif::extract_jpeg_exif,
            exif::insert_jpeg_exif,
            exif::strip_exif_gps,
            exif::strip_image_exif,
            tags::read_image_tags,
            font::list_system_fonts,
            system::get_app_info,
            menu::sync_view_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
