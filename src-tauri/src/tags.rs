//! 图片标签读取（XMP 只读）。
//!
//! 星级与颜色标签并不在 EXIF 标准内，实际写在 XMP 元数据里：
//! JPEG 是文件头部的 APP1 XMP 段，其他格式是各自的元数据盒，
//! 也可能是同名的 `.xmp` sidecar（Lightroom 等软件的默认做法）。
//! 本模块只做提取，不改写文件。
//!
//! 已知边界：嵌入式 XMP 只扫描文件头部窗口（见 [`XMP_SCAN_WINDOW`]）——
//! JPEG 的段限制保证它一定在头部；个别把 XMP 放在文件末尾的写入方读不到，
//! 按「无标签」处理，不影响其余文件。

use serde::Serialize;
use std::io::Read;
use std::path::Path;

/// 单个文件的标签读取结果。
#[derive(Debug, Clone, Serialize)]
pub struct ImageTags {
    pub path: String,
    /// 星级 1-5；未评级（含 XMP 的 0「拒绝」）为 `None`
    pub rating: Option<u8>,
    /// 颜色标签 `Red` / `Yellow` / `Green` / `Blue` / `Purple`；无标签为 `None`
    pub label: Option<String>,
}

/// 嵌入式 XMP 的扫描窗口：JPEG 的单个 APP 段上限 64KB 且位于文件头部，
/// 1MB 足够覆盖常规写入方；同时避免为找标签读完整个大文件。
const XMP_SCAN_WINDOW: u64 = 1024 * 1024;

/// 批量读取一批图片的 XMP 标签。
///
/// 单文件读取失败一律按「无标签」处理：调用方按目录整批传入，
/// 个别损坏或没有 XMP 的文件不应让整批失败。
#[tauri::command]
pub async fn read_image_tags(paths: Vec<String>) -> Result<Vec<ImageTags>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| {
                let packet = read_xmp_packet(Path::new(path));
                ImageTags {
                    path: path.clone(),
                    rating: packet.as_deref().and_then(parse_rating),
                    label: packet.as_deref().and_then(parse_label),
                }
            })
            .collect()
    })
    .await
    .map_err(|error| format!("读取图片标签任务失败: {error}"))
}

/// 取一个文件的 XMP 包文本：优先 sidecar，其次文件头部窗口里的嵌入 XMP。
fn read_xmp_packet(path: &Path) -> Option<String> {
    // sidecar：`IMG_0001.JPG` → `IMG_0001.xmp`
    let sidecar = path.with_extension("xmp");
    if let Ok(bytes) = std::fs::read(&sidecar) {
        if let Some(packet) = extract_packet(&bytes) {
            return Some(packet);
        }
    }

    let file = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    file.take(XMP_SCAN_WINDOW).read_to_end(&mut head).ok()?;
    extract_packet(&head)
}

fn find_first(haystack: &[u8], needles: &[&[u8]]) -> Option<usize> {
    needles
        .iter()
        .filter_map(|needle| {
            haystack
                .windows(needle.len())
                .position(|window| window == *needle)
        })
        .min()
}

/// 从字节流里截出 XMP 包文本。
///
/// 文件里混着二进制图像数据，不能整体按 UTF-8 解码——先按字节找包边界，
/// 再对截出的片段解码；片段解码失败（撞上随机二进制）视为无标签。
fn extract_packet(bytes: &[u8]) -> Option<String> {
    // 起点：标准封装的 `<?xpacket begin`，或写入方只留的 `<x:xmpmeta` 根元素
    const STARTS: &[&[u8]] = &[b"<?xpacket begin", b"<x:xmpmeta"];
    // 终点：与起点对应，取靠前的那个（`</x:xmpmeta>` 在 `<?xpacket end` 之前）
    const ENDS: &[&[u8]] = &[b"<?xpacket end", b"</x:xmpmeta>"];

    let start = find_first(bytes, STARTS)?;
    let rest = &bytes[start..];
    let end = find_first(rest, ENDS)?;
    std::str::from_utf8(&rest[..end]).ok().map(str::to_string)
}

/// 星级：元素写法 `<xmp:Rating>3</xmp:Rating>`、属性写法 `xmp:Rating="3"` 都认；
/// 只取 1-5，XMP 的 0 表示「拒绝」，与未评级一样不参与星级筛选。
fn parse_rating(packet: &str) -> Option<u8> {
    let value = find_local_value(packet, "Rating")?;
    let rating = value.trim().parse::<u8>().ok()?;
    (1..=5).contains(&rating).then_some(rating)
}

