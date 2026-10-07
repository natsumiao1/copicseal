import type {
  ExportConflictStrategy,
  ExportDestination,
  ExportFitAxis,
  ExportPresetProfile,
} from '@/shared/types/export';

/** 「存储至」的中文标签，下拉选项与摘要共用。 */
export const EXPORT_DESTINATION_LABELS: Record<ExportDestination, string> = {
  'app-dir': '设置的导出目录',
  'source-dir': '原始文件位置',
  custom: '自定义目录',
};

/** 「管理冲突」的中文标签。 */
export const EXPORT_CONFLICT_LABELS: Record<ExportConflictStrategy, string> = {
  'unique-name': '创建具有唯一性的文件名',
  overwrite: '覆盖同名文件',
};

/** 「调整大小至」基准轴的中文标签。 */
export const EXPORT_FIT_AXIS_LABELS: Record<ExportFitAxis, string> = {
  long: '长边',
  short: '短边',
  width: '宽度',
  height: '高度',
};

/** 预设 id 序号：本地递增即可，不与持久化数据冲突（id 只在会话内判等）。 */
let presetSeq = 0;

/** 生成一个预设 id。 */
export function createExportPresetId(): string {
  presetSeq += 1;
  return `export-preset-${Date.now().toString(36)}-${presetSeq}`;
}

/**
 * 新建预设的默认值：设置的导出目录 + JPEG 90 + 长边 2000 + 保留元数据。
 *
 * `id` 供首次启动生成种子预设时使用（`'default'`）。
 */
export function createExportPresetProfile(id?: string): ExportPresetProfile {
  return {
    id: id ?? createExportPresetId(),
    name: '',
    destination: 'app-dir',
    customPath: null,
    subfolder: null,
    conflict: 'unique-name',
    format: 'jpeg',
    quality: 90,
    sizing: { mode: 'fit', axis: 'long', px: 2000, noUpscale: false },
    includeExif: true,
    stripGps: false,
  };
}

/** 新建预设的自动命名：`预设 N`（与既有名字冲突时顺延）。 */
export function nextExportPresetName(existing: readonly ExportPresetProfile[]): string {
  const names = new Set(existing.map((profile) => profile.name));
  let index = existing.length + 1;
  while (names.has(`预设 ${index}`)) {
    index += 1;
  }
  return `预设 ${index}`;
}

/**
 * 预设行的摘要：格式与画质 · 尺寸意图 · 去向（含子文件夹）。
 *
 * 一行看全关键参数，不用点开编辑弹窗。
 */
export function describeExportPreset(profile: ExportPresetProfile): string {
  const parts: string[] = [];

  parts.push(profile.format === 'jpeg' ? `JPEG 品质 ${profile.quality}` : 'PNG');

  if (profile.sizing.mode === 'scale') {
    parts.push(`缩放 ${profile.sizing.percent}%`);
  } else {
    const axis = EXPORT_FIT_AXIS_LABELS[profile.sizing.axis];
    parts.push(`${axis} ${profile.sizing.px}px${profile.sizing.noUpscale ? '（不放大）' : ''}`);
  }

  let destination = EXPORT_DESTINATION_LABELS[profile.destination];
  if (profile.destination === 'custom' && profile.customPath) {
    destination = profile.customPath;
  }
  if (profile.subfolder) {
    destination = `${destination} / ${profile.subfolder}`;
  }
  parts.push(destination);

  return parts.join(' · ');
}
