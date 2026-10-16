//! 图片标签读写（XMP）。
//!
//! 星级与颜色标签并不在 EXIF 标准内，实际写在 XMP 元数据里：
//! JPEG 是文件头部的 APP1 XMP 段，其他格式是各自的元数据盒，
//! 也可能是同名的 `.xmp` sidecar（Lightroom 等软件的默认做法）。
//!
//! 读取只提取不改写；写入（[`write_image_tag`]）回写「有效来源」：
//! 已有 sidecar 就更新 sidecar，否则内嵌且容器可原地改写就替换段 / 块，
//! 都没有（含 HEIC 等不改内嵌的格式）则新建 sidecar。只增删
//! `xmp:Rating` / `xmp:Label` 两个属性，包内其余内容原样保留。
//!
//! 已知边界：嵌入式 XMP 只扫描文件头部窗口（见 [`XMP_SCAN_WINDOW`]）——
//! JPEG 的段限制保证它一定在头部；个别把 XMP 放在文件末尾的写入方读不到，
//! 按「无标签」处理，不影响其余文件。

use crate::exif::{PNG_XMP_KEYWORD, XMP_EXT_HEADER, XMP_HEADER};
use serde::{Deserialize, Serialize};
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
    read_embedded_packet(path)
}

/// 取文件头部窗口里的内嵌 XMP 包；写入端定位「内嵌是有效来源」时用同一口径。
fn read_embedded_packet(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    file.take(XMP_SCAN_WINDOW).read_to_end(&mut head).ok()?;
    extract_packet(&head)
}

/// 找到最早出现的 needle，返回（位置，长度）；位置相同时取更短的那个。
fn find_first_with_len(haystack: &[u8], needles: &[&[u8]]) -> Option<(usize, usize)> {
    needles
        .iter()
        .filter_map(|needle| {
            haystack
                .windows(needle.len())
                .position(|window| window == *needle)
                .map(|index| (index, needle.len()))
        })
        .min()
}

fn find_first(haystack: &[u8], needles: &[&[u8]]) -> Option<usize> {
    find_first_with_len(haystack, needles).map(|(index, _)| index)
}

/// 从字节流里截出 XMP 包文本。
///
/// 文件里混着二进制图像数据，不能整体按 UTF-8 解码——先按字节找包边界，
/// 再对截出的片段解码；片段解码失败（撞上随机二进制）视为无标签。
///
/// **结束标记连同内容一起截进去**：写回要把完整包落盘，缺了
/// `</x:xmpmeta>` / `<?xpacket end` 这个包下次就读不出来。
fn extract_packet(bytes: &[u8]) -> Option<String> {
    // 起点：标准封装的 `<?xpacket begin`，或写入方只留的 `<x:xmpmeta` 根元素
    const STARTS: &[&[u8]] = &[b"<?xpacket begin", b"<x:xmpmeta"];
    // 终点：与起点对应，取靠前的那个（`</x:xmpmeta>` 在 `<?xpacket end` 之前）
    const ENDS: &[&[u8]] = &[b"<?xpacket end", b"</x:xmpmeta>"];

    let start = find_first(bytes, STARTS)?;
    let rest = &bytes[start..];
    let (end, end_len) = find_first_with_len(rest, ENDS)?;
    std::str::from_utf8(&rest[..end + end_len])
        .ok()
        .map(str::to_string)
}

/// 星级：元素写法 `<xmp:Rating>3</xmp:Rating>`、属性写法 `xmp:Rating="3"` 都认；
/// 只取 1-5，XMP 的 0 表示「拒绝」，与未评级一样不参与星级筛选。
fn parse_rating(packet: &str) -> Option<u8> {
    let value = find_local_value(packet, "Rating")?;
    let rating = value.trim().parse::<u8>().ok()?;
    (1..=5).contains(&rating).then_some(rating)
}

/// 颜色标签：五个标准值（XMP `xmp:Label`），大小写不敏感，返回规范拼写。
fn canonical_label(label: &str) -> Option<&'static str> {
    match label.trim().to_ascii_lowercase().as_str() {
        "red" => Some("Red"),
        "yellow" => Some("Yellow"),
        "green" => Some("Green"),
        "blue" => Some("Blue"),
        "purple" => Some("Purple"),
        _ => None,
    }
}