/// 颜色标签：五个标准值（XMP `xmp:Label`），大小写不敏感。
fn parse_label(packet: &str) -> Option<String> {
    let value = find_local_value(packet, "Label")?;
    let label = match value.trim().to_ascii_lowercase().as_str() {
        "red" => "Red",
        "yellow" => "Yellow",
        "green" => "Green",
        "blue" => "Blue",
        "purple" => "Purple",
        _ => return None,
    };
    Some(label.to_string())
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' || byte == b'.'
}

/// 按本地名在 XMP 包里取值，两种写法都认：
///
/// - 元素：`<xmp:Rating>3</xmp:Rating>`
/// - 属性：`<rdf:Description xmp:Rating="3" ...>`
///
/// 命名空间前缀随写入方而变（`xmp:`、`x:`、自定义前缀都可能出现），
/// 所以只匹配本地名，同时校验前缀的位置（元素前必须是 `<`、属性前必须是
/// 空白或引号），避免撞上正文里的同名词。
fn find_local_value(packet: &str, local: &str) -> Option<String> {
    let bytes = packet.as_bytes();
    let needle = format!(":{local}");
    let mut from = 0usize;

    while let Some(offset) = packet[from..].find(&needle) {
        let colon = from + offset;
        let after = colon + needle.len();
        from = after;
        if after < bytes.len() && is_name_byte(bytes[after]) {
            continue; // 本地名更长（如 `Labels`），不是目标字段
        }

        // 冒号往回取完整前缀，再校验前缀起点前的字符
        let mut prefix_start = colon;
        while prefix_start > 0 && is_name_byte(bytes[prefix_start - 1]) {
            prefix_start -= 1;
        }
        if prefix_start == colon || prefix_start == 0 {
            continue;
        }
        let before_prefix = bytes[prefix_start - 1];
        let is_element = before_prefix == b'<';
        let is_attribute = before_prefix.is_ascii_whitespace() || before_prefix == b'"';
        if !is_element && !is_attribute {
            continue;
        }

        let mut cursor = after;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }

        if is_element && cursor < bytes.len() && bytes[cursor] == b'>' {
            let prefix = &packet[prefix_start..colon];
            let closing = format!("</{prefix}:{local}>");
            let text_start = cursor + 1;
            let text_end = match packet[text_start..].find(&closing) {
                Some(index) => text_start + index,
                None => continue,
            };
            let value = packet[text_start..text_end].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
            continue;
        }

        if is_attribute && cursor < bytes.len() && bytes[cursor] == b'=' {
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor >= bytes.len() {
                continue;
            }
            let quote = bytes[cursor];
            if quote != b'"' && quote != b'\'' {
                continue;
            }
            let value_start = cursor + 1;
            let value_end = match packet[value_start..].find(quote as char) {
                Some(index) => value_start + index,
                None => continue,
            };
            let value = packet[value_start..value_end].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmp:Rating="4"
      xmp:Label="Green">
   <dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">
    <rdf:Alt><rdf:li xml:lang="x-default">sample</rdf:li></rdf:Alt>
   </dc:title>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;

    #[test]
    fn parses_attribute_form() {
        let packet = SAMPLE;
        assert_eq!(parse_rating(packet), Some(4));
        assert_eq!(parse_label(packet), Some("Green".to_string()));
    }

    #[test]
    fn parses_element_form_with_custom_prefix() {
        let packet = r#"<meta:xmpmeta><meta:Rating>5</meta:Rating><meta:Label>Purple</meta:Label></meta:xmpmeta>"#;
        assert_eq!(parse_rating(packet), Some(5));
        assert_eq!(parse_label(packet), Some("Purple".to_string()));
    }

    #[test]
    fn rejects_out_of_range_and_unknown_values() {
        assert_eq!(parse_rating("<xmp:Rating>0</xmp:Rating>"), None);
        assert_eq!(parse_rating("<xmp:Rating>9</xmp:Rating>"), None);
        assert_eq!(parse_rating("<xmp:Rating>wat</xmp:Rating>"), None);
        assert_eq!(parse_label("<xmp:Label>Rainbow</xmp:Label>"), None);
        assert_eq!(
            parse_rating("<xmp:RatingSuggestion>3</xmp:RatingSuggestion>"),
            None
        );
        assert_eq!(parse_rating("no tags here"), None);
    }

    #[test]
    fn extracts_packet_around_binary_garbage() {
        let mut bytes = vec![0xFFu8, 0xD8, 0x00, 0xC0, 0x9F];
        bytes.extend_from_slice(SAMPLE.as_bytes());
        bytes.extend_from_slice(&[0x12, 0x34, 0x56]);
        let packet = extract_packet(&bytes).expect("应能从二进制中截出 XMP 包");
        assert_eq!(parse_rating(&packet), Some(4));
        assert!(extract_packet(b"\xff\xd8\x00\x12\x34").is_none());
    }
}
