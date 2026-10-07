use fast_image_resize as fr;
use fr::images::Image as FirImage;
use image::codecs::jpeg::JpegEncoder;
use image::ImageReader;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tauri::State;
use zune_core::bytestream::ZCursor;
use zune_core::colorspace::ColorSpace;
use zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder as ZuneJpegDecoder;

#[cfg(target_os = "windows")]
use windows::core::{Interface, PCWSTR};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::GENERIC_READ;
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat24bppRGB, IWICBitmapFrameDecode, IWICBitmapSource,
    IWICBitmapSourceTransform, IWICImagingFactory, WICBitmapDitherTypeNone,
    WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom, WICBitmapTransformRotate0,
    WICDecodeMetadataCacheOnDemand,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};

const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "heic", "heif", "hif", "webp"];
const IMAGE_DIR_NAME: &str = "images";
const PREVIEW_DIR_NAME: &str = "previews";
const THUMBNAIL_DIR_NAME: &str = "thumbnails";
const THUMBNAIL_SIZE: u32 = 320;
const THUMBNAIL_JPEG_QUALITY: u8 = 82;
// 仅在 Windows 的 WIC 转码路径使用；限定 cfg 以免其它平台判为死代码
#[cfg(target_os = "windows")]
const PREVIEW_JPEG_QUALITY: u8 = 92;
const THUMBNAIL_WORKER_COUNT: usize = 2;

#[derive(Debug, Serialize)]
pub struct ImageMeta {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub ext: String,
    pub mime_type: String,
}

#[derive(Debug, Serialize)]
pub struct CachedImageMeta {
    pub name: String,
    pub original_path: Option<String>,
    pub path: String,
    pub preview_path: String,
    pub thumbnail_path: String,
    pub thumbnail_ready: bool,
    pub size: u64,
    pub ext: String,
    pub mime_type: String,
    /// 原图宽（像素）；解析失败为 0，前端按 3:2 兜底
    pub width: u32,
    /// 原图高（像素）；解析失败为 0，前端按 3:2 兜底
    pub height: u32,
}

#[derive(Debug, Serialize)]
pub struct CacheOverview {
    pub directory: String,
    pub image_count: u64,
    pub preview_count: u64,
    pub thumbnail_count: u64,
    pub image_bytes: u64,
    pub preview_bytes: u64,
    pub thumbnail_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct CacheCleanupResult {
    pub removed_files: u64,
    pub removed_bytes: u64,
}

/// 缩略图适配模式。
///
/// 导入管线的素材条缩略图沿用方形裁剪（Cover）；文件夹直览的缩略图
/// 必须保留原图比例（Contain），由前端按原始宽高定尺寸展示。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThumbFit {
    Cover,
    Contain,
}

#[derive(Debug)]
struct ThumbnailTask {
    source_path: PathBuf,
    thumbnail_path: PathBuf,
    fit: ThumbFit,
}

pub struct ThumbnailTaskScheduler {
    sender: Sender<ThumbnailTask>,
}

impl ThumbnailTaskScheduler {
    pub fn new(worker_count: usize) -> Self {
        let (sender, receiver) = mpsc::channel::<ThumbnailTask>();
        let shared_receiver = Arc::new(Mutex::new(receiver));

        for index in 0..worker_count.max(1) {
            spawn_thumbnail_worker(index, Arc::clone(&shared_receiver));
        }

        Self { sender }
    }

    fn schedule(
        &self,
        source_path: PathBuf,
        thumbnail_path: PathBuf,
        fit: ThumbFit,
    ) -> Result<(), String> {
        self.sender
            .send(ThumbnailTask {
                source_path,
                thumbnail_path,
                fit,
            })
            .map_err(|error| format!("failed to enqueue thumbnail task: {error}"))
    }
}

#[tauri::command]
pub async fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    // 目标目录可能还不存在（用户刚改过导出目录，或首次导出到新目录），先补上；
    // 否则 fs::write 会直接报 "No such file or directory"
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {} 失败: {e}", parent.display()))?;
        }
    }

    fs::write(&path, contents).map_err(|e| format!("写入文件失败: {e}"))
}

#[tauri::command]
pub async fn convert_heic_to_jpeg(input: String) -> Result<String, String> {
    let input_path = Path::new(&input);
    let output_path = input_path.with_extension("jpg");
    convert_heic_to_jpeg_path(input_path, &output_path)?;
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn import_image_to_cache(
    path: String,
    cache_dir: String,
    scheduler: State<'_, ThumbnailTaskScheduler>,
) -> Result<CachedImageMeta, String> {
    let started_at = Instant::now();
    let original_path = path.clone();
    let source_path = Path::new(&path);
    if !source_path.exists() {
        return Err(format!("文件不存在: {}", source_path.display()));
    }

    if !is_supported_image(source_path) {
        return Err(format!("不支持的图片格式: {}", source_path.display()));
    }

    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "无法解析文件名".to_string())?;
    let read_started_at = Instant::now();
    let bytes = fs::read(source_path).map_err(|e| format!("读取图片失败: {e}"))?;
    println!(
        "[thumbnail][import] read source file={} bytes={} elapsed_ms={}",
        source_path.display(),
        bytes.len(),
        read_started_at.elapsed().as_millis()
    );

    let meta = import_bytes_to_cache_impl(
        file_name,
        bytes,
        &cache_dir,
        Some(original_path),
        &scheduler,
    )?;
    println!(
        "[thumbnail][import] import complete file={} ext={} total_elapsed_ms={}",
        source_path.display(),
        meta.ext,
        started_at.elapsed().as_millis()
    );
    Ok(meta)
}

#[tauri::command]
pub async fn import_image_bytes_to_cache(
    name: String,
    contents: Vec<u8>,
    cache_dir: String,
    scheduler: State<'_, ThumbnailTaskScheduler>,
) -> Result<CachedImageMeta, String> {
    import_bytes_to_cache_impl(&name, contents, &cache_dir, None, &scheduler)
}

#[tauri::command]
pub async fn get_cache_overview(cache_dir: String) -> Result<CacheOverview, String> {
    get_cache_overview_impl(&cache_dir)
}

#[tauri::command]
pub async fn clear_cache(
    cache_dir: String,
    scope: Option<String>,
    keep_paths: Option<Vec<String>>,
) -> Result<CacheOverview, String> {
    clear_cache_impl(
        &cache_dir,
        scope.as_deref(),
        keep_paths.as_deref().unwrap_or(&[]),
    )?;
    get_cache_overview_impl(&cache_dir)
}

#[tauri::command]
pub async fn cleanup_cache(
    cache_dir: String,
    max_age_days: u32,
    keep_paths: Option<Vec<String>>,
) -> Result<CacheCleanupResult, String> {
    cleanup_cache_impl(
        &cache_dir,
        max_age_days,
        keep_paths.as_deref().unwrap_or(&[]),
    )
}

#[tauri::command]
pub async fn path_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