/// 颜色标签读取：未知值按无标签处理。
fn parse_label(packet: &str) -> Option<String> {
    let value = find_local_value(packet, "Label")?;
    canonical_label(&value).map(str::to_string)
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' || byte == b'.'
}

/// 一个 XMP 属性在包里的位置（字节区间），供原位替换 / 删除。
struct PropertySpan {
    /// 元素式：`<` 起点；属性式：前缀起点（删除区间从这里开始）
    start: usize,
    /// 元素式：闭合标签之后；属性式：闭合引号之后（删除区间到这里为止）
    end: usize,
    /// 值文本起点：元素式为开标签 `>` 之后，属性式为引号之后
    value_start: usize,
    /// 值文本终点：元素式为闭合标签起点，属性式为闭合引号
    value_end: usize,
}

/// 按本地名找出包里该属性的全部位置，元素式与属性式都认。
///
/// 命名空间前缀随写入方而变（`xmp:`、`x:`、自定义前缀都可能出现），
/// 所以只匹配本地名，同时校验前缀的位置（元素前必须是 `<`、属性前必须是
/// 空白或引号），避免撞上正文里的同名词——规则与读取端共用这一份。
/// 与读取取值不同的是这里**允许空值**：要把空值补上，也得先定位到它。
fn find_properties(packet: &str, local: &str) -> Vec<PropertySpan> {
    let bytes = packet.as_bytes();
    let needle = format!(":{local}");
    let mut from = 0usize;
    let mut found = Vec::new();

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

        if is_element {
            if cursor >= bytes.len() || bytes[cursor] != b'>' {
                continue;
            }
            let prefix = &packet[prefix_start..colon];
            let closing = format!("</{prefix}:{local}>");
            let text_start = cursor + 1;
            let Some(close_start) = packet[text_start..].find(&closing) else {
                continue;
            };
            let close_start = text_start + close_start;
            found.push(PropertySpan {
                start: prefix_start,
                end: close_start + closing.len(),
                value_start: text_start,
                value_end: close_start,
            });
            continue;
        }

        if cursor >= bytes.len() || bytes[cursor] != b'=' {
            continue;
        }
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
        let Some(value_end) = packet[value_start..].find(quote as char) else {
            continue;
        };
        let value_end = value_start + value_end;
        found.push(PropertySpan {
            start: prefix_start,
            end: value_end + 1, // 连闭合引号一起纳入，删除时不留残引号
            value_start,
            value_end,
        });
    }
    found
}

/// 按本地名在 XMP 包里取值，两种写法都认；返回第一个非空值。
fn find_local_value(packet: &str, local: &str) -> Option<String> {
    find_properties(packet, local)
        .into_iter()
        .map(|span| packet[span.value_start..span.value_end].trim().to_string())
        .find(|value| !value.is_empty())
}

// ---------- 打标写入（星级 / 颜色标签） ----------

/// 一次打标写入：把其中一个标签维度设为指定值，`None` 表示清除该属性。
///
/// 与前端的 `ImageTagWrite` 一一对应（`{ kind: 'rating' | 'label', value }`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TagWrite {
    /// 星级 1-5；`None` 清除
    Rating { value: Option<u8> },
    /// 颜色标签（五色，大小写不敏感）；`None` 清除
    Label { value: Option<String> },
}

/// XMP 命名空间 URI（`xmp:` 前缀的正式绑定）。
const XMP_NS: &str = "http://ns.adobe.com/xap/1.0/";

/// 文件与 sidecar 都没有 XMP 时的最小空包：只有 RDF 骨架，
/// 待写的属性由 [`patch_property`] 追加到 `rdf:Description` 上。
const EMPTY_PACKET: &str = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;

/// 打标写入：设置或清除一张图片的星级 / 颜色标签，返回写后重读的标签。
///
/// 写入目标是「有效来源」：已有 `.xmp` sidecar 就更新 sidecar；否则内嵌 XMP
/// 可原地改写（JPEG / PNG / WebP）就只换段 / 块、不重新编码；两者都没有
/// （含 HEIC 等不改内嵌的格式、包超 APP1 段上限、带 Extended XMP 的文件）
/// 则新建 sidecar。单文件失败返回错误，由调用方逐张串行并汇总。
#[tauri::command]
pub async fn write_image_tag(path: String, write: TagWrite) -> Result<ImageTags, String> {
    tauri::async_runtime::spawn_blocking(move || write_tag_in_place(&path, &write))
        .await
        .map_err(|error| format!("写入图片标签任务失败: {error}"))?
}

