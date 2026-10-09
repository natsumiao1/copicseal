use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

#[derive(Debug, Serialize, Clone, Default)]
pub struct ExifData {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens_model: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub iso: Option<String>,
    pub focal_length: Option<String>,
    pub exposure_compensation: Option<String>,
    pub date_taken: Option<String>,
    pub white_balance: Option<String>,
    pub metering_mode: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
}

fn aperture_display(fnumber: f64) -> String {
    format!("f/{:.1}", fnumber)
}

fn shutter_display(seconds: f64) -> String {
    if seconds >= 1.0 {
        format!("{:.0}s", seconds)
    } else if seconds > 0.0 {
        format!("1/{:.0}s", 1.0 / seconds)
    } else {
        "0s".to_string()
    }
}

fn focal_length_display(mm: f64) -> String {
    format!("{:.0}mm", mm)
}

fn exposure_comp_display(ev: f64) -> String {
    if ev == 0.0 {
        "0 EV".to_string()
    } else if ev > 0.0 {
        format!("+{:.1} EV", ev)
    } else {
        format!("{:.1} EV", ev)
    }
}

fn rational_to_f64(r: &exif::Rational) -> f64 {
    r.num as f64 / r.denom as f64
}

fn srational_to_f64(r: &exif::SRational) -> f64 {
    r.num as f64 / r.denom as f64
}

/// 清理 `display_value()` 的文本表示。
///
/// `DisplayValue` 对 ASCII 字段使用 Debug 格式化，取出来会自带一对表示字符串
/// 字面量的双引号；原始值也可能以 NUL 结尾。这里统一剥掉外层引号并去除首尾的
/// NUL 与空白，保证品牌、型号、日期等字段拿到的是可直接展示与拼接的文本。
fn clean_display(raw: &str) -> String {
    let trimmed = raw.trim();
    let unquoted = if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };

    unquoted
        .trim_matches(|c: char| c == '\0' || c.is_whitespace())
        .to_string()
}

fn normalize_brand(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    match lower.as_str() {
        s if s.starts_with("sony") => "Sony".into(),
        s if s.starts_with("canon") => "Canon".into(),
        s if s.starts_with("nikon") => "Nikon".into(),
        s if s.starts_with("fujifilm") => "Fujifilm".into(),
        s if s.starts_with("olympus") => "Olympus".into(),
        s if s.starts_with("panasonic") => "Panasonic".into(),
        s if s.starts_with("leica") => "Leica".into(),
        s if s.starts_with("ricoh") => "Ricoh".into(),
        s if s.starts_with("pentax") => "Pentax".into(),
        s if s.starts_with("sigma") => "Sigma".into(),
        s if s.starts_with("hasselblad") => "Hasselblad".into(),
        s if s.starts_with("samsung") => "Samsung".into(),
        s if s.starts_with("apple") => "Apple".into(),
        s if s.starts_with("google") => "Google".into(),
        s if s.starts_with("huawei") => "Huawei".into(),
        s if s.starts_with("xiaomi") => "Xiaomi".into(),
        s if s.starts_with("dji") => "DJI".into(),
        s if s.starts_with("gopro") => "GoPro".into(),
        s if s.starts_with("insta360") => "Insta360".into(),
        s if s.starts_with("oneplus") => "OnePlus".into(),
        s if s.starts_with("oppo") => "OPPO".into(),
        s if s.starts_with("vivo") => "vivo".into(),
        s if s.starts_with("nokia") => "Nokia".into(),
        s if s.starts_with("zeiss") => "Zeiss".into(),
        _ => {
            let mut chars = raw.trim().chars();
            match chars.next() {
                None => raw.to_string(),
                Some(c) => c.to_uppercase().to_string() + chars.as_str(),
            }
        }
    }
}