#[tauri::command]
pub async fn open_directory(path: String) -> Result<(), String> {
    let directory = Path::new(&path);
    if !directory.exists() {
        return Err(format!("目录不存在: {}", directory.display()));
    }

    if !directory.is_dir() {
        return Err(format!("不是目录: {}", directory.display()));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(directory)
            .spawn()
            .map_err(|e| format!("打开目录失败: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(directory)
            .spawn()
            .map_err(|e| format!("打开目录失败: {e}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(directory)
            .spawn()
            .map_err(|e| format!("打开目录失败: {e}"))?;
    }

    Ok(())
}

/// 启动时的自动清理。
///
/// 此刻还没有任何会话在使用缓存（应用刚起来），因此不需要保留集合。
pub fn auto_cleanup_cache(
    cache_dir: &str,
    max_age_days: u32,
) -> Result<CacheCleanupResult, String> {
    cleanup_cache_impl(cache_dir, max_age_days, &[])
}

/// 读取图片文件元数据
#[tauri::command]
pub async fn read_image_file(path: String) -> Result<ImageMeta, String> {
    let path = Path::new(&path);

    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }

    if !is_supported_image(path) {
        return Err(format!("不支持的格式: {}", path.display()));
    }

    let metadata = fs::metadata(path).map_err(|e| format!("读取文件失败: {e}"))?;

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    Ok(ImageMeta {
        name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string(),
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
        ext: ext.clone(),
        mime_type: mime_type_for_ext(&ext).to_string(),
    })
}

/// 列出目录中的受支持图片文件
#[tauri::command]
pub async fn list_image_files_in_directory(path: String) -> Result<Vec<String>, String> {
    let dir = Path::new(&path);

    if !dir.exists() {
        return Err(format!("目录不存在: {}", dir.display()));
    }

    if !dir.is_dir() {
        return Err(format!("不是目录: {}", dir.display()));
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut paths = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let entry_path = entry.path();

        if entry_path.is_file() && is_supported_image(&entry_path) {
            paths.push(entry_path.to_string_lossy().to_string());
        }
    }

    paths.sort();
    Ok(paths)
}

/// 直览条目的缩略图信息。
///
/// 打开文件夹只枚举路径，直览条目不复制原文件；`thumbnail_path` 指向按需生成的缩略图。
#[derive(Debug, Serialize)]
pub struct BrowseThumbnailMeta {
    pub path: String,
    pub thumbnail_path: String,
    pub thumbnail_ready: bool,
}

/// 文件夹树节点（仅目录，不递归）。
#[derive(Debug, Serialize)]
pub struct DirectoryNode {
    pub name: String,
    pub path: String,
}

/// 文件夹树的根节点（统一挂在「计算机」节点下）。
///
/// `kind` 为 `home`（用户磁盘，用户主目录）、`system`（系统卷，macOS 即
/// Finder 所见的 Macintosh HD）或 `volume`（其他磁盘：macOS 外接卷、Windows 盘符）。
#[derive(Debug, Serialize)]
pub struct RootDirectory {
    pub label: String,
    pub path: String,
    pub kind: String,
}

/// 直览缩略图的缓存键：原文件路径 + 修改时间一起哈希。
///
/// 路径不变则跨会话稳定命中同一份缩略图；文件被改动时换键重新生成，旧的交给按龄清理回收。
/// 用 std 的 `DefaultHasher`：算法变化最坏只会让缓存键整体失效重新生成，不影响正确性。
fn browse_cache_key(source: &Path) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let metadata = fs::metadata(source).map_err(|e| format!("读取文件元数据失败: {e}"))?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| (duration.as_secs(), duration.subsec_nanos()));

    let mut hasher = DefaultHasher::new();
    source.to_string_lossy().hash(&mut hasher);
    mtime.hash(&mut hasher);
    // 版本盐 v2：缩略图开始烘焙 EXIF 方向（竖图不再横放），v1 的横版缓存整体作废，按视口重新生成
    "browse-contain-v2-exif-orient".hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

/// 为直览列表按需生成缩略图：直接以原文件为源，不复制原文件。
///
/// HEIC/HIF 先经 sips / WIC 转成 JPEG 中转文件（按同一缓存键命名，可跨调用复用），
/// 其余格式直接交给缩略图 worker。缩略图已存在时立即返回就绪，不重复排队。
#[tauri::command]
pub async fn ensure_browse_thumbnail(
    path: String,
    cache_dir: String,
    scheduler: State<'_, ThumbnailTaskScheduler>,
) -> Result<BrowseThumbnailMeta, String> {
    let source = Path::new(&path);
    if !source.exists() {
        return Err(format!("文件不存在: {}", source.display()));
    }

    if !is_supported_image(source) {
        return Err(format!("不支持的图片格式: {}", source.display()));
    }

    let root = Path::new(&cache_dir);
    ensure_cache_layout(root)?;

    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let key = browse_cache_key(source)?;
    let thumbnail_path = root.join(THUMBNAIL_DIR_NAME).join(format!("{key}.jpg"));

    if thumbnail_path.exists() {
        return Ok(BrowseThumbnailMeta {
            path,
            thumbnail_path: thumbnail_path.to_string_lossy().to_string(),
            thumbnail_ready: true,
        });
    }

    let worker_source = if matches!(ext.as_str(), "heic" | "heif" | "hif") {
        let bridge = root.join(PREVIEW_DIR_NAME).join(format!("{key}-src.jpg"));
        convert_heic_to_jpeg_path(source, &bridge)?;
        bridge
    } else {
        source.to_path_buf()
    };

    scheduler.schedule(worker_source, thumbnail_path.clone(), ThumbFit::Contain)?;

    Ok(BrowseThumbnailMeta {
        path,
        thumbnail_path: thumbnail_path.to_string_lossy().to_string(),
        thumbnail_ready: false,
    })
}

/// 把图片文件移入系统回收站（Windows 回收站 / macOS 废纸篓），不做永久删除。
///
/// 供内容面板右键删除使用：只受理已存在的普通文件，目录不受理，防止误删整个文件夹。
#[tauri::command]
pub async fn move_to_trash(path: String) -> Result<(), String> {
    let source = Path::new(&path);
    if !source.exists() {
        return Err(format!("文件不存在: {}", source.display()));
    }
    if !source.is_file() {
        return Err(format!("仅支持删除文件: {}", source.display()));
    }

    trash::delete(source).map_err(|error| format!("移入回收站失败: {error}"))?;
    println!("[fs][trash] moved to trash path={}", source.display());
    Ok(())
}

/// 清空直览条目的缩略图缓存，返回是否真的删掉了文件。
///
/// 只清浏览缩略图（派生数据）：导入副本与预览副本是素材会话在用的独立缓存，不动。
/// 删除后由前端同步移除条目状态，下次进入视口即按当前生成逻辑重新生成。
#[tauri::command]
pub async fn clear_browse_thumbnail(path: String, cache_dir: String) -> Result<bool, String> {
    let source = Path::new(&path);
    if !source.exists() {
        return Err(format!("文件不存在: {}", source.display()));
    }

    let root = Path::new(&cache_dir);
    ensure_cache_layout(root)?;

    let key = browse_cache_key(source)?;
    let thumbnail_path = root.join(THUMBNAIL_DIR_NAME).join(format!("{key}.jpg"));
    let removed = if thumbnail_path.exists() {
        fs::remove_file(&thumbnail_path).map_err(|error| format!("删除缩略图缓存失败: {error}"))?;
        true
    } else {
        false
    };

    println!(
        "[fs][cache] clear browse thumbnail path={} removed={}",
        path, removed
    );
    Ok(removed)
}

/// 列出目录的直接子目录：不递归，跳过隐藏目录，按名称排序。供文件夹树按需展开。
#[tauri::command]
pub async fn list_subdirectories(path: String) -> Result<Vec<DirectoryNode>, String> {
    let dir = Path::new(&path);

    if !dir.exists() {
        return Err(format!("目录不存在: {}", dir.display()));
    }

    if !dir.is_dir() {
        return Err(format!("不是目录: {}", dir.display()));
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut nodes = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        if !entry.path().is_dir() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        // 隐藏目录（.git、.Trash 等）对文件夹树没有意义
        if name.starts_with('.') {
            continue;
        }

        nodes.push(DirectoryNode {
            path: entry.path().to_string_lossy().to_string(),
            name,
        });
    }

    nodes.sort_by_key(|node| node.name.to_lowercase());
    Ok(nodes)
}

/// 直览文件内的图片条目：路径 + 文件名 + 大小 + 原始宽高。
///
/// `width`/`height` 供前端按原图比例定尺寸；读取失败时为 0，前端按 1:1 兜底。
#[derive(Debug, Serialize)]
pub struct FolderImageFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub width: u32,
    pub height: u32,
}

/// 列出目录内的受支持图片（不复制原文件），供文件夹直览的图片预览栏使用。
///
/// 与 `list_image_files_in_directory` 的区别：额外返回文件大小，且跳过隐藏文件。
#[tauri::command]
pub async fn list_folder_images(path: String) -> Result<Vec<FolderImageFile>, String> {
    let dir = Path::new(&path);

    if !dir.exists() {
        return Err(format!("目录不存在: {}", dir.display()));
    }

    if !dir.is_dir() {
        return Err(format!("不是目录: {}", dir.display()));
    }

    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut images = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let entry_path = entry.path();
        if !entry_path.is_file() || !is_supported_image(&entry_path) {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        // 隐藏文件（.DS_Store 之外也可能有 .xxx.jpg）在 Finder 里不可见，直览保持一致
        if name.starts_with('.') {
            continue;
        }

        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        let (width, height) = read_image_dimensions(&entry_path).unwrap_or((0, 0));
        images.push(FolderImageFile {
            path: entry_path.to_string_lossy().to_string(),
            name,
            size,
            width,
            height,
        });
    }

    images.sort_by_key(|image| image.name.to_lowercase());
    Ok(images)
}

/// 读取图片宽高（只读文件头，不解码像素）。
///
/// 标准格式走 `image` crate 的头部解析；HEIC/HIF/AVIF 这类 HEIF 容器
/// `image` crate 不支持，改为解析容器里的 `ispe` 空间属性（HEIF 必需属性）。
fn read_image_dimensions(path: &Path) -> Option<(u32, u32)> {
    if let Ok((width, height)) = image::image_dimensions(path) {
        if width > 0 && height > 0 {
            return Some((width, height));
        }
    }

    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if matches!(ext.as_str(), "heic" | "heif" | "hif" | "avif") {
        return read_heif_ispe_dimensions(path);
    }

    None
}

/// 读取 HEIF 容器中 `ispe` 属性的宽高（取面积最大者，多为原始图而非缩略项）。
///
/// 盒子结构：顶层 `meta`(FullBox) → `iprp` → `ipco` → `ispe`(FullBox + width + height)。
fn read_heif_ispe_dimensions(path: &Path) -> Option<(u32, u32)> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();

    // 顶层盒子遍历，定位 meta 的负载范围
    let mut offset = 0u64;
    let meta_start = loop {
        if offset + 8 > file_len {
            return None;
        }
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header).ok()?;
        let size = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let kind = [header[4], header[5], header[6], header[7]];

        let (box_size, header_len) = if size == 1 {
            let mut large = [0u8; 8];
            file.read_exact(&mut large).ok()?;
            (u64::from_be_bytes(large), 16u64)
        } else if size == 0 {
            (file_len - offset, 8u64)
        } else {
            (size, 8u64)
        };

        if box_size < header_len {
            return None;
        }
        if &kind == b"meta" {
            break offset + header_len;
        }
        offset += box_size;
    };

    // meta 负载 = FullBox 版本/flags(4) + 子盒子；异常大的 meta 直接放弃，避免无谓分配
    let meta_payload_start = meta_start.checked_add(4)?;
    if meta_payload_start >= file_len {
        return None;
    }
    let meta_len = (file_len - meta_payload_start).min(32 * 1024 * 1024) as usize;
    let mut buffer = vec![0u8; meta_len];
    file.seek(SeekFrom::Start(meta_payload_start)).ok()?;
    file.read_exact(&mut buffer).ok()?;

    find_ispe_box(&buffer, 0)
}