/// 一次打标的落盘实现；成功后按读取端口径重读，保证前端拿到的就是文件里的值。
fn write_tag_in_place(path: &str, write: &TagWrite) -> Result<ImageTags, String> {
    validate_write(write)?;

    let file = Path::new(path);
    let sidecar = file.with_extension("xmp");
    let embedded = read_embedded_packet(file);
    // 有效来源与读取端同口径：sidecar（文件存在即算，哪怕包读不出来）→ 内嵌
    let base = std::fs::read(&sidecar)
        .ok()
        .and_then(|bytes| extract_packet(&bytes))
        .or(embedded);

    let patched = match &base {
        Some(packet) => patch_packet(packet, write)?,
        // 两处都没有 XMP：清除类写入是空操作，不值得为此新建一个文件
        None if is_clear(write) => return Ok(read_tags_now(file)),
        None => patch_packet(EMPTY_PACKET, write)?,
    };
    // 包没变化（属性本就不存在的清除、值与原值相同的设置）：不落盘，不白改 mtime
    if base.as_deref() == Some(patched.as_str()) {
        return Ok(read_tags_now(file));
    }

    if !sidecar.exists() && replace_embedded_packet(file, &patched)? {
        return Ok(read_tags_now(file));
    }
    atomic_replace(&sidecar, patched.as_bytes())?;
    Ok(read_tags_now(file))
}

/// 这次写入是否为「清除」。
fn is_clear(write: &TagWrite) -> bool {
    matches!(
        write,
        TagWrite::Rating { value: None } | TagWrite::Label { value: None }
    )
}

/// 入参校验：越界星级与未知颜色直接拒绝，不落到文件里再回读兜底。
fn validate_write(write: &TagWrite) -> Result<(), String> {
    match write {
        TagWrite::Rating {
            value: Some(rating),
        } if !(1..=5).contains(rating) => Err(format!("星级必须是 1-5，收到 {rating}")),
        TagWrite::Label { value: Some(label) } if canonical_label(label).is_none() => {
            Err(format!("未知的颜色标签：{label}"))
        }
        _ => Ok(()),
    }
}

/// 按读取端口径读一次标签，作为写入结果返回。
fn read_tags_now(path: &Path) -> ImageTags {
    let packet = read_xmp_packet(path);
    ImageTags {
        path: path.to_string_lossy().into_owned(),
        rating: packet.as_deref().and_then(parse_rating),
        label: packet.as_deref().and_then(parse_label),
    }
}

/// 按一次打标改写 XMP 包：只增删 `xmp:Rating` / `xmp:Label`，其余内容原样保留。
fn patch_packet(packet: &str, write: &TagWrite) -> Result<String, String> {
    match write {
        TagWrite::Rating { value } => patch_property(
            packet,
            "Rating",
            value.map(|value| value.to_string()).as_deref(),
        ),
        TagWrite::Label { value } => {
            let canonical = value.as_deref().and_then(canonical_label);
            patch_property(packet, "Label", canonical)
        }
    }
}

/// 定位并改写包里的一个属性：已有就原位替换 / 删除，没有且要写入就插入。
///
/// 替换与删除都保留原来的写法（元素式改标签内文本、属性式改引号内值），
/// 因此写回后包的结构与其余属性不受影响。
fn patch_property(packet: &str, local: &str, value: Option<&str>) -> Result<String, String> {
    if let Some(span) = find_properties(packet, local).into_iter().next() {
        return Ok(match value {
            Some(next) => format!(
                "{}{}{}",
                &packet[..span.value_start],
                next,
                &packet[span.value_end..]
            ),
            None => format!("{}{}", &packet[..span.start], &packet[span.end..]),
        });
    }
    match value {
        Some(next) => insert_property(packet, local, next),
        None => Ok(packet.to_string()),
    }
}

