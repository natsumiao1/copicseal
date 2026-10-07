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
}