/// 在盒子序列中查找 `ispe`；遇 `iprp`/`ipco` 递归下钻，取面积最大的结果。
fn find_ispe_box(buffer: &[u8], depth: usize) -> Option<(u32, u32)> {
    if depth > 4 {
        return None;
    }

    let mut best: Option<(u64, (u32, u32))> = None;
    let mut offset = 0usize;

    while offset + 8 <= buffer.len() {
        let size = u32::from_be_bytes([
            buffer[offset],
            buffer[offset + 1],
            buffer[offset + 2],
            buffer[offset + 3],
        ]) as usize;
        let kind = &buffer[offset + 4..offset + 8];

        let (box_size, header_len) = if size == 1 {
            if offset + 16 > buffer.len() {
                break;
            }
            let large = u64::from_be_bytes(
                buffer[offset + 8..offset + 16]
                    .try_into()
                    .map_err(|_| ())
                    .ok()?,
            ) as usize;
            (large, 16usize)
        } else if size == 0 {
            (buffer.len() - offset, 8usize)
        } else {
            (size, 8usize)
        };

        if box_size < header_len || offset + box_size > buffer.len() {
            break;
        }
        let payload = &buffer[offset + header_len..offset + box_size];

        match kind {
            b"ispe" => {
                // FullBox: version/flags(4) + width(4) + height(4)
                if payload.len() >= 12 {
                    let width = u32::from_be_bytes(payload[4..8].try_into().ok()?);
                    let height = u32::from_be_bytes(payload[8..12].try_into().ok()?);
                    if width > 0 && height > 0 {
                        let area = width as u64 * height as u64;
                        if best.is_none_or(|(best_area, _)| area > best_area) {
                            best = Some((area, (width, height)));
                        }
                    }
                }
            }
            b"iprp" | b"ipco" => {
                if let Some(found) = find_ispe_box(payload, depth + 1) {
                    let area = found.0 as u64 * found.1 as u64;
                    if best.is_none_or(|(best_area, _)| area > best_area) {
                        best = Some((area, found));
                    }
                }
            }
            _ => {}
        }

        offset += box_size;
    }

    best.map(|(_, dimensions)| dimensions)
}