/// 一个尚不存在的属性插进包里：优先当属性挂在首个 `rdf:Description` 上，
/// 没有 `rdf:Description` 就新建（挂在 `rdf:RDF` 下，再没有就包一层），
/// 三处锚点都找不到说明包本身不是合法 XMP，报错而不是硬写。
fn insert_property(packet: &str, local: &str, value: &str) -> Result<String, String> {
    // 前缀复用包内已绑定 XMP 命名空间的那个；没有就用 `xmp:` 并顺带声明
    let prefix = xmp_prefix(packet).unwrap_or_else(|| "xmp".to_string());
    let declared = if packet.contains(&format!("xmlns:{prefix}=")) {
        String::new()
    } else {
        format!("xmlns:{prefix}=\"{XMP_NS}\" ")
    };
    let attr = format!("{declared}{prefix}:{local}=\"{value}\"");

    // ① 首个 <rdf:Description ...>：属性插在结束 `>` 之前（自闭合的 `/` 也要留在属性之后）
    if let Some(index) = find_open_tag(packet, "rdf:Description") {
        let before = &packet[..index];
        let insert_at = if before.trim_end().ends_with('/') {
            before.trim_end().len()
        } else {
            index
        };
        return Ok(format!(
            "{} {}{}",
            &packet[..insert_at],
            attr,
            &packet[insert_at..]
        ));
    }

    // ② / ③ 新建元素时把两个命名空间都声明在自己身上：不依赖包里别处是否已声明
    let element = format!(
        "\n   <rdf:Description rdf:about=\"\" xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" {attr}/>"
    );
    if let Some(index) = packet.find("</rdf:RDF>") {
        return Ok(format!(
            "{}{}{}",
            &packet[..index],
            element,
            &packet[index..]
        ));
    }
    let block = format!(
        "\n  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n{element}\n  </rdf:RDF>\n "
    );
    for anchor in ["</x:xmpmeta>", "</xmpmeta>", "<?xpacket end"] {
        if let Some(index) = packet.find(anchor) {
            return Ok(format!("{}{}{}", &packet[..index], block, &packet[index..]));
        }
    }
    Err("XMP 包结构异常，无法写入标签".into())
}

/// 找出包里已绑定 XMP 命名空间的前缀（`xmlns:foo="http://ns.adobe.com/xap/1.0/"`）。
fn xmp_prefix(packet: &str) -> Option<String> {
    let mut from = 0usize;
    while let Some(offset) = packet[from..].find("xmlns:") {
        let name_start = from + offset + "xmlns:".len();
        from = name_start;
        let rest = &packet[name_start..];
        let name_len = rest
            .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.'))
            .unwrap_or(rest.len());
        let name = &rest[..name_len];
        if name.is_empty() {
            continue;
        }
        let Some(value) = rest[name_len..].trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.trim_start();
        let Some(quote) = value.chars().next() else {
            continue;
        };
        if quote != '"' && quote != '\'' {
            continue;
        }
        let value = &value[quote.len_utf8()..];
        let Some(end) = value.find(quote) else {
            continue;
        };
        if &value[..end] == XMP_NS {
            return Some(name.to_string());
        }
    }
    None
}

/// 找 `<qname ...>` 起始标签的结束 `>` 位置（跳过引号里的 `>`）。
fn find_open_tag(packet: &str, qname: &str) -> Option<usize> {
    let needle = format!("<{qname}");
    let mut from = 0usize;
    while let Some(offset) = packet[from..].find(&needle) {
        let start = from + offset;
        from = start + needle.len();
        let rest = &packet[from..];
        match rest.chars().next() {
            Some(first) if first.is_whitespace() || first == '>' || first == '/' => {}
            _ => continue,
        }
        let mut quote: Option<char> = None;
        for (index, ch) in rest.char_indices() {
            match quote {
                Some(open) => {
                    if ch == open {
                        quote = None;
                    }
                }
                None => match ch {
                    '"' | '\'' => quote = Some(ch),
                    '>' => return Some(from + index),
                    _ => {}
                },
            }
        }
    }
    None
}