#[tauri::command]
pub fn read_exif(path: String) -> Result<ExifData, String> {
    let path = Path::new(&path);

    if !path.exists() {
        return Err(format!("文件不存在: {}", path.display()));
    }

    let file = File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut reader = BufReader::new(file);

    let exif_reader = exif::Reader::new();
    let exif = exif_reader
        .read_from_container(&mut reader)
        .map_err(|e| format!("EXIF 解析失败: {}", e))?;

    let mut data = ExifData::default();

    for field in exif.fields() {
        match field.tag {
            exif::Tag::Make
            | exif::Tag::Model
            | exif::Tag::LensModel
            | exif::Tag::DateTimeOriginal
            | exif::Tag::WhiteBalance
            | exif::Tag::MeteringMode => {
                let val = clean_display(&field.display_value().to_string());
                if !val.is_empty() {
                    match field.tag {
                        exif::Tag::Make => data.make = Some(normalize_brand(&val)),
                        exif::Tag::Model => data.model = Some(val),
                        exif::Tag::LensModel => data.lens_model = Some(val),
                        exif::Tag::DateTimeOriginal => data.date_taken = Some(val),
                        exif::Tag::WhiteBalance => data.white_balance = Some(val),
                        exif::Tag::MeteringMode => data.metering_mode = Some(val),
                        _ => {}
                    }
                }
            }
            exif::Tag::FNumber => {
                if let exif::Value::Rational(v) = &field.value {
                    if let Some(r) = v.first() {
                        data.aperture = Some(aperture_display(rational_to_f64(r)));
                    }
                }
            }
            exif::Tag::ExposureTime => {
                if let exif::Value::Rational(v) = &field.value {
                    if let Some(r) = v.first() {
                        data.shutter_speed = Some(shutter_display(rational_to_f64(r)));
                    }
                }
            }
            exif::Tag::PhotographicSensitivity => {
                if let exif::Value::Short(v) = &field.value {
                    if let Some(val) = v.first() {
                        data.iso = Some(val.to_string());
                    }
                }
            }
            exif::Tag::FocalLength => {
                if let exif::Value::Rational(v) = &field.value {
                    if let Some(r) = v.first() {
                        data.focal_length = Some(focal_length_display(rational_to_f64(r)));
                    }
                }
            }
            exif::Tag::ExposureBiasValue => {
                if let exif::Value::SRational(v) = &field.value {
                    if let Some(r) = v.first() {
                        data.exposure_compensation =
                            Some(exposure_comp_display(srational_to_f64(r)));
                    }
                }
            }
            exif::Tag::PixelXDimension => {
                if let exif::Value::Long(v) = &field.value {
                    if let Some(val) = v.first() {
                        data.image_width = Some(*val);
                    }
                }
            }
            exif::Tag::PixelYDimension => {
                if let exif::Value::Long(v) = &field.value {
                    if let Some(val) = v.first() {
                        data.image_height = Some(*val);
                    }
                }
            }
            _ => {}
        }
    }

    Ok(data)
}

#[tauri::command]
pub fn extract_jpeg_exif(path: String) -> Result<Vec<u8>, String> {
    let data = std::fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;

    if data.len() < 2 || data[0] != 0xFF || data[1] != 0xD8 {
        return Err("不是有效的 JPEG 文件".into());
    }

    let mut pos = 2;
    while pos + 3 < data.len() {
        if data[pos] != 0xFF {
            return Err("JPEG 格式错误".into());
        }
        let marker = data[pos + 1];
        if marker == 0xE1 {
            let len = ((data[pos + 2] as usize) << 8) | (data[pos + 3] as usize);
            if pos + 2 + len <= data.len() {
                return Ok(data[pos..pos + 2 + len].to_vec());
            }
        }
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let seg_len = ((data[pos + 2] as usize) << 8) | (data[pos + 3] as usize);
        pos += 2 + seg_len;
    }

    Err("未找到 EXIF 数据".into())
}

#[tauri::command]
pub fn insert_jpeg_exif(jpeg_data: Vec<u8>, exif_segment: Vec<u8>) -> Result<Vec<u8>, String> {
    if jpeg_data.len() < 2 || jpeg_data[0] != 0xFF || jpeg_data[1] != 0xD8 {
        return Err("不是有效的 JPEG 数据".into());
    }

    let mut result = Vec::with_capacity(jpeg_data.len() + exif_segment.len());
    result.extend_from_slice(&jpeg_data[..2]);
    result.extend_from_slice(&exif_segment);
    result.extend_from_slice(&jpeg_data[2..]);

    Ok(result)
}

fn read_u16(data: &[u8], at: usize, big_endian: bool) -> Option<u16> {
    let bytes = data.get(at..at + 2)?;
    let arr = [bytes[0], bytes[1]];
    Some(if big_endian {
        u16::from_be_bytes(arr)
    } else {
        u16::from_le_bytes(arr)
    })
}

