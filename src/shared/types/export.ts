/**
 * 导出格式。
 *
 * 暂时不含 WebP：WKWebView 不支持 canvas 编码 WebP，`toBlob` 会静默退回 PNG，
 * 产出的是一个后缀为 `.webp` 的 PNG（体积与 PNG 相同、质量参数无效）。
 * 要恢复得先把 WebP 编码挪到 Rust 侧（`image` crate 已支持）。
 */
export type ExportFormat = 'jpeg' | 'png';

/**
 * 单档导出配置：一档 = 一组目标尺寸 + 一套编码参数。
 *
 * `width` / `height` 是必填的目标框。无背景时它只作 contain 约束，
 * 有背景时它就是画框的精确尺寸（整除尺寸解算见 `docs/features.md` 3.4）。
 */
export interface ExportPreset {
  id: string;
  /**
   * 导出文件名，不含扩展名。
   *
   * 留空表示自动命名：`<原图名>@<宽>x<高>`，会随目标尺寸一起变；
   * 一旦填了就用填写的名字，扩展名始终跟随 `format`。
   */
  fileName?: string;
  format: ExportFormat;
  /** 目标框宽度（像素） */
  width: number;
  /** 目标框高度（像素） */
  height: number;
  /** 用户倍率：在解算出的像素尺寸之上做位图超采样 */
  scale: number;
  /** 编码质量 1..100，仅 JPEG 生效 */
  quality: number;
}

export interface ExportTarget {
  width: number;
  height: number;
}

/**
 * 渲染尺寸适配器：把「解算并命中目标尺寸」这件事交给持有 DOM 的一方。
 *
 * 模板几何全部是渲染基准的倍数，解算需要先探针测量再反解，而背景模式还会改变
 * 画框与画布的关系，因此这一步必须由页面侧完成；返回的实际目标框用于自动命名
 * （`<原图名>@<宽>x<高>`），与 `ExportPreset.width/height` 无关。
 */
export interface ExportSizeAdapter {
  /** 解算并应用目标尺寸，返回时渲染已稳定；量不出目标框时抛错 */
  prepare: () => Promise<ExportTarget>;
}

/** 同名文件的处理方式。 */
export type ExportConflictStrategy = 'unique-name' | 'overwrite';

export interface ExportRunContext {
  /** 导出文件名主干，通常取原图文件名（不含扩展名） */
  baseName?: string;
  /** 模板导出所需的尺寸适配器；缺省时按 `ExportPreset` 的宽高直接捕获 */
  sizeAdapter?: ExportSizeAdapter;
  /** 输出目录；缺省时弹出保存对话框 */
  outputDir?: string | null;
  /** 同名文件处理；缺省 unique-name（批内去重 + 磁盘已存在则追加序号） */
  conflict?: ExportConflictStrategy;
}

export interface ExportOptions {
  presets: ExportPreset[];
  /** 仅写入 EXIF 分辨率元数据，不参与尺寸计算 */
  dpi: number;
  preserveExif: boolean;
  /** 保留 EXIF 时是否进一步抹掉 GPS 位置信息（仅 JPEG 有 EXIF 段） */
  stripGps?: boolean;
  exclude?: string[];
}

/**
 * 预设的存储去向。
 *
 * - `app-dir`：设置 → 导出里的「文件导出目录」
 * - `source-dir`：与原图同目录（拼图等没有单一原图的场景回落到导出目录）
 * - `custom`：预设自带的目录，路径见 `ExportPresetProfile.customPath`
 */
export type ExportDestination = 'app-dir' | 'source-dir' | 'custom';

/** 「调整大小至」的基准轴：长边 / 短边 / 宽度 / 高度。 */
export type ExportFitAxis = 'long' | 'short' | 'width' | 'height';

/**
 * 预设的输出尺寸意图。
 *
 * - `scale`：缩放图像——按照片原始像素的百分比（100 即 1:1；拼图页相对画布渲染尺寸）
 * - `fit`：调整大小至——主导轴精确命中 `px`，另一轴按画布比例推导；
 *   `noUpscale` 时不越过照片原始像素（拼图页为不放大到画布像素之上）
 */
export type ExportSizing =
  | { mode: 'scale'; percent: number }
  | { mode: 'fit'; axis: ExportFitAxis; px: number; noUpscale: boolean };

/**
 * 命名导出预设：一份完整的输出配置（存储 / 格式 / 尺寸 / 元数据）。
 *
 * 全局共享一份，两页共用（持久化见 `useExportPresetStore`）；页面只负责把
 * 各自的构图解算落地，输出侧参数全部来自预设。照片拖到预设行上即按它导出。
 */
export interface ExportPresetProfile {
  id: string;
  name: string;
  // —— 存储选项 ——
  destination: ExportDestination;
  /** destination 为 custom 时的目录；其余模式忽略 */
  customPath: string | null;
  /** 存储到指定名称的子文件夹；空表示直接写在目标目录下 */
  subfolder: string | null;
  /** 管理冲突 */
  conflict: ExportConflictStrategy;
  // —— 图像格式 ——
  format: ExportFormat;
  /** 图像品质 1..100，仅 JPEG 生效 */
  quality: number;
  // —— 图像调整尺寸 ——
  sizing: ExportSizing;
  // —— 元数据 ——
  /** 包含原始元数据：JPEG 保留 EXIF（PNG 本身没有 EXIF 段） */
  includeExif: boolean;
  /** 删除位置信息：抹掉 EXIF 里的 GPS 指针；仅在 includeExif 开启时生效 */
  stripGps: boolean;
}