/// 文件夹树的根节点：用户磁盘 + 系统卷 + 其他磁盘，前端统一挂在「计算机」下。
///
/// 顺序固定为「用户磁盘 → 系统卷 → 其他磁盘」，macOS 与 Windows 同构：
/// Windows 没有独立的系统卷概念，所有盘符都按 `volume` 返回。
#[tauri::command]
pub async fn list_root_directories() -> Result<Vec<RootDirectory>, String> {
    let mut roots = Vec::new();

    if let Some(home) = dirs::home_dir() {
        roots.push(RootDirectory {
            label: "用户磁盘".to_string(),
            path: home.to_string_lossy().to_string(),
            kind: "home".to_string(),
        });
    }

    #[cfg(target_os = "macos")]
    {
        roots.push(RootDirectory {
            label: system_volume_label("/").unwrap_or_else(|| "Macintosh HD".to_string()),
            path: "/".to_string(),
            kind: "system".to_string(),
        });

        // 外接卷：跳过符号链接——`/Volumes/Macintosh HD` 指向 `/`，
        // 再列一遍会与上面的系统卷重复
        if let Ok(entries) = fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                if entry
                    .file_type()
                    .is_ok_and(|file_type| file_type.is_symlink())
                {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                roots.push(RootDirectory {
                    label: name,
                    path: entry.path().to_string_lossy().to_string(),
                    kind: "volume".to_string(),
                });
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        for letter in 'A'..='Z' {
            let path = format!("{letter}:\\");
            if Path::new(&path).exists() {
                roots.push(RootDirectory {
                    label: format!("{letter}:"),
                    path,
                    kind: "volume".to_string(),
                });
            }
        }
    }

    Ok(roots)
}

/// 读取系统卷的显示名（Finder 里显示的「Macintosh HD」即卷名）。
///
/// 用 `diskutil info <path>` 的 Volume Name 字段；输出跟随系统语言
/// （中文环境下字段名可能是「卷名」），两种前缀都识别。
/// 进程拉起失败或字段缺失时返回 `None`，由调用方回落。
#[cfg(target_os = "macos")]
fn system_volume_label(path: &str) -> Option<String> {
    let output = std::process::Command::new("diskutil")
        .arg("info")
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let line = line.trim();
        for prefix in ["Volume Name:", "卷名:"] {
            if let Some(rest) = line.strip_prefix(prefix) {
                let name = rest.trim();
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
        }
    }
    None
}

fn import_bytes_to_cache_impl(
    original_name: &str,
    contents: Vec<u8>,
    cache_dir: &str,
    original_path: Option<String>,
    scheduler: &ThumbnailTaskScheduler,
) -> Result<CachedImageMeta, String> {
    let started_at = Instant::now();
    let ext = extension_from_name(original_name)?;
    let cache_paths = create_cache_paths(cache_dir, original_name, &ext)?;

    let write_started_at = Instant::now();
    fs::write(&cache_paths.image_path, &contents).map_err(|e| format!("写入缓存文件失败: {e}"))?;
    println!(
        "[thumbnail][import] write cache image file={} ext={} bytes={} elapsed_ms={}",
        cache_paths.image_path.display(),
        ext,
        contents.len(),
        write_started_at.elapsed().as_millis()
    );

    let preview_started_at = Instant::now();
    let preview_path =
        create_preview_asset(&cache_paths.image_path, &cache_paths.preview_path, &ext)?;
    println!(
        "[thumbnail][import] create preview file={} ext={} preview={} elapsed_ms={}",
        cache_paths.image_path.display(),
        ext,
        preview_path.display(),
        preview_started_at.elapsed().as_millis()
    );
    let thumbnail_source = if matches!(ext.as_str(), "heic" | "heif" | "hif") {
        preview_path.as_path()
    } else {
        cache_paths.image_path.as_path()
    };

    scheduler.schedule(
        thumbnail_source.to_path_buf(),
        cache_paths.thumbnail_path.clone(),
        ThumbFit::Cover,
    )?;
    println!(
        "[thumbnail][import] schedule thumbnail source={} target={} elapsed_ms={} total_elapsed_ms={}",
        thumbnail_source.display(),
        cache_paths.thumbnail_path.display(),
        0,
        started_at.elapsed().as_millis()
    );

    // 自适应布局需要照片原始宽高：缓存文件即原文件字节（含 HEIC），头部解析开销可忽略
    let (width, height) = read_image_dimensions(&cache_paths.image_path).unwrap_or((0, 0));

    Ok(CachedImageMeta {
        name: original_name.to_string(),
        original_path,
        path: cache_paths.image_path.to_string_lossy().to_string(),
        preview_path: preview_path.to_string_lossy().to_string(),
        thumbnail_path: cache_paths.thumbnail_path.to_string_lossy().to_string(),
        thumbnail_ready: false,
        size: contents.len() as u64,
        ext: ext.clone(),
        mime_type: mime_type_for_ext(&ext).to_string(),
        width,
        height,
    })
}

fn get_cache_overview_impl(cache_dir: &str) -> Result<CacheOverview, String> {
    let root = Path::new(cache_dir);
    ensure_cache_layout(root)?;

    let (image_count, image_bytes) = collect_dir_stats(&root.join(IMAGE_DIR_NAME))?;
    let (preview_count, preview_bytes) = collect_dir_stats(&root.join(PREVIEW_DIR_NAME))?;
    let (thumbnail_count, thumbnail_bytes) = collect_dir_stats(&root.join(THUMBNAIL_DIR_NAME))?;

    Ok(CacheOverview {
        directory: root.to_string_lossy().to_string(),
        image_count,
        preview_count,
        thumbnail_count,
        image_bytes,
        preview_bytes,
        thumbnail_bytes,
        total_bytes: image_bytes + preview_bytes + thumbnail_bytes,
    })
}

/// 把「正在使用的缓存文件路径」折算成主干集合。
///
/// 缓存里的图片、预览、缩略图共用同一个 `<uuid>-<原名>` 主干，因此拿到正在使用的
/// 那份图片路径，就能连带保住它的预览与缩略图，不必让前端知道三份具体文件名。
fn collect_keep_stems(keep_paths: &[String]) -> HashSet<String> {
    keep_paths
        .iter()
        .filter_map(|path| {
            Path::new(path)
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
        })
        .collect()
}

/// 清空目录，但保留主干命中 `keep_stems` 的文件。
///
/// 这些文件是当前会话里素材的唯一可用副本，删掉会让内存中的素材条目指向不存在的
/// 文件（预览变空白、导出失败），因此清理缓存必须避开它们。
fn reset_dir_keeping(dir: &Path, keep_stems: &HashSet<String>) -> Result<(), String> {
    if keep_stems.is_empty() {
        return reset_dir(dir);
    }

    if !dir.exists() {
        return fs::create_dir_all(dir).map_err(|e| format!("重建缓存目录失败: {e}"));
    }

    for entry in fs::read_dir(dir).map_err(|e| format!("读取缓存目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取缓存目录项失败: {e}"))?;
        let path = entry.path();
        let kept = path
            .file_stem()
            .map(|value| keep_stems.contains(&value.to_string_lossy().to_string()))
            .unwrap_or(false);
        if kept {
            continue;
        }

        let removed = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        removed.map_err(|e| format!("清理缓存文件失败: {e}"))?;
    }

    Ok(())
}

fn clear_cache_impl(
    cache_dir: &str,
    scope: Option<&str>,
    keep_paths: &[String],
) -> Result<(), String> {
    let root = Path::new(cache_dir);
    ensure_cache_layout(root)?;

    let keep_stems = collect_keep_stems(keep_paths);

    match scope.unwrap_or("all") {
        "thumbnails" => reset_dir_keeping(&root.join(THUMBNAIL_DIR_NAME), &keep_stems),
        "previews" => reset_dir_keeping(&root.join(PREVIEW_DIR_NAME), &keep_stems),
        "all" => {
            reset_dir_keeping(&root.join(IMAGE_DIR_NAME), &keep_stems)?;
            reset_dir_keeping(&root.join(PREVIEW_DIR_NAME), &keep_stems)?;
            reset_dir_keeping(&root.join(THUMBNAIL_DIR_NAME), &keep_stems)
        }
        value => Err(format!("不支持的缓存清理范围: {value}")),
    }
}

fn cleanup_cache_impl(
    cache_dir: &str,
    max_age_days: u32,
    keep_paths: &[String],
) -> Result<CacheCleanupResult, String> {
    let root = Path::new(cache_dir);
    ensure_cache_layout(root)?;

    // 正在使用的副本即使「过期」也不能删：它已经不在原目录里可用，删掉等于丢素材
    let keep_stems = collect_keep_stems(keep_paths);

    let max_age_days = max_age_days.max(1);
    let threshold = SystemTime::now()
        .checked_sub(Duration::from_secs(max_age_days as u64 * 24 * 60 * 60))
        .ok_or_else(|| "计算缓存清理时间失败".to_string())?;

    let mut removed_files = 0;
    let mut removed_bytes = 0;

    for dir_name in [IMAGE_DIR_NAME, PREVIEW_DIR_NAME, THUMBNAIL_DIR_NAME] {
        let dir_path = root.join(dir_name);
        for entry in fs::read_dir(&dir_path).map_err(|e| format!("读取缓存目录失败: {e}"))?
        {
            let entry = entry.map_err(|e| format!("读取缓存目录项失败: {e}"))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            let kept = path
                .file_stem()
                .map(|value| keep_stems.contains(&value.to_string_lossy().to_string()))
                .unwrap_or(false);
            if kept {
                continue;
            }

            let metadata = entry
                .metadata()
                .map_err(|e| format!("读取缓存文件元数据失败: {e}"))?;
            let modified_at = metadata
                .modified()
                .or_else(|_| metadata.created())
                .unwrap_or(SystemTime::UNIX_EPOCH);

            if modified_at > threshold {
                continue;
            }

            removed_bytes += metadata.len();
            removed_files += 1;
            fs::remove_file(&path).map_err(|e| format!("删除缓存文件失败: {e}"))?;
        }
    }

    Ok(CacheCleanupResult {
        removed_files,
        removed_bytes,
    })
}

fn create_preview_asset(
    image_path: &Path,
    preview_path: &Path,
    ext: &str,
) -> Result<PathBuf, String> {
    if !matches!(ext, "heic" | "heif" | "hif") {
        return Ok(image_path.to_path_buf());
    }

    #[cfg(target_os = "macos")]
    {
        convert_heic_to_jpeg_path(image_path, preview_path)?;
        Ok(preview_path.to_path_buf())
    }

    #[cfg(target_os = "windows")]
    {
        convert_heic_to_jpeg_path(image_path, preview_path)?;
        Ok(preview_path.to_path_buf())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = preview_path;
        Ok(image_path.to_path_buf())
    }
}