/// 把文件里的内嵌 XMP 包整体替换成 `packet`。
///
/// 返回 `Ok(true)` 已改写文件、`Ok(false)` 该容器不支持原地改写 / 文件里没有
/// 内嵌 XMP / 包超出容器承载能力（调用方回退到 sidecar）、`Err` 结构异常。
/// 只做段 / 块级替换，不重新编码，像素字节一字节不动。
fn replace_embedded_packet(path: &Path, packet: &str) -> Result<bool, String> {
    let data = std::fs::read(path).map_err(|error| format!("读取文件失败: {error}"))?;
    const PNG_HEADER: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    let (out, replaced) = if data.starts_with(&[0xFF, 0xD8]) {
        replace_jpeg_xmp(&data, packet)?
    } else if data.starts_with(&PNG_HEADER) {
        replace_png_xmp(&data, packet)?
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        replace_webp_xmp(&data, packet)?
    } else {
        return Ok(false); // HEIC / TIFF / BMP…：不动原文件，回退 sidecar
    };

    if !replaced {
        return Ok(false);
    }
    atomic_replace(path, &out)?;
    Ok(true)
}

/// JPEG：把 APP1 里的 XMP 段整段换成新包，其余段与扫描数据原样带走。
///
/// 段长度超上限、或文件带 Extended XMP（分块传输，单独替换主包会与分块分叉）
/// 时返回 `Ok(false)`，由调用方回退 sidecar。
fn replace_jpeg_xmp(data: &[u8], packet: &str) -> Result<(Vec<u8>, bool), String> {
    if data.len() < 4 {
        return Err("不是有效的 JPEG 文件".into());
    }
    // 段长度字段含自身 2 字节，上限 u16
    let new_seg_len = 2 + XMP_HEADER.len() + packet.len();
    if new_seg_len > u16::MAX as usize {
        return Ok((Vec::new(), false));
    }

    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[..2]); // SOI
    let mut pos = 2;
    let mut replaced = false;
    while pos < data.len() {
        if data[pos] != 0xFF {
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

        if marker == 0xE1 {
            let payload = &data[pos + 4..seg_end];
            if payload.starts_with(XMP_EXT_HEADER) {
                return Ok((Vec::new(), false));
            }
            if payload.starts_with(XMP_HEADER) {
                out.extend_from_slice(&[0xFF, 0xE1]);
                out.extend_from_slice(&(new_seg_len as u16).to_be_bytes());
                out.extend_from_slice(XMP_HEADER);
                out.extend_from_slice(packet.as_bytes());
                replaced = true;
                pos = seg_end;
                continue;
            }
        }
        out.extend_from_slice(&data[pos..seg_end]);
        pos = seg_end;
    }
    Ok((out, replaced))
}

/// PNG：把关键字为 `XML:com.adobe.xmp` 的文本块整块换成新的 `iTXt`（重算 CRC），
/// 其余块的字节与 CRC 原样不动。
fn replace_png_xmp(data: &[u8], packet: &str) -> Result<(Vec<u8>, bool), String> {
    const PNG_HEADER: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if !data.starts_with(&PNG_HEADER) {
        return Err("不是有效的 PNG 文件".into());
    }

    let mut out = Vec::with_capacity(data.len());
    out.extend_from_slice(&data[..8]);
    let mut pos = 8;
    let mut replaced = false;
    while pos + 8 <= data.len() {
        let len =
            u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        let kind = &data[pos + 4..pos + 8];
        let chunk_end = match pos.checked_add(12 + len) {
            Some(end) if end <= data.len() => end,
            _ => return Err("PNG 块长度越界".into()),
        };

        let is_text = kind == b"iTXt" || kind == b"zTXt" || kind == b"tEXt";
        if is_text && data[pos + 8..chunk_end - 4].starts_with(PNG_XMP_KEYWORD) {
            out.extend_from_slice(&build_png_xmp_chunk(packet));
            replaced = true;
        } else {
            out.extend_from_slice(&data[pos..chunk_end]);
        }
        pos = chunk_end;

        if kind == b"IEND" {
            if pos < data.len() {
                out.extend_from_slice(&data[pos..]); // IEND 之后的附加数据原样带走
            }
            break;
        }
    }
    Ok((out, replaced))
}

/// 构造一个承载 XMP 的 `iTXt` 块：关键字 + 不压缩标记 + 空语言 / 翻译关键字 + 包文本。
fn build_png_xmp_chunk(packet: &str) -> Vec<u8> {
    let mut body = Vec::from(PNG_XMP_KEYWORD); // 关键字自带结尾 NUL
    body.extend_from_slice(&[0x00, 0x00]); // 压缩标志 + 压缩方法（都不压缩）
    body.push(0x00); // 语言标签（空）
    body.push(0x00); // 翻译关键字（空）
    body.extend_from_slice(packet.as_bytes());

    let mut crc_input = Vec::with_capacity(body.len() + 4);
    crc_input.extend_from_slice(b"iTXt");
    crc_input.extend_from_slice(&body);

    let mut chunk = Vec::with_capacity(body.len() + 12);
    chunk.extend_from_slice(&(body.len() as u32).to_be_bytes());
    chunk.extend_from_slice(b"iTXt");
    chunk.extend_from_slice(&body);
    chunk.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    chunk
}