fn read_u32(data: &[u8], at: usize, big_endian: bool) -> Option<u32> {
    let bytes = data.get(at..at + 4)?;
    let arr = [bytes[0], bytes[1], bytes[2], bytes[3]];
    Some(if big_endian {
        u32::from_be_bytes(arr)
    } else {
        u32::from_le_bytes(arr)
    })
}

fn write_u16(data: &mut [u8], at: usize, value: u16, big_endian: bool) {
    let bytes = if big_endian {
        value.to_be_bytes()
    } else {
        value.to_le_bytes()
    };
    data[at..at + 2].copy_from_slice(&bytes);
}

/// 删除 EXIF APP1 段里的 GPS 位置信息：抹掉 IFD0 中的 GPSInfo 指针（0x8825）。
///
/// 只改条目表（2 字节计数 + 每条 12 字节）与段长度字段，数据区原地不动，
/// 其余字段的偏移量因此仍然有效；GPS 数据块变成无人引用的字节，读取方按
/// 指针寻址，不会再看到位置。结构与预期不符时原样返回，绝不把可读的 EXIF 改坏。
#[tauri::command]
pub fn strip_exif_gps(exif_segment: Vec<u8>) -> Vec<u8> {
    const GPS_INFO_POINTER: u16 = 0x8825;
    // APP1 头 4 字节（FF E1 len）+ "Exif\0\0" 6 字节
    const TIFF_START: usize = 10;

    // 段长度字段是大端 u16（值 = 段总长 - 2），超出范围就不动它
    if exif_segment.len() < TIFF_START + 8 || exif_segment.len() - 2 > u16::MAX as usize {
        return exif_segment;
    }
    if exif_segment[0] != 0xFF || exif_segment[1] != 0xE1 || &exif_segment[4..10] != b"Exif\0\0" {
        return exif_segment;
    }

    let tiff = TIFF_START;
    let big_endian = match exif_segment.get(tiff..tiff + 2) {
        Some(bytes) if bytes == b"MM" => true,
        Some(bytes) if bytes == b"II" => false,
        _ => return exif_segment,
    };
    // TIFF 魔数 42
    if read_u16(&exif_segment, tiff + 2, big_endian) != Some(42) {
        return exif_segment;
    }
    // IFD0 偏移相对 TIFF 头
    let ifd0 = match read_u32(&exif_segment, tiff + 4, big_endian) {
        Some(offset) => tiff + offset as usize,
        None => return exif_segment,
    };
    let count = match read_u16(&exif_segment, ifd0, big_endian) {
        Some(count) => count as usize,
        None => return exif_segment,
    };

    // 在 IFD0 条目里找 GPSInfo 指针
    let entries = ifd0 + 2;
    let mut gps_at = None;
    for index in 0..count {
        let at = entries + index * 12;
        match read_u16(&exif_segment, at, big_endian) {
            Some(tag) if tag == GPS_INFO_POINTER => {
                gps_at = Some(at);
                break;
            }
            Some(_) => continue,
            None => return exif_segment,
        }
    }
    let gps_at = match gps_at {
        Some(at) if at + 12 <= exif_segment.len() => at,
        _ => return exif_segment,
    };

    let mut result = exif_segment.clone();
    result.drain(gps_at..gps_at + 12);
    write_u16(&mut result, ifd0, (count - 1) as u16, big_endian);
    // APP1 段长度字段（大端，值 = 段总长 - 2）同步收缩 12 字节
    let length = (result.len() - 2) as u16;
    result[2..4].copy_from_slice(&length.to_be_bytes());
    result
}

/// APP1 段里的 EXIF 标识（其后是 TIFF 容器）。
const EXIF_HEADER: &[u8] = b"Exif\0\0";
/// APP1 段里的标准 XMP 包标识。
const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
/// APP1 段里的 Extended XMP 标识（超长 XMP 的分块传输）。
const XMP_EXT_HEADER: &[u8] = b"http://ns.adobe.com/xmp/extension/\0";
/// PNG 文本块里的 XMP 关键字（`iTXt` / `zTXt` / `tEXt` 的关键字以 NUL 结尾）。
const PNG_XMP_KEYWORD: &[u8] = b"XML:com.adobe.xmp\0";

