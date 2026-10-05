import type { FolderImageFile, ImageTags } from '@/platform/contracts';

/** 五种标准颜色标签（XMP `xmp:Label` 的取值）。 */
export const COLOR_LABELS = ['red', 'yellow', 'green', 'blue', 'purple'] as const;
export type ColorLabel = (typeof COLOR_LABELS)[number];

/** 颜色标签的中文名，用于筛选器的悬浮提示与无障碍标签。 */
export const COLOR_LABEL_TEXT: Record<ColorLabel, string> = {
  red: '红色',
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  purple: '紫色',
};

/** 星级取值 1-5。 */
export const STAR_LEVELS = [1, 2, 3, 4, 5] as const;

/** XMP 原始标签值（大小写不敏感）→ 归一化的颜色标签枚举。 */
const XMP_LABEL_MAP: Record<string, ColorLabel> = {
  red: 'red',
  yellow: 'yellow',
  green: 'green',
  blue: 'blue',
  purple: 'purple',
};

/** 把 XMP 读到的标签值归一化成枚举；未知值按无标签处理。 */
export function normalizeColorLabel(label: string | null | undefined): ColorLabel | null {
  if (!label) {
    return null;
  }
  return XMP_LABEL_MAP[label.trim().toLowerCase()] ?? null;
}

/** 一组筛选条件；某字段为空数组表示该维度不限。 */
export interface FilterCriteria {
  /** 选中的星级（1-5） */
  ratings: number[];
  /** 选中的颜色标签 */
  labels: ColorLabel[];
  /** 选中的文件扩展名（小写、无点） */
  types: string[];
  /** 选中的长宽比（最简比，如 `3:2`） */
  ratios: string[];
}

/** 文件扩展名（小写、无点）；无扩展名返回空串。 */
export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

/**
 * 把宽高约分为最简整数比（4032×3024 → `4:3`）；宽高未知返回 `null`。
 *
 * 方向保留在比值里：3:2 与 2:3 是两个不同选项。
 */
export function aspectRatioLabel(width: number, height: number): string | null {
  if (width <= 0 || height <= 0) {
    return null;
  }
  let left = width;
  let right = height;
  while (right !== 0) {
    [left, right] = [right, left % right];
  }
  return `${width / left}:${height / left}`;
}

/** 当前目录的筛选可用项：类型 / 长宽比 → 数量统计。 */
export interface FolderAvailability {
  /** 实际存在的文件扩展名（小写、无点） → 条目数量 */
  types: Map<string, number>;
  /** 实际存在的长宽比（最简比） → 条目数量；宽高未知的条目不计入 */
  ratios: Map<string, number>;
}

/**
 * 统计当前目录可用于筛选的类型与长宽比（一次遍历）。
 *
 * 数量都是目录总数，不随其它筛选条件变化——它回答的是「这个文件夹里
 * 这个取值各有多少张」，与底部的「命中 N」分工不同。
 */
export function collectAvailability(entries: FolderImageFile[]): FolderAvailability {
  const types = new Map<string, number>();
  const ratios = new Map<string, number>();
  for (const entry of entries) {
    const extension = fileExtension(entry.name);
    if (extension) {
      types.set(extension, (types.get(extension) ?? 0) + 1);
    }
    const ratio = aspectRatioLabel(entry.width, entry.height);
    if (ratio) {
      ratios.set(ratio, (ratios.get(ratio) ?? 0) + 1);
    }
  }
  return { types, ratios };
}

/** 星级 / 颜色标签的数量统计（与 `FolderAvailability` 同口径：目录总数）。 */
export interface TagCounts {
  /** 各星级（1-5）的照片数；无评级或评级越界不计入 */
  ratings: Map<number, number>;
  /** 各颜色标签的照片数；无标签不计入 */
  labels: Map<ColorLabel, number>;
}

/**
 * 统计目录里各星级 / 颜色标签的数量，供筛选器显示。
 *
 * 标签未就绪时面板显示占位（调用方自行判断 `tagsReady`），这里照常统计，
 * 结果为空 map 即可。
 */
export function collectTagCounts(
  entries: FolderImageFile[],
  tags: Record<string, ImageTags>,
): TagCounts {
  const ratings = new Map<number, number>();
  const labels = new Map<ColorLabel, number>();
  for (const entry of entries) {
    const tag = tags[entry.path];
    const rating = tag?.rating ?? null;
    if (rating !== null && rating >= 1 && rating <= 5) {
      ratings.set(rating, (ratings.get(rating) ?? 0) + 1);
    }
    const label = normalizeColorLabel(tag?.label);
    if (label) {
      labels.set(label, (labels.get(label) ?? 0) + 1);
    }
  }
  return { ratings, labels };
}

/** 任一维度有选中项即视为筛选生效。 */
export function hasCriteria(criteria: FilterCriteria): boolean {
  return (
    criteria.ratings.length > 0 ||
    criteria.labels.length > 0 ||
    criteria.types.length > 0 ||
    criteria.ratios.length > 0
  );
}

/**
 * 按目录实际存在的取值收敛一个维度：目录里没有用户选过的任何取值时
 * （多为换目录后遗留的旧条件），退化为不限，避免整栏被清空。
 *
 * `available` 可传 `Set` 或计数 `Map`——都按「是否存在于当前目录」判断。
 */
function resolvePresent(
  selected: string[],
  available: { has: (key: string) => boolean },
): string[] {
  if (selected.length === 0) {
    return [];
  }
  const effective = selected.filter((value) => available.has(value));
  return effective.length > 0 ? effective : [];
}

/**
 * 把条件收敛到当前可执行的形态：
 *
 * - 类型与长宽比条件按目录实际存在的取值收敛（见 `resolvePresent`）；
 * - 标签条件在标签数据就绪前暂不生效——读取期间先显示全部，就绪后再收窄，
 *   避免筛选栏闪成空列表。
 *
 * 内容面板与筛选器都用它计算命中，保证两边看到的集合一致。
 */
export function resolveCriteria(
  criteria: FilterCriteria,
  availability: FolderAvailability,
  tagsReady: boolean,
): FilterCriteria {
  return {
    types: resolvePresent(criteria.types, availability.types),
    ratios: resolvePresent(criteria.ratios, availability.ratios),
    ratings: tagsReady ? criteria.ratings : [],
    labels: tagsReady ? criteria.labels : [],
  };
}

/**
 * 判断条目是否通过筛选：各维度之间取 AND、维度内取 OR；空维度不限。
 *
 * 调用前应先经 `resolveCriteria` 收敛（未就绪的标签维度会被清空）。
 */
export function matchesFilter(
  entry: FolderImageFile,
  criteria: FilterCriteria,
  tags: Record<string, ImageTags>,
): boolean {
  if (criteria.types.length > 0 && !criteria.types.includes(fileExtension(entry.name))) {
    return false;
  }
  if (criteria.ratios.length > 0) {
    // 宽高未知的条目在长宽比条件生效时不命中
    const ratio = aspectRatioLabel(entry.width, entry.height);
    if (!ratio || !criteria.ratios.includes(ratio)) {
      return false;
    }
  }
  if (criteria.ratings.length === 0 && criteria.labels.length === 0) {
    return true;
  }

  const tag = tags[entry.path];
  const rating = tag?.rating ?? null;
  const label = normalizeColorLabel(tag?.label);
  const ratingOk =
    criteria.ratings.length === 0 || (rating !== null && criteria.ratings.includes(rating));
  const labelOk =
    criteria.labels.length === 0 || (label !== null && criteria.labels.includes(label));
  return ratingOk && labelOk;
}