fn create_thumbnail_asset(
    source_path: &Path,
    thumbnail_path: &Path,
    fit: ThumbFit,
) -> Result<(), String> {
    let started_at = Instant::now();

    // 原生加速通道只服务方形裁剪（导入管线）；等比模式必须走通用解码，避免任何裁切
    if fit == ThumbFit::Cover {
        #[cfg(target_os = "macos")]
        if try_create_thumbnail_with_sips(source_path, thumbnail_path).is_ok() {
            println!(
                "[thumbnail][worker] native macos sips source={} target={} elapsed_ms={}",
                source_path.display(),
                thumbnail_path.display(),
                started_at.elapsed().as_millis()
            );
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        if let Ok(thumbnail) = try_create_thumbnail_with_wic(source_path) {
            // WIC 解码不带 EXIF 方向：写盘前按源文件方向转正（方形输出宽高互换后仍相等）
            let thumbnail = bake_thumbnail_orientation(thumbnail, source_path)?;
            let write_started_at = Instant::now();
            let result = write_thumbnail_jpeg(&thumbnail, thumbnail_path);
            println!(
                "[thumbnail][worker] native windows wic source={} target={} write_elapsed_ms={} total_elapsed_ms={}",
                source_path.display(),
                thumbnail_path.display(),
                write_started_at.elapsed().as_millis(),
                started_at.elapsed().as_millis()
            );
            return result;
        }
    }

    let decode_resize_started_at = Instant::now();
    let thumbnail = if is_jpeg_image(source_path) {
        create_thumbnail_from_jpeg(source_path, fit)?
    } else {
        create_thumbnail_from_dynamic_image(source_path, fit)?
    };
    println!(
        "[thumbnail][worker] fallback decode+resize source={} elapsed_ms={}",
        source_path.display(),
        decode_resize_started_at.elapsed().as_millis()
    );

    let write_started_at = Instant::now();
    let result = write_thumbnail_jpeg(&thumbnail, thumbnail_path);
    println!(
        "[thumbnail][worker] fallback write source={} target={} write_elapsed_ms={} total_elapsed_ms={}",
        source_path.display(),
        thumbnail_path.display(),
        write_started_at.elapsed().as_millis(),
        started_at.elapsed().as_millis()
    );
    result
}

fn write_thumbnail_jpeg(thumbnail: &image::RgbImage, thumbnail_path: &Path) -> Result<(), String> {
    let file = File::create(thumbnail_path).map_err(|e| format!("创建缩略图文件失败: {e}"))?;
    let mut encoder = JpegEncoder::new_with_quality(file, THUMBNAIL_JPEG_QUALITY);
    encoder
        .encode_image(thumbnail)
        .map_err(|e| format!("写入 JPEG 缩略图失败: {e}"))
}

/**
 * 读取图片的 EXIF Orientation（1~8）。
 *
 * 缺失、不可读或取值非法时返回 1（正向，无需旋转）。
 */
fn read_exif_orientation(path: &Path) -> u8 {
    let Ok(file) = File::open(path) else {
        return 1;
    };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else {
        return 1;
    };

    for field in exif.fields() {
        if field.tag == exif::Tag::Orientation {
            if let exif::Value::Short(values) = &field.value {
                if let Some(&orientation) = values.first() {
                    if (1..=8).contains(&orientation) {
                        return orientation as u8;
                    }
                }
            }
            return 1;
        }
    }
    1
}

/**
 * 按 EXIF Orientation（1~8）把解码出的像素转成显示方向，返回（像素、新宽、新高）。
 *
 * 相机竖拍常存「横向像素 + 方向标签」（如 `_DSC*.jpg` 的 Orientation=8）；解码器不读标签，
 * 直接缩放会把竖图洗成横图。必须在缩放前转正——目标框的宽高比也来自显示方向。
 * 无需旋转时原样返回，不产生拷贝。
 */
fn apply_exif_orientation(
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    orientation: u8,
) -> (Vec<u8>, u32, u32) {
    if !(2..=8).contains(&orientation) {
        return (pixels, width, height);
    }

    let src_w = width as usize;
    let src_h = height as usize;
    // 5~8 的显示方向宽高互换
    let swap = matches!(orientation, 5..=8);
    let dst_w = if swap { src_h } else { src_w };
    let dst_h = if swap { src_w } else { src_h };
    let mut out = vec![0u8; dst_w * dst_h * 3];

    for dy in 0..dst_h {
        for dx in 0..dst_w {
            // 显示坐标 (dx, dy) 对应的源像素坐标；各方向按 EXIF 规范一一映射
            let (sx, sy) = match orientation {
                2 => (src_w - 1 - dx, dy),
                3 => (src_w - 1 - dx, src_h - 1 - dy),
                4 => (dx, src_h - 1 - dy),
                5 => (dy, dx),
                6 => (dy, src_h - 1 - dx),
                7 => (src_w - 1 - dy, src_h - 1 - dx),
                8 => (src_w - 1 - dy, dx),
                _ => (dx, dy),
            };
            let src_index = (sy * src_w + sx) * 3;
            let dst_index = (dy * dst_w + dx) * 3;
            out[dst_index..dst_index + 3].copy_from_slice(&pixels[src_index..src_index + 3]);
        }
    }

    (out, dst_w as u32, dst_h as u32)
}

/// 按源文件的 EXIF 方向把缩略图缓冲区转正，返回新的缓冲区。
///
/// Windows WIC 通道的调用方；故意不加 cfg——让这段缓冲区处理在 mac 上也参与编译检查，
/// 避免 Windows 侧的类型/签名回归长期无人发现。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn bake_thumbnail_orientation(
    thumbnail: image::RgbImage,
    source_path: &Path,
) -> Result<image::RgbImage, String> {
    let (width, height) = (thumbnail.width(), thumbnail.height());
    let (pixels, width, height) = apply_exif_orientation(
        thumbnail.into_raw(),
        width,
        height,
        read_exif_orientation(source_path),
    );
    image::RgbImage::from_raw(width, height, pixels)
        .ok_or_else(|| "重建缩略图缓冲区失败".to_string())
}

fn create_thumbnail_from_jpeg(
    source_path: &Path,
    fit: ThumbFit,
) -> Result<image::RgbImage, String> {
    let input = fs::read(source_path).map_err(|e| format!("读取 JPEG 缩略图源文件失败: {e}"))?;
    let options = DecoderOptions::new_fast().jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut decoder = ZuneJpegDecoder::new_with_options(ZCursor::new(input.as_slice()), options);
    let decoded = decoder
        .decode()
        .map_err(|e| format!("JPEG 缩略图解码失败: {e}"))?;
    let (width, height) = decoder
        .dimensions()
        .ok_or_else(|| "JPEG 缩略图尺寸解析失败".to_string())?;

    // 缩放前按 EXIF 方向转正：竖图的像素与目标框比例才都来自显示方向
    let (pixels, width, height) = apply_exif_orientation(
        decoded,
        width as u32,
        height as u32,
        read_exif_orientation(source_path),
    );
    resize_rgb8_thumbnail(width, height, pixels, fit)
}