/// 原地去除图片内嵌元数据：删掉 EXIF，可选连同内嵌 XMP 一起删。
///
/// 只做段 / 块级删除，不重新编码：像素数据一字节不动，画质零损失。
/// **方向（Orientation）标签会被单独保留**——Rust 侧的缩略图与预览按 EXIF 方向
/// 烘焙像素、浏览器按它决定显示方向，删掉会让竖拍照片横躺；方向本身不含隐私信息。
///
/// 支持 JPEG / PNG / WebP，其余格式（HEIC 等）返回错误由调用方置灰入口；
/// `.xmp` sidecar 文件不在此列（它是独立文件，且可能装着完整的修图指令）。
/// 返回是否真的改写了文件（没有元数据时不落盘）。
#[tauri::command]
pub async fn strip_image_exif(path: String, remove_xmp: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || strip_metadata_in_place(&path, remove_xmp))
        .await
        .map_err(|error| format!("去除元数据任务失败: {error}"))?
}

fn strip_metadata_in_place(path: &str, remove_xmp: bool) -> Result<bool, String> {
    let data = std::fs::read(path).map_err(|e| format!("读取文件失败: {e}"))?;
    let stripped = strip_metadata(&data, remove_xmp)?;
    if stripped.as_slice() == data.as_slice() {
        return Ok(false);
    }

    // 先写同目录临时文件再替换：中途失败（磁盘满、文件被占用）不会把原文件写坏
    let tmp = format!("{path}.copicseal-tmp");
    std::fs::write(&tmp, &stripped).map_err(|e| format!("写入文件失败: {e}"))?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("覆盖原文件失败: {e}", e = error));
    }
    Ok(true)
}

/// 按魔数分发到各容器的段 / 块级剥离逻辑。
fn strip_metadata(data: &[u8], remove_xmp: bool) -> Result<Vec<u8>, String> {
    const PNG_HEADER: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    if data.starts_with(&[0xFF, 0xD8]) {
        strip_jpeg_metadata(data, remove_xmp)
    } else if data.starts_with(&PNG_HEADER) {
        strip_png_metadata(data, remove_xmp)
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        strip_webp_metadata(data, remove_xmp)
    } else {
        Err("暂不支持该格式（仅支持 JPEG / PNG / WebP）".into())
    }
}

/// JPEG：删除 EXIF / （可选）XMP 的 APP1 段，其余段与扫描数据原样带走。
///
/// EXIF 段被整段替换为只含方向标签的最小段（见 [`build_orientation_exif_segment`]）；
/// 遇到结构异常就原样保留剩余字节，宁可少删也不把可读的图片改坏。
fn strip_jpeg_metadata(data: &[u8], remove_xmp: bool) -> Result<Vec<u8>, String> {
    if data.len() < 4 {
        return Err("不是有效的 JPEG 文件".into());
    }

    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[..2]); // SOI
    let mut pos = 2;
    while pos < data.len() {
        if data[pos] != 0xFF {
            // 段结构与预期不符：剩余字节原样带走
            out.extend_from_slice(&data[pos..]);
            break;
        }
        let marker = match data.get(pos + 1) {
            Some(marker) => *marker,
            None => {
                out.push(0xFF);
                break;
            }
        };
        if marker == 0xFF {
            pos += 1; // 填充字节
            continue;
        }
        // 无长度字段的标记（TEM / RSTn / 重复 SOI / 转义字节）直接保留
        if marker == 0x00 || marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            out.extend_from_slice(&data[pos..pos + 2]);
            pos += 2;
            continue;
        }
        // 扫描数据与 EOI 之后不会再有元数据，剩余部分原样带走
        if marker == 0xDA || marker == 0xD9 {
            out.extend_from_slice(&data[pos..]);
            break;
        }
        if pos + 4 > data.len() {
            return Err("JPEG 段结构异常".into());
        }
        let seg_len = u16::from_be_bytes([data[pos + 2], data[pos + 3]]) as usize;
        if seg_len < 2 || pos + 2 + seg_len > data.len() {
            return Err("JPEG 段长度越界".into());
        }
        let seg_end = pos + 2 + seg_len;

        let mut skip = false;
        if marker == 0xE1 {
            let payload = &data[pos + 4..seg_end];
            if payload.starts_with(EXIF_HEADER) {
                // 只留方向：其余字段（相机、镜头、时间、GPS、缩略图）随段一起消失
                if let Some(orientation) = read_orientation(&payload[EXIF_HEADER.len()..]) {
                    if orientation != 1 {
                        out.extend_from_slice(&build_orientation_exif_segment(orientation));
                    }
                }
                skip = true;
            } else if remove_xmp
                && (payload.starts_with(XMP_HEADER) || payload.starts_with(XMP_EXT_HEADER))
            {
                skip = true;
            }
        }
        if !skip {
            out.extend_from_slice(&data[pos..seg_end]);
        }
        pos = seg_end;
    }
    Ok(out)
}