/// WebP：把 `XMP ` 块的数据换成新包（偶数补位），并重算 RIFF 长度字段。
fn replace_webp_xmp(data: &[u8], packet: &str) -> Result<(Vec<u8>, bool), String> {
    if data.len() < 12 || &data[..4] != b"RIFF" || &data[8..12] != b"WEBP" {
        return Err("不是有效的 WebP 文件".into());
    }
    let mut payload = Vec::from(packet.as_bytes());
    if payload.len() % 2 == 1 {
        payload.push(0x00); // RIFF 块按偶数字节对齐
    }

    let mut out = Vec::with_capacity(data.len() + payload.len());
    out.extend_from_slice(&data[..12]);
    let mut pos = 12;
    let mut replaced = false;
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

        if kind == b"XMP " {
            out.extend_from_slice(b"XMP ");
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(&payload);
            replaced = true;
        } else {
            out.extend_from_slice(&data[pos..end]);
        }
        pos = end;
    }
    if pos < data.len() {
        out.extend_from_slice(&data[pos..]);
    }

    let riff_len = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&riff_len.to_le_bytes());
    Ok((out, replaced))
}

/// 标准 CRC-32（PNG 块校验用）：按位计算，只为一个校验和不引入新依赖。
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// 先写同目录临时文件再替换：中途失败（磁盘满、文件被占用）不会把原文件写坏。
fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = format!("{}.copicseal-tmp", path.display());
    std::fs::write(&tmp, bytes).map_err(|error| format!("写入文件失败: {error}"))?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("覆盖文件失败: {error}"));
    }
    Ok(())
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

    // ---------- 打标写入 ----------

    #[test]
    fn crc32_matches_known_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn patches_attribute_form_in_place() {
        let patched = patch_packet(SAMPLE, &TagWrite::Rating { value: Some(2) }).unwrap();
        assert_eq!(parse_rating(&patched), Some(2));
        // 另一个维度与其余属性不受影响
        assert_eq!(parse_label(&patched), Some("Green".to_string()));
        assert!(patched.contains("dc:title"));

        let cleared = patch_packet(&patched, &TagWrite::Label { value: None }).unwrap();
        assert_eq!(parse_label(&cleared), None);
        assert_eq!(parse_rating(&cleared), Some(2));
        // 属性式清除不留残引号
        assert!(!cleared.contains("xmp:Label"));
        assert!(!cleared.contains("\"Green\""));
    }

    #[test]
    fn patches_element_form_and_custom_prefix() {
        let packet = r#"<meta:xmpmeta><meta:Rating>5</meta:Rating><meta:Label>Purple</meta:Label></meta:xmpmeta>"#;
        let patched = patch_packet(packet, &TagWrite::Rating { value: Some(1) }).unwrap();
        assert_eq!(parse_rating(&patched), Some(1));
        assert_eq!(parse_label(&patched), Some("Purple".to_string()));

        let cleared = patch_packet(&patched, &TagWrite::Rating { value: None }).unwrap();
        assert_eq!(parse_rating(&cleared), None);
        assert!(cleared.contains("<meta:Label>Purple</meta:Label>"));
    }

    #[test]
    fn inserts_missing_property_keeping_others() {
        // 只有颜色标签的包：写星级要靠插入，且不能动原有内容
        let packet = r#"<x:xmpmeta><rdf:RDF><rdf:Description rdf:about="" xmp:Label="Blue"/></rdf:RDF></x:xmpmeta>"#;
        let patched = patch_packet(packet, &TagWrite::Rating { value: Some(4) }).unwrap();
        assert_eq!(parse_rating(&patched), Some(4));
        assert_eq!(parse_label(&patched), Some("Blue".to_string()));
        assert!(patched.contains("rdf:about"));
        // 包里没有绑定 XMP 命名空间：插入时顺带声明，读取端仍按本地名认
        assert!(patched.contains("xmlns:xmp="));
    }

    #[test]
    fn insert_needs_at_least_one_anchor() {
        let error = patch_packet("<just some text/>", &TagWrite::Rating { value: Some(3) });
        assert!(error.is_err());
        // 清除一个不存在的属性是空操作，不报错也不改包
        let unchanged = patch_packet("<just some text/>", &TagWrite::Rating { value: None });
        assert_eq!(unchanged.unwrap(), "<just some text/>");
    }

    #[test]
    fn replaces_jpeg_xmp_segment_without_touching_the_rest() {
        let jpeg = build_jpeg_with_xmp(SAMPLE);
        let (out, replaced) = replace_jpeg_xmp(&jpeg, EMPTY_PACKET).unwrap();
        assert!(replaced);
        let packet = extract_packet(&out).expect("替换后仍应能截出 XMP 包");
        assert!(packet.contains("<rdf:Description"));
        // 段标识与扫描数据保持原样
        let header_at = out
            .windows(XMP_HEADER.len())
            .position(|window| window == XMP_HEADER)
            .expect("替换后应仍是 XMP 的 APP1 段");
        assert_eq!(&out[header_at - 4..header_at - 2], &[0xFF, 0xE1]);
        // 段长度字段必须等于新 payload + 2 字节本身，否则解码器会读错段边界
        let declared = u16::from_be_bytes([out[header_at - 2], out[header_at - 1]]) as usize;
        assert_eq!(declared, 2 + XMP_HEADER.len() + EMPTY_PACKET.len());
        assert!(out.ends_with(&[0xFF, 0xD9]));

        // 超出 APP1 段上限：不改写，交给调用方回退 sidecar
        let oversized = "x".repeat(u16::MAX as usize);
        let (_, replaced) = replace_jpeg_xmp(&jpeg, &oversized).unwrap();
        assert!(!replaced);
    }

    #[test]
    fn replaces_png_xmp_chunk_with_valid_crc() {
        let png = build_png_with_xmp(SAMPLE);
        let (out, replaced) = replace_png_xmp(&png, EMPTY_PACKET).unwrap();
        assert!(replaced);
        let packet = extract_packet(&out).expect("替换后仍应能截出 XMP 包");
        assert!(packet.contains("<rdf:Description"));

        // 新块的 CRC 必须自洽，否则解码器会判整张图损坏
        let (kind, body, crc) = find_png_xmp_chunk(&out).expect("应仍有 XMP 文本块");
        assert_eq!(kind, b"iTXt");
        let mut crc_input = kind.to_vec();
        crc_input.extend_from_slice(&body);
        assert_eq!(crc32(&crc_input), crc);
    }

    #[test]
    fn replaces_webp_xmp_chunk_and_keeps_riff_length() {
        let webp = build_webp_with_xmp(SAMPLE);
        let (out, replaced) = replace_webp_xmp(&webp, EMPTY_PACKET).unwrap();
        assert!(replaced);
        assert_eq!(
            u32::from_le_bytes([out[4], out[5], out[6], out[7]]) as usize,
            out.len() - 8
        );
        let packet = extract_packet(&out).expect("替换后仍应能截出 XMP 包");
        assert!(packet.contains("<rdf:Description"));
    }

    #[test]
    fn writes_sidecar_when_file_has_no_xmp() {
        let dir = make_temp_dir();
        let photo = dir.join("shot.jpg");
        std::fs::write(&photo, [0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]).unwrap();
        let path = photo.to_string_lossy().into_owned();
        let sidecar = photo.with_extension("xmp");

        let tags = write_tag_in_place(&path, &TagWrite::Rating { value: Some(3) }).unwrap();
        assert_eq!(tags.rating, Some(3));
        assert!(sidecar.exists(), "没有内嵌 XMP 时应新建 sidecar");

        // 再写颜色标签：另一个维度与已有值都保留
        let tags = write_tag_in_place(
            &path,
            &TagWrite::Label {
                value: Some("green".into()),
            },
        )
        .unwrap();
        assert_eq!(tags.rating, Some(3));
        assert_eq!(tags.label.as_deref(), Some("Green"));

        // 清除星级：颜色标签仍在
        let tags = write_tag_in_place(&path, &TagWrite::Rating { value: None }).unwrap();
        assert_eq!(tags.rating, None);
        assert_eq!(tags.label.as_deref(), Some("Green"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writes_embedded_packet_without_creating_sidecar() {
        let dir = make_temp_dir();
        let photo = dir.join("shot.jpg");
        std::fs::write(&photo, build_jpeg_with_xmp(SAMPLE)).unwrap();
        let path = photo.to_string_lossy().into_owned();

        let tags = write_tag_in_place(&path, &TagWrite::Rating { value: Some(5) }).unwrap();
        assert_eq!(tags.rating, Some(5));
        assert_eq!(tags.label.as_deref(), Some("Green"), "包内其他属性应保留");
        assert!(
            !photo.with_extension("xmp").exists(),
            "内嵌可改写时不应产生 sidecar"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_without_any_xmp_is_a_no_op() {
        let dir = make_temp_dir();
        let photo = dir.join("shot.jpg");
        std::fs::write(&photo, [0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]).unwrap();
        let path = photo.to_string_lossy().into_owned();

        let tags = write_tag_in_place(&path, &TagWrite::Rating { value: None }).unwrap();
        assert_eq!(tags.rating, None);
        assert!(!photo.with_extension("xmp").exists(), "空操作不该新建文件");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_out_of_range_writes() {
        assert!(write_tag_in_place("unused.jpg", &TagWrite::Rating { value: Some(9) }).is_err());
        assert!(write_tag_in_place(
            "unused.jpg",
            &TagWrite::Label {
                value: Some("rainbow".into())
            }
        )
        .is_err());
    }

    /// 独立临时目录：测试各自建、各自删，互不干扰。
    fn make_temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("copicseal-tags-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 最小 JPEG：SOI + XMP 的 APP1 段 + SOS / 扫描数据 + EOI。
    fn build_jpeg_with_xmp(packet: &str) -> Vec<u8> {
        let mut payload = XMP_HEADER.to_vec();
        payload.extend_from_slice(packet.as_bytes());
        let mut jpeg = vec![0xFF, 0xD8];
        jpeg.extend_from_slice(&[0xFF, 0xE1]);
        jpeg.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        jpeg.extend_from_slice(&payload);
        jpeg.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]);
        jpeg
    }

    /// 最小 PNG：签名 + IHDR + 承载 XMP 的文本块 + IEND。
    fn build_png_with_xmp(packet: &str) -> Vec<u8> {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let ihdr: Vec<u8> = vec![0; 13];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&ihdr);
        let mut crc_input = Vec::from(&b"IHDR"[..]);
        crc_input.extend_from_slice(&ihdr);
        png.extend_from_slice(&crc32(&crc_input).to_be_bytes());
        png.extend_from_slice(&build_png_xmp_chunk(packet));
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&crc32(b"IEND").to_be_bytes());
        png
    }

    /// 取出 PNG 里的 XMP 文本块（类型、数据、CRC），供断言用。
    fn find_png_xmp_chunk(data: &[u8]) -> Option<(&[u8], Vec<u8>, u32)> {
        let mut pos = 8;
        while pos + 8 <= data.len() {
            let len = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                as usize;
            let kind = &data[pos + 4..pos + 8];
            let end = pos + 12 + len;
            if end > data.len() {
                return None;
            }
            if (kind == b"iTXt" || kind == b"zTXt" || kind == b"tEXt")
                && data[pos + 8..end - 4].starts_with(PNG_XMP_KEYWORD)
            {
                let crc = u32::from_be_bytes([
                    data[end - 4],
                    data[end - 3],
                    data[end - 2],
                    data[end - 1],
                ]);
                return Some((kind, data[pos + 8..end - 4].to_vec(), crc));
            }
            pos = end;
        }
        None
    }

    /// 最小 WebP：RIFF + `XMP ` 块。
    fn build_webp_with_xmp(packet: &str) -> Vec<u8> {
        let payload = packet.as_bytes();
        let mut body = Vec::from(b"WEBP");
        body.extend_from_slice(b"XMP ");
        body.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        body.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            body.push(0x00);
        }
        let mut webp = Vec::from(b"RIFF");
        webp.extend_from_slice(&(body.len() as u32).to_le_bytes());
        webp.extend_from_slice(&body);
        webp
    }
}