fn create_thumbnail_from_dynamic_image(
    source_path: &Path,
    fit: ThumbFit,
) -> Result<image::RgbImage, String> {
    let image = ImageReader::open(source_path)
        .map_err(|e| format!("打开缩略图源文件失败: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("识别缩略图源文件格式失败: {e}"))?
        .decode()
        .map_err(|e| format!("解码缩略图源文件失败: {e}"))?;
    let rgb = image.to_rgb8();
    let (width, height) = rgb.dimensions();

    // 同 JPEG 路径：缩放前按 EXIF 方向转正（PNG/WebP 多为正向，函数对 1 号方向零开销）
    let (pixels, width, height) = apply_exif_orientation(
        rgb.into_raw(),
        width,
        height,
        read_exif_orientation(source_path),
    );

    resize_rgb8_thumbnail(width, height, pixels, fit)
}

fn resize_rgb8_thumbnail(
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    fit: ThumbFit,
) -> Result<image::RgbImage, String> {
    let src_image = FirImage::from_vec_u8(width, height, pixels, fr::PixelType::U8x3)
        .map_err(|e| format!("创建缩略图源缓冲区失败: {e}"))?;
    let mut resizer = fr::Resizer::new();

    if fit == ThumbFit::Contain {
        // 等比缩放进 THUMBNAIL_SIZE：目标框与源同比例，直接拉伸即无变形、无裁切
        let scale = (THUMBNAIL_SIZE as f32 / (width.max(1) as f32))
            .min(THUMBNAIL_SIZE as f32 / (height.max(1) as f32))
            .min(1.0);
        let target_width = ((width as f32 * scale).round() as u32).max(1);
        let target_height = ((height as f32 * scale).round() as u32).max(1);
        let mut dst_image = FirImage::new(target_width, target_height, fr::PixelType::U8x3);
        let resize_options = fr::ResizeOptions::new()
            .resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
        resizer
            .resize(&src_image, &mut dst_image, Some(&resize_options))
            .map_err(|e| format!("缩略图缩放失败: {e}"))?;
        return image::RgbImage::from_raw(target_width, target_height, dst_image.into_vec())
            .ok_or_else(|| "创建缩略图输出缓冲区失败".to_string());
    }

    let mut dst_image = FirImage::new(THUMBNAIL_SIZE, THUMBNAIL_SIZE, fr::PixelType::U8x3);
    let resize_options = fr::ResizeOptions::new()
        .resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Hamming))
        .fit_into_destination(Some((0.5, 0.5)));
    resizer
        .resize(&src_image, &mut dst_image, Some(&resize_options))
        .map_err(|e| format!("缩略图缩放失败: {e}"))?;

    image::RgbImage::from_raw(THUMBNAIL_SIZE, THUMBNAIL_SIZE, dst_image.into_vec())
        .ok_or_else(|| "创建缩略图输出缓冲区失败".to_string())
}

fn create_thumbnail_asset_atomically(
    source_path: &Path,
    thumbnail_path: &Path,
    fit: ThumbFit,
) -> Result<(), String> {
    let started_at = Instant::now();
    let temp_thumbnail_path = thumbnail_path.with_extension("part.jpg");

    if temp_thumbnail_path.exists() {
        fs::remove_file(&temp_thumbnail_path)
            .map_err(|e| format!("failed to remove temporary thumbnail file: {e}"))?;
    }

    create_thumbnail_asset(source_path, &temp_thumbnail_path, fit)?;

    fs::rename(&temp_thumbnail_path, thumbnail_path).map_err(|e| {
        format!(
            "failed to replace thumbnail file {} -> {}: {e}",
            temp_thumbnail_path.display(),
            thumbnail_path.display()
        )
    })?;

    println!(
        "[thumbnail][worker] atomic replace source={} target={} elapsed_ms={}",
        source_path.display(),
        thumbnail_path.display(),
        started_at.elapsed().as_millis()
    );

    Ok(())
}

fn spawn_thumbnail_worker(index: usize, receiver: Arc<Mutex<Receiver<ThumbnailTask>>>) {
    thread::Builder::new()
        .name(format!("thumbnail-worker-{index}"))
        .spawn(move || loop {
            let task = match receiver.lock() {
                Ok(guard) => guard.recv(),
                Err(_) => return,
            };

            let task = match task {
                Ok(task) => task,
                Err(_) => return,
            };

            if let Err(error) =
                create_thumbnail_asset_atomically(&task.source_path, &task.thumbnail_path, task.fit)
            {
                eprintln!(
                    "generate thumbnail failed for {} -> {}: {}",
                    task.source_path.display(),
                    task.thumbnail_path.display(),
                    error
                );
            }
        })
        .expect("failed to spawn thumbnail worker");
}

pub fn create_thumbnail_scheduler() -> ThumbnailTaskScheduler {
    ThumbnailTaskScheduler::new(THUMBNAIL_WORKER_COUNT)
}

fn convert_heic_to_jpeg_path(input_path: &Path, output_path: &Path) -> Result<(), String> {
    if !input_path.exists() {
        return Err(format!("文件不存在: {}", input_path.display()));
    }

    if output_path.exists() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let started_at = Instant::now();
        let status = std::process::Command::new("sips")
            .args([
                "-s",
                "format",
                "jpeg",
                input_path.to_string_lossy().as_ref(),
                "--out",
                output_path.to_string_lossy().as_ref(),
            ])
            .status()
            .map_err(|e| format!("sips 执行失败: {e}"))?;

        if !status.success() {
            return Err("sips 转换 HEIC 为 JPEG 失败".to_string());
        }

        println!(
            "[thumbnail][heic] sips jpeg preview source={} output={} elapsed_ms={}",
            input_path.display(),
            output_path.display(),
            started_at.elapsed().as_millis()
        );

        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let started_at = Instant::now();
        let image = decode_image_with_wic(input_path).map_err(|error| {
            format!(
                "Windows 无法解码 HEIC/HEIF 图片。请从 Microsoft Store 安装“HEIF 图像扩展”；若图片使用 HEVC 编码，还需安装“HEVC 视频扩展”。WIC 错误: {error}"
            )
        })?;
        let file = File::create(output_path).map_err(|e| format!("创建 JPEG 预览失败: {e}"))?;
        let mut encoder = JpegEncoder::new_with_quality(file, PREVIEW_JPEG_QUALITY);
        encoder
            .encode_image(&image)
            .map_err(|e| format!("写入 JPEG 预览失败: {e}"))?;

        println!(
            "[thumbnail][heic] windows wic jpeg preview source={} output={} elapsed_ms={}",
            input_path.display(),
            output_path.display(),
            started_at.elapsed().as_millis()
        );

        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = output_path;
        Err("当前系统不支持 HEIC 转 JPEG".to_string())
    }
}

fn ensure_cache_layout(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join(IMAGE_DIR_NAME))
        .map_err(|e| format!("创建图片缓存目录失败: {e}"))?;
    fs::create_dir_all(root.join(PREVIEW_DIR_NAME))
        .map_err(|e| format!("创建预览缓存目录失败: {e}"))?;
    fs::create_dir_all(root.join(THUMBNAIL_DIR_NAME))
        .map_err(|e| format!("创建缩略图缓存目录失败: {e}"))?;
    Ok(())
}

fn create_cache_paths(
    cache_dir: &str,
    original_name: &str,
    ext: &str,
) -> Result<CachePaths, String> {
    let root = Path::new(cache_dir);
    ensure_cache_layout(root)?;

    let id = uuid::Uuid::new_v4().to_string();
    let stem = sanitize_stem(
        Path::new(original_name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("image"),
    );
    let file_name = format!("{id}-{stem}.{ext}");

    Ok(CachePaths {
        image_path: root.join(IMAGE_DIR_NAME).join(&file_name),
        preview_path: root.join(PREVIEW_DIR_NAME).join(format!("{id}-{stem}.jpg")),
        thumbnail_path: root
            .join(THUMBNAIL_DIR_NAME)
            .join(format!("{id}-{stem}.jpg")),
    })
}

fn collect_dir_stats(dir: &Path) -> Result<(u64, u64), String> {
    let mut count = 0;
    let mut bytes = 0;

    for entry in fs::read_dir(dir).map_err(|e| format!("读取缓存目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取缓存目录项失败: {e}"))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取缓存文件元数据失败: {e}"))?;
        if metadata.is_file() {
            count += 1;
            bytes += metadata.len();
        }
    }

    Ok((count, bytes))
}

fn reset_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| format!("清理缓存目录失败: {e}"))?;
    }
    fs::create_dir_all(dir).map_err(|e| format!("重建缓存目录失败: {e}"))
}

fn extension_from_name(name: &str) -> Result<String, String> {
    let ext = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    if SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err(format!("不支持的图片格式: {name}"))
    }
}

fn mime_type_for_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "heic" => "image/heic",
        "heif" | "hif" => "image/heif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