/// 从 APP1 之后的 TIFF 数据里读 IFD0 的方向标签（`0x0112`，SHORT、count 1）。
///
/// 结构与预期不符时返回 `None`：调用方据此跳过「保留方向」，整段 EXIF 照删不误。
fn read_orientation(tiff: &[u8]) -> Option<u16> {
    const ORIENTATION_TAG: u16 = 0x0112;

    let big_endian = match tiff.get(0..2) {
        Some(bytes) if bytes == b"MM" => true,
        Some(bytes) if bytes == b"II" => false,
        _ => return None,
    };
    // TIFF 魔数 42
    if read_u16(tiff, 2, big_endian) != Some(42) {
        return None;
    }
    let ifd0 = read_u32(tiff, 4, big_endian)? as usize;
    let count = read_u16(tiff, ifd0, big_endian)? as usize;
    let entries = ifd0 + 2;

    for index in 0..count {
        let at = entries + index * 12;
        if read_u16(tiff, at, big_endian) != Some(ORIENTATION_TAG) {
            continue;
        }
        if read_u16(tiff, at + 2, big_endian) != Some(3) // 类型 SHORT
            || read_u32(tiff, at + 4, big_endian) != Some(1)
        {
            return None;
        }
        return read_u16(tiff, at + 8, big_endian);
    }
    None
}