fn sanitize_stem(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || char == '-' || char == '_' {
                char
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if sanitized.is_empty() {
        "image".to_string()
    } else {
        sanitized
    }
}

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_jpeg_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_lowercase().as_str(), "jpg" | "jpeg"))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn try_create_thumbnail_with_sips(source_path: &Path, thumbnail_path: &Path) -> Result<(), String> {
    let (source_width, source_height) = get_image_dimensions_with_sips(source_path)?;
    let (target_width, target_height, crop_offset_y, crop_offset_x) =
        calculate_cover_resize(source_width, source_height, THUMBNAIL_SIZE);

    let status = std::process::Command::new("sips")
        .args([
            "-s",
            "format",
            "jpeg",
            "-z",
            &target_height.to_string(),
            &target_width.to_string(),
            "-c",
            &THUMBNAIL_SIZE.to_string(),
            &THUMBNAIL_SIZE.to_string(),
            "--cropOffset",
            &crop_offset_y.to_string(),
            &crop_offset_x.to_string(),
            source_path.to_string_lossy().as_ref(),
            "--out",
            thumbnail_path.to_string_lossy().as_ref(),
        ])
        .status()
        .map_err(|e| format!("sips 生成缩略图失败: {e}"))?;

    if !status.success() {
        return Err("sips 生成缩略图失败".to_string());
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn get_image_dimensions_with_sips(source_path: &Path) -> Result<(u32, u32), String> {
    let output = std::process::Command::new("sips")
        .args([
            "-g",
            "pixelWidth",
            "-g",
            "pixelHeight",
            "-1",
            source_path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| format!("sips 读取图片尺寸失败: {e}"))?;

    if !output.status.success() {
        return Err("sips 读取图片尺寸失败".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut width = None;
    let mut height = None;

    for segment in stdout.split('|') {
        let segment = segment.trim();
        if let Some(value) = segment.strip_prefix("pixelWidth:") {
            width = value.trim().parse::<u32>().ok();
        } else if let Some(value) = segment.strip_prefix("pixelHeight:") {
            height = value.trim().parse::<u32>().ok();
        }
    }

    match (width, height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => Ok((width, height)),
        _ => Err("无法解析 sips 返回的图片尺寸".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn calculate_cover_resize(
    source_width: u32,
    source_height: u32,
    target_size: u32,
) -> (u32, u32, u32, u32) {
    let width_scale = target_size as f64 / source_width.max(1) as f64;
    let height_scale = target_size as f64 / source_height.max(1) as f64;
    let scale = width_scale.max(height_scale);
    let target_width = ((source_width as f64 * scale).ceil() as u32).max(target_size);
    let target_height = ((source_height as f64 * scale).ceil() as u32).max(target_size);
    let crop_offset_x = (target_width.saturating_sub(target_size)) / 2;
    let crop_offset_y = (target_height.saturating_sub(target_size)) / 2;

    (target_width, target_height, crop_offset_y, crop_offset_x)
}

#[cfg(target_os = "windows")]
fn try_create_thumbnail_with_wic(source_path: &Path) -> Result<image::RgbImage, String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| format!("初始化 WIC 失败: {e}"))?;

        struct ComGuard;
        impl Drop for ComGuard {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }

        let _guard = ComGuard;
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("创建 WIC 工厂失败: {e}"))?;
        let wide_path = source_path
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>();
        let decoder = factory
            .CreateDecoderFromFilename(
                PCWSTR(wide_path.as_ptr()),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )
            .map_err(|e| format!("WIC 打开图片失败: {e}"))?;
        let frame = decoder
            .GetFrame(0)
            .map_err(|e| format!("WIC 读取图像帧失败: {e}"))?;

        create_thumbnail_from_wic_frame(&factory, &frame)
            .or_else(|_| create_thumbnail_from_wic_scaler(&factory, &frame))
    }
}

#[cfg(target_os = "windows")]
fn decode_image_with_wic(source_path: &Path) -> Result<image::RgbImage, String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| format!("初始化 WIC 失败: {e}"))?;

        struct ComGuard;
        impl Drop for ComGuard {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }

        let _guard = ComGuard;
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("创建 WIC 工厂失败: {e}"))?;
        let wide_path = source_path
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>();
        let decoder = factory
            .CreateDecoderFromFilename(
                PCWSTR(wide_path.as_ptr()),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )
            .map_err(|e| format!("WIC 打开图片失败: {e}"))?;
        let frame = decoder
            .GetFrame(0)
            .map_err(|e| format!("WIC 读取图像帧失败: {e}"))?;
        let source: IWICBitmapSource = frame
            .cast()
            .map_err(|e| format!("WIC 图像源转换失败: {e}"))?;
        let converter = factory
            .CreateFormatConverter()
            .map_err(|e| format!("创建 WIC 格式转换器失败: {e}"))?;
        converter
            .Initialize(
                &source,
                &GUID_WICPixelFormat24bppRGB,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(|e| format!("初始化 WIC 格式转换器失败: {e}"))?;
        let converter_source: IWICBitmapSource = converter
            .cast()
            .map_err(|e| format!("WIC 格式转换器图像源转换失败: {e}"))?;
        let mut width = 0;
        let mut height = 0;
        converter_source
            .GetSize(&mut width, &mut height)
            .map_err(|e| format!("读取 WIC 图片尺寸失败: {e}"))?;

        let stride = width
            .checked_mul(3)
            .ok_or_else(|| "WIC 图片行宽溢出".to_string())?;
        let buffer_size = stride
            .checked_mul(height)
            .ok_or_else(|| "WIC 图片缓冲区大小溢出".to_string())?;
        let mut buffer = vec![0; buffer_size as usize];
        converter_source
            .CopyPixels(std::ptr::null(), stride, &mut buffer)
            .map_err(|e| format!("WIC 复制图片像素失败: {e}"))?;

        image::RgbImage::from_raw(width, height, buffer)
            .ok_or_else(|| "创建 WIC 图片缓冲区失败".to_string())
    }
}

#[cfg(target_os = "windows")]
fn create_thumbnail_from_wic_frame(
    factory: &IWICImagingFactory,
    frame: &IWICBitmapFrameDecode,
) -> Result<image::RgbImage, String> {
    let transform = frame
        .cast::<IWICBitmapSourceTransform>()
        .map_err(|e| format!("WIC 源变换接口不可用: {e}"))?;

    let (src_width, src_height) = get_wic_source_size(frame)?;
    let crop = build_cover_crop_rect(src_width, src_height);
    let mut target_width = THUMBNAIL_SIZE;
    let mut target_height = THUMBNAIL_SIZE;

    unsafe {
        transform
            .GetClosestSize(&mut target_width, &mut target_height)
            .map_err(|e| format!("WIC 获取最接近缩略图尺寸失败: {e}"))?;
    }

    if target_width == 0 || target_height == 0 {
        return Err("WIC 返回了无效缩略图尺寸".to_string());
    }

    let stride = target_width * 3;
    let mut buffer = vec![0; (stride * target_height) as usize];

    unsafe {
        transform
            .CopyPixels(
                &crop,
                target_width,
                target_height,
                &GUID_WICPixelFormat24bppRGB,
                WICBitmapTransformRotate0,
                stride,
                &mut buffer,
            )
            .map_err(|e| format!("WIC 直接缩放解码失败: {e}"))?;
    }

    image::RgbImage::from_raw(target_width, target_height, buffer)
        .ok_or_else(|| "创建 WIC 缩略图缓冲区失败".to_string())
        .and_then(|image| ensure_thumbnail_canvas(&image))
        .or_else(|_| create_thumbnail_from_wic_scaler(factory, frame))
}

#[cfg(target_os = "windows")]
fn create_thumbnail_from_wic_scaler(
    factory: &IWICImagingFactory,
    frame: &IWICBitmapFrameDecode,
) -> Result<image::RgbImage, String> {
    let source: IWICBitmapSource = frame
        .cast()
        .map_err(|e| format!("WIC 图像源转换失败: {e}"))?;
    let (src_width, src_height) = get_wic_source_size(frame)?;
    let crop = build_cover_crop_rect(src_width, src_height);
    let clipper = unsafe { factory.CreateBitmapClipper() }
        .map_err(|e| format!("创建 WIC 裁切器失败: {e}"))?;

    unsafe {
        clipper
            .Initialize(&source, &crop)
            .map_err(|e| format!("初始化 WIC 裁切器失败: {e}"))?;
    }

    let clipped_source: IWICBitmapSource = clipper
        .cast()
        .map_err(|e| format!("WIC 裁切器图像源转换失败: {e}"))?;
    let scaler =
        unsafe { factory.CreateBitmapScaler() }.map_err(|e| format!("创建 WIC 缩放器失败: {e}"))?;

    unsafe {
        scaler
            .Initialize(
                &clipped_source,
                THUMBNAIL_SIZE,
                THUMBNAIL_SIZE,
                WICBitmapInterpolationModeFant,
            )
            .map_err(|e| format!("初始化 WIC 缩放器失败: {e}"))?;
    }

    let stride = THUMBNAIL_SIZE * 3;
    let mut buffer = vec![0; (stride * THUMBNAIL_SIZE) as usize];

    unsafe {
        let scaler_source: IWICBitmapSource = scaler
            .cast()
            .map_err(|e| format!("WIC 缩放器图像源转换失败: {e}"))?;
        let converter = factory
            .CreateFormatConverter()
            .map_err(|e| format!("创建 WIC 格式转换器失败: {e}"))?;
        converter
            .Initialize(
                &scaler_source,
                &GUID_WICPixelFormat24bppRGB,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(|e| format!("初始化 WIC 格式转换器失败: {e}"))?;
        let converter_source: IWICBitmapSource = converter
            .cast()
            .map_err(|e| format!("WIC 格式转换器图像源转换失败: {e}"))?;
        converter_source
            .CopyPixels(std::ptr::null(), stride, &mut buffer)
            .map_err(|e| format!("WIC 缩放复制像素失败: {e}"))?;
    }

    image::RgbImage::from_raw(THUMBNAIL_SIZE, THUMBNAIL_SIZE, buffer)
        .ok_or_else(|| "创建 WIC 缩略图缓冲区失败".to_string())
}

#[cfg(target_os = "windows")]
fn get_wic_source_size(source: &IWICBitmapFrameDecode) -> Result<(u32, u32), String> {
    let source: IWICBitmapSource = source
        .cast()
        .map_err(|e| format!("WIC 图像源转换失败: {e}"))?;
    let mut width = 0;
    let mut height = 0;

    unsafe {
        source
            .GetSize(&mut width, &mut height)
            .map_err(|e| format!("读取 WIC 图片尺寸失败: {e}"))?;
    }

    Ok((width, height))
}

#[cfg(target_os = "windows")]
fn build_cover_crop_rect(
    src_width: u32,
    src_height: u32,
) -> windows::Win32::Graphics::Imaging::WICRect {
    if src_width == 0 || src_height == 0 {
        return windows::Win32::Graphics::Imaging::WICRect {
            X: 0,
            Y: 0,
            Width: THUMBNAIL_SIZE as i32,
            Height: THUMBNAIL_SIZE as i32,
        };
    }

    let src_ratio = src_width as f64 / src_height as f64;
    let dst_ratio = 1.0_f64;

    if src_ratio > dst_ratio {
        let crop_width = (src_height as f64 * dst_ratio).round() as u32;
        let x = ((src_width - crop_width) / 2) as i32;
        windows::Win32::Graphics::Imaging::WICRect {
            X: x,
            Y: 0,
            Width: crop_width as i32,
            Height: src_height as i32,
        }
    } else {
        let crop_height = (src_width as f64 / dst_ratio).round() as u32;
        let y = ((src_height - crop_height) / 2) as i32;
        windows::Win32::Graphics::Imaging::WICRect {
            X: 0,
            Y: y,
            Width: src_width as i32,
            Height: crop_height as i32,
        }
    }
}

///（Windows WIC 通道）把缩略图补成方形画布；同样不加 cfg，让 `resize_rgb8_thumbnail`
/// 的调用签名在 mac 上也能被检查到（此前 Windows 侧曾因签名变更编译回归无人发现）。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn ensure_thumbnail_canvas(image: &image::RgbImage) -> Result<image::RgbImage, String> {
    if image.width() == THUMBNAIL_SIZE && image.height() == THUMBNAIL_SIZE {
        return Ok(image.clone());
    }

    let resized = resize_rgb8_thumbnail(
        image.width(),
        image.height(),
        image.clone().into_raw(),
        ThumbFit::Cover,
    )?;
    Ok(resized)
}

struct CachePaths {
    image_path: PathBuf,
    preview_path: PathBuf,
    thumbnail_path: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::apply_exif_orientation;

    fn at(pixels: &[u8], index: usize) -> u8 {
        pixels[index * 3]
    }

    #[test]
    fn orientation_1_returns_input_untouched() {
        let pixels = vec![10, 10, 10, 20, 20, 20];
        let (out, width, height) = apply_exif_orientation(pixels.clone(), 2, 1, 1);
        assert_eq!(out, pixels);
        assert_eq!((width, height), (2, 1));
    }

    #[test]
    fn orientation_6_rotates_90_cw() {
        // 横排 [A B] 顺时针 90° → 竖排 A 在上、B 在下，宽高互换
        let (out, width, height) = apply_exif_orientation(vec![10, 10, 10, 20, 20, 20], 2, 1, 6);
        assert_eq!((width, height), (1, 2));
        assert_eq!(at(&out, 0), 10);
        assert_eq!(at(&out, 1), 20);
    }

    #[test]
    fn orientation_8_rotates_90_ccw() {
        // 逆时针 90°（_DSC4747 的实际方向）→ B 在上、A 在下
        let (out, width, height) = apply_exif_orientation(vec![10, 10, 10, 20, 20, 20], 2, 1, 8);
        assert_eq!((width, height), (1, 2));
        assert_eq!(at(&out, 0), 20);
        assert_eq!(at(&out, 1), 10);
    }

    #[test]
    fn orientation_3_rotates_180() {
        let (out, width, height) = apply_exif_orientation(vec![10, 10, 10, 20, 20, 20], 2, 1, 3);
        assert_eq!((width, height), (2, 1));
        assert_eq!(at(&out, 0), 20);
        assert_eq!(at(&out, 1), 10);
    }

    #[test]
    fn orientation_2_flips_horizontally() {
        let (out, width, height) = apply_exif_orientation(vec![10, 10, 10, 20, 20, 20], 2, 1, 2);
        assert_eq!((width, height), (2, 1));
        assert_eq!(at(&out, 0), 20);
        assert_eq!(at(&out, 1), 10);
    }

    #[test]
    fn orientation_4_flips_vertically() {
        // 2×2 [[1,2],[3,4]] 上下翻转 → [[3,4],[1,2]]
        let (out, width, height) =
            apply_exif_orientation(vec![1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4], 2, 2, 4);
        assert_eq!((width, height), (2, 2));
        assert_eq!(
            [at(&out, 0), at(&out, 1), at(&out, 2), at(&out, 3)],
            [3, 4, 1, 2]
        );
    }

    #[test]
    fn orientation_5_transposes() {
        // 2×2 [[1,2],[3,4]] 主对角线转置 → [[1,3],[2,4]]
        let (out, width, height) =
            apply_exif_orientation(vec![1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4], 2, 2, 5);
        assert_eq!((width, height), (2, 2));
        assert_eq!(
            [at(&out, 0), at(&out, 1), at(&out, 2), at(&out, 3)],
            [1, 3, 2, 4]
        );
    }

    #[test]
    fn orientation_7_reflects_anti_diagonal() {
        // 2×2 [[1,2],[3,4]] 沿反对角线反射 → [[4,2],[3,1]]
        let (out, width, height) =
            apply_exif_orientation(vec![1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4], 2, 2, 7);
        assert_eq!((width, height), (2, 2));
        assert_eq!(
            [at(&out, 0), at(&out, 1), at(&out, 2), at(&out, 3)],
            [4, 2, 3, 1]
        );
    }

    #[test]
    fn orientation_9_or_other_returns_input_untouched() {
        let pixels = vec![9, 9, 9];
        let (out, width, height) = apply_exif_orientation(pixels.clone(), 1, 1, 9);
        assert_eq!(out, pixels);
        assert_eq!((width, height), (1, 1));
    }
}