/// 构造只含方向标签的最小 APP1 EXIF 段，用来整段替换原 EXIF。
///
/// TIFF 头之后只有一个条目：`Orientation`（`0x0112`，SHORT，count 1，
/// 值直接写在条目自带的 4 字节值字段里），下一条 IFD 指针为 0。
fn build_orientation_exif_segment(orientation: u16) -> Vec<u8> {
    let mut seg = Vec::with_capacity(36);
    seg.extend_from_slice(&[0xFF, 0xE1, 0x00, 0x00]); // 段长度占位
    seg.extend_from_slice(EXIF_HEADER);
    // TIFF 头：II（小端）、魔数 42、IFD0 偏移 8
    seg.extend_from_slice(&[0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
    seg.extend_from_slice(&1u16.to_le_bytes()); // 条目数 = 1
    seg.extend_from_slice(&0x0112u16.to_le_bytes()); // tag
    seg.extend_from_slice(&3u16.to_le_bytes()); // 类型 SHORT
    seg.extend_from_slice(&1u32.to_le_bytes()); // count
    seg.extend_from_slice(&orientation.to_le_bytes()); // 值（2 字节）
    seg.extend_from_slice(&[0x00, 0x00]); // 值字段补位
    seg.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // 下一条 IFD 指针
    let length = (seg.len() - 2) as u16;
    seg[2..4].copy_from_slice(&length.to_be_bytes());
    seg
}

/// PNG：删除 `eXIf` 块，（可选）删除嵌 XMP 的 `iTXt` / `zTXt` / `tEXt` 文本块。
///
/// 块结构是「长度 + 类型 + 数据 + CRC」，整块删除不改动其余块的字节与 CRC，
/// 因此无需重新计算校验。
fn strip_png_metadata(data: &[u8], remove_xmp: bool) -> Result<Vec<u8>, String> {
    const PNG_HEADER: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if !data.starts_with(&PNG_HEADER) {
        return Err("不是有效的 PNG 文件".into());
    }

    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[..8]);
    let mut pos = 8;
    while pos + 8 <= data.len() {
        let len =
            u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        let kind = &data[pos + 4..pos + 8];
        let chunk_end = match pos.checked_add(12 + len) {
            Some(end) if end <= data.len() => end,
            _ => return Err("PNG 块长度越界".into()),
        };

        let mut skip = kind == b"eXIf";
        if remove_xmp && (kind == b"iTXt" || kind == b"zTXt" || kind == b"tEXt") {
            skip = data[pos + 8..chunk_end - 4].starts_with(PNG_XMP_KEYWORD);
        }
        if !skip {
            out.extend_from_slice(&data[pos..chunk_end]);
        }
        pos = chunk_end;

        if kind == b"IEND" {
            if pos < data.len() {
                out.extend_from_slice(&data[pos..]); // IEND 之后的附加数据原样带走
            }
            return Ok(out);
        }
    }
    if pos < data.len() {
        out.extend_from_slice(&data[pos..]);
    }
    Ok(out)
}

/// WebP：删除 `EXIF` 块与（可选）`XMP ` 块，并重算 RIFF 长度字段。
///
/// 块数据按偶数字节对齐（补位字节随块一起删），其余块字节不动。
fn strip_webp_metadata(data: &[u8], remove_xmp: bool) -> Result<Vec<u8>, String> {
    if data.len() < 12 || &data[..4] != b"RIFF" || &data[8..12] != b"WEBP" {
        return Err("不是有效的 WebP 文件".into());
    }

    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[..12]);
    let mut pos = 12;
    while pos + 8 <= data.len() {
        let kind = &data[pos..pos + 4];
        let size = u32::from_le_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]])
            as usize;
        // 块占 8 字节头 + 数据 + 偶数补位；末块缺补位字节时按到文件尾处理
        let end = match pos.checked_add(8 + size + (size & 1)) {
            Some(end) if end <= data.len() => end,
            _ if pos + 8 + size <= data.len() => data.len(),
            _ => return Err("WebP 块长度越界".into()),
        };

        let skip = kind == b"EXIF" || (remove_xmp && kind == b"XMP ");
        if !skip {
            out.extend_from_slice(&data[pos..end]);
        }
        pos = end;
    }
    if pos < data.len() {
        out.extend_from_slice(&data[pos..]);
    }

    // RIFF 长度 = 8 字节头之后的一切
    let riff_len = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&riff_len.to_le_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造最小 APP1 段：IFD0 含 Make(0x010F)，`with_gps` 再追加 GPSInfo(0x8825)。
    fn build_segment(with_gps: bool) -> Vec<u8> {
        let mut seg = vec![0xFF, 0xE1, 0x00, 0x00]; // 段长度占位
        seg.extend_from_slice(b"Exif\0\0");
        // TIFF 头：II（小端）、魔数 42、IFD0 偏移 8
        seg.extend_from_slice(&[0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
        let entry_count: u16 = if with_gps { 2 } else { 1 };
        seg.extend_from_slice(&entry_count.to_le_bytes());
        // Make 0x010F，ASCII(2)，count 5，值偏移 0x30
        seg.extend_from_slice(&[
            0x0F, 0x01, 0x02, 0x00, 0x05, 0x00, 0x00, 0x00, 0x30, 0x00, 0x00, 0x00,
        ]);
        if with_gps {
            // GPSInfo 0x8825，LONG(4)，count 1，值 = GPS IFD 偏移
            seg.extend_from_slice(&[
                0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
            ]);
        }
        // 下一 IFD 指针 0 + 一段数据区（被剥离后成为孤儿字节）
        seg.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        seg.extend_from_slice(&[0xAA; 16]);
        let length = (seg.len() - 2) as u16;
        seg[2..4].copy_from_slice(&length.to_be_bytes());
        seg
    }

    #[test]
    fn strips_gps_pointer_and_keeps_other_entries() {
        let seg = build_segment(true);
        let out = strip_exif_gps(seg.clone());

        // 少了一条 12 字节条目
        assert_eq!(out.len(), seg.len() - 12);
        // 条目计数 2 → 1，第一条 Make 原地保留
        assert_eq!(read_u16(&out, 18, false), Some(1));
        assert_eq!(read_u16(&out, 20, false), Some(0x010F));
        // GPS 条目位置现在是「下一 IFD 指针」（0）
        assert_eq!(read_u16(&out, 32, false), Some(0));
        // 段长度字段与实际长度一致
        assert_eq!(u16::from_be_bytes([out[2], out[3]]) as usize, out.len() - 2);
        // 数据区字节未被搅动（偏移后仍在）
        assert!(out.ends_with(&[0xAA; 16]));
    }

    #[test]
    fn returns_original_when_no_gps_entry() {
        let seg = build_segment(false);
        assert_eq!(strip_exif_gps(seg.clone()), seg);
    }

    #[test]
    fn returns_original_on_malformed_input() {
        let garbage = vec![0x00, 0x01, 0x02, 0x03, 0x04];
        assert_eq!(strip_exif_gps(garbage.clone()), garbage);
    }

    // ---------- 原地去除 EXIF / XMP ----------

    /// 构造含方向标签（Orientation=6）与 Make 字段的 EXIF APP1 段。
    fn build_exif_segment() -> Vec<u8> {
        let mut seg = vec![0xFF, 0xE1, 0x00, 0x00]; // 段长度占位
        seg.extend_from_slice(EXIF_HEADER);
        // TIFF 头：II（小端）、魔数 42、IFD0 偏移 8
        seg.extend_from_slice(&[0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
        seg.extend_from_slice(&2u16.to_le_bytes()); // 两个条目
                                                    // Orientation 0x0112，SHORT(3)，count 1，值 6 直接写在值字段
        seg.extend_from_slice(&[
            0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
        ]);
        // Make 0x010F，ASCII(2)，count 5，值偏移 0x26（8 头 + 2 计数 + 24 条目 + 4 指针）
        seg.extend_from_slice(&[
            0x0F, 0x01, 0x02, 0x00, 0x05, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00,
        ]);
        seg.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // 下一条 IFD 指针
        seg.extend_from_slice(b"SONY\0"); // 数据区（被整段删除后不再可寻址）
        let length = (seg.len() - 2) as u16;
        seg[2..4].copy_from_slice(&length.to_be_bytes());
        seg
    }

    /// 构造一个 XMP APP1 段。
    fn build_xmp_segment() -> Vec<u8> {
        let mut payload = XMP_HEADER.to_vec();
        payload.extend_from_slice(b"<x:xmpmeta/>");
        let mut seg = vec![0xFF, 0xE1];
        seg.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        seg.extend_from_slice(&payload);
        seg
    }

    /// 最小 JPEG：SOI + 可选 EXIF / XMP 段 + SOS 扫描数据 + EOI。
    fn build_jpeg(with_exif: bool, with_xmp: bool) -> Vec<u8> {
        let mut jpeg = vec![0xFF, 0xD8];
        if with_exif {
            jpeg.extend_from_slice(&build_exif_segment());
        }
        if with_xmp {
            jpeg.extend_from_slice(&build_xmp_segment());
        }
        // SOS：长度 8 的段头，随后是熵编码流与 EOI
        jpeg.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]);
        jpeg.extend_from_slice(&[0x11, 0x22, 0xFF, 0x00, 0x33]);
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        jpeg
    }

    /// 取出 JPEG 里第一个 EXIF APP1 段的 TIFF 部分（跳过段头与 `Exif\0\0`）。
    fn first_exif_tiff(jpeg: &[u8]) -> Option<&[u8]> {
        let mut pos = 2;
        while pos + 10 <= jpeg.len() {
            if jpeg[pos] != 0xFF {
                return None;
            }
            if jpeg[pos + 1] == 0xE1 && &jpeg[pos + 4..pos + 10] == EXIF_HEADER {
                return Some(&jpeg[pos + 10..]);
            }
            if jpeg[pos + 1] == 0xDA || jpeg[pos + 1] == 0xD9 {
                return None;
            }
            let seg_len = u16::from_be_bytes([jpeg[pos + 2], jpeg[pos + 3]]) as usize;
            pos += 2 + seg_len;
        }
        None
    }

    #[test]
    fn strips_jpeg_exif_but_keeps_orientation() {
        let out = strip_jpeg_metadata(&build_jpeg(true, true), true).unwrap();

        // 方向被单独重建保留，其余字段（Make 等）与 XMP 段一起消失
        assert_eq!(read_orientation(first_exif_tiff(&out).unwrap()), Some(6));
        assert!(!out.windows(4).any(|window| window == b"SONY"));
        assert!(!out
            .windows(XMP_HEADER.len())
            .any(|window| window == XMP_HEADER));
        // SOI、扫描数据与 EOI 原样保留
        assert_eq!(&out[..2], &[0xFF, 0xD8]);
        assert_eq!(&out[out.len() - 2..], &[0xFF, 0xD9]);
        assert!(out.windows(2).any(|window| window == [0xFF, 0x00]));
    }

    #[test]
    fn keeps_xmp_when_not_requested() {
        let out = strip_jpeg_metadata(&build_jpeg(true, true), false).unwrap();

        assert!(out
            .windows(XMP_HEADER.len())
            .any(|window| window == XMP_HEADER));
        assert!(!out.windows(4).any(|window| window == b"SONY"));
    }

    #[test]
    fn jpeg_without_exif_is_byte_identical() {
        let jpeg = build_jpeg(false, false);
        assert_eq!(strip_jpeg_metadata(&jpeg, true).unwrap(), jpeg);
    }

    /// 追加一个 PNG 块（CRC 写 0 占位，生产代码只删不校验）。
    fn push_png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) {
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out.extend_from_slice(&0u32.to_be_bytes());
    }

    fn build_png() -> Vec<u8> {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        push_png_chunk(&mut png, b"IHDR", &[0u8; 13]);
        push_png_chunk(&mut png, b"eXIf", &[7u8; 8]);
        let mut itxt = PNG_XMP_KEYWORD.to_vec();
        itxt.extend_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x00]); // 关键字后缀与压缩标志
        itxt.extend_from_slice(b"<x:xmpmeta/>");
        push_png_chunk(&mut png, b"iTXt", &itxt);
        push_png_chunk(&mut png, b"IDAT", &[1, 2, 3]);
        push_png_chunk(&mut png, b"IEND", &[]);
        png
    }

    #[test]
    fn strips_png_exif_and_xmp_chunks() {
        let out = strip_png_metadata(&build_png(), true).unwrap();

        assert!(!out.windows(4).any(|window| window == b"eXIf"));
        assert!(!out
            .windows(PNG_XMP_KEYWORD.len())
            .any(|window| window == PNG_XMP_KEYWORD));
        // 其余块字节不动
        assert!(out.windows(4).any(|window| window == b"IHDR"));
        assert!(out.windows(4).any(|window| window == b"IDAT"));
        assert!(out.windows(4).any(|window| window == b"IEND"));
    }

    #[test]
    fn png_keeps_xmp_when_not_requested() {
        let out = strip_png_metadata(&build_png(), false).unwrap();

        assert!(!out.windows(4).any(|window| window == b"eXIf"));
        assert!(out
            .windows(PNG_XMP_KEYWORD.len())
            .any(|window| window == PNG_XMP_KEYWORD));
    }

    /// 追加一个 RIFF 块（偶数补位字节随块一起写入）。
    fn push_riff_chunk(out: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) {
        out.extend_from_slice(kind);
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            out.push(0x00);
        }
    }

    fn build_webp() -> Vec<u8> {
        let mut body = Vec::new();
        push_riff_chunk(&mut body, b"VP8 ", &[0u8; 9]);
        push_riff_chunk(&mut body, b"EXIF", &[7u8; 6]);
        push_riff_chunk(&mut body, b"XMP ", b"<x/>");

        let mut webp = Vec::new();
        webp.extend_from_slice(b"RIFF");
        webp.extend_from_slice(&((4 + body.len()) as u32).to_le_bytes());
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(&body);
        webp
    }

    #[test]
    fn strips_webp_exif_and_xmp_chunks() {
        let out = strip_webp_metadata(&build_webp(), true).unwrap();

        assert!(!out.windows(4).any(|window| window == b"EXIF"));
        assert!(!out.windows(4).any(|window| window == b"XMP "));
        assert!(out.windows(4).any(|window| window == b"VP8 "));
        // RIFF 长度字段随删除同步重算
        assert_eq!(
            u32::from_le_bytes([out[4], out[5], out[6], out[7]]) as usize,
            out.len() - 8
        );
    }

    #[test]
    fn rejects_unsupported_container() {
        let heic = b"\0\0\0\x20ftypheic rest of file";
        assert!(strip_metadata(heic, true).is_err());
    }
}
