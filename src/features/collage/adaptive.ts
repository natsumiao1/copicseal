import { clamp } from './lib';
import type {
  AdaptiveInsertDirection,
  AdaptiveNode,
  AdaptivePhotoFit,
  AdaptiveRect,
  AdaptiveSplitRect,
} from './types';

/** 宽高未知时的兜底比例（3:2），仅在导入元数据解析失败时使用。 */
export const FALLBACK_PHOTO_RATIO = 3 / 2;
/** 比例收敛区间：避免极端全景/长条图把布局拉崩（0.1 ≈ 10:1，10 ≈ 1:10）。 */
const MIN_RATIO = 0.1;
const MAX_RATIO = 10;

/** 由 photoId 解析照片自然宽高比（宽/高）的回调。 */
export type AdaptiveRatioResolver = (photoId: string) => number;

/**
 * 照片的自然宽高比（宽/高）。
 *
 * 自适应布局的所有几何计算都基于它：格子比例 == 照片比例，
 * 配合 object-cover 渲染即无变形、无可见裁切。
 */
export function photoRatio(photo: { width: number; height: number }): number {
  if (!photo || photo.width <= 0 || photo.height <= 0) {
    return FALLBACK_PHOTO_RATIO;
  }
  return Math.min(Math.max(photo.width / photo.height, MIN_RATIO), MAX_RATIO);
}

/** 树内是否已包含该照片（同图在画布里只保留一份）。 */
export function hasAdaptivePhoto(tree: AdaptiveNode | null, photoId: string): boolean {
  if (!tree) {
    return false;
  }
  if (tree.type === 'leaf') {
    return tree.photoId === photoId;
  }
  return hasAdaptivePhoto(tree.children[0], photoId) || hasAdaptivePhoto(tree.children[1], photoId);
}

/** 按渲染顺序收集树内全部 photoId。 */
export function collectAdaptivePhotoIds(tree: AdaptiveNode | null): string[] {
  if (!tree) {
    return [];
  }
  if (tree.type === 'leaf') {
    return [tree.photoId];
  }
  return [
    ...collectAdaptivePhotoIds(tree.children[0]),
    ...collectAdaptivePhotoIds(tree.children[1]),
  ];
}

/**
 * 把新照片插入到目标照片的指定方位：目标 leaf 原地变成 split 节点。
 *
 * - left/right → `dir: 'v'` 左右分列（children[0] 在左）
 * - top/bottom → `dir: 'h'` 上下分行（children[0] 在上）
 * - 空树 → 新照片直接成为根 leaf；目标不存在或新图已存在 → 原树不变
 */
export function insertAdaptivePhoto(
  tree: AdaptiveNode | null,
  targetPhotoId: string,
  direction: AdaptiveInsertDirection,
  newPhotoId: string,
): AdaptiveNode {
  if (!tree) {
    return { type: 'leaf', photoId: newPhotoId };
  }
  if (hasAdaptivePhoto(tree, newPhotoId)) {
    return tree;
  }

  const insert = (node: AdaptiveNode): AdaptiveNode => {
    if (node.type === 'leaf') {
      if (node.photoId !== targetPhotoId) {
        return node;
      }
      const newLeaf: AdaptiveNode = { type: 'leaf', photoId: newPhotoId };
      const dir = direction === 'left' || direction === 'right' ? 'v' : 'h';
      const newFirst = direction === 'left' || direction === 'top';
      return {
        type: 'split',
        dir,
        children: newFirst ? [newLeaf, node] : [node, newLeaf],
      };
    }

    return {
      type: 'split',
      dir: node.dir,
      children: [insert(node.children[0]), insert(node.children[1])],
    };
  };

  return insert(tree);
}

/** 照片边缘与画布内容边界（0..1 相对坐标）的贴合容差，吸收比例运算的浮点误差。 */
const EDGE_FLUSH_EPSILON = 1e-4;

/**
 * 照片的某条边是否贴合画布内容外沿。
 *
 * 只服务于格间距内缩：贴外沿的边不缩 `gap/2`，间距仅作用于照片之间，
 * 外圈留白完全交给「边距」。拖放判定不再依据它——照片上的落点一律细分该照片。
 */
export function isAdaptiveEdgeFlush(
  rect: AdaptiveRect,
  direction: AdaptiveInsertDirection,
): boolean {
  switch (direction) {
    case 'left':
      return rect.x <= EDGE_FLUSH_EPSILON;
    case 'right':
      return rect.x + rect.width >= 1 - EDGE_FLUSH_EPSILON;
    case 'top':
      return rect.y <= EDGE_FLUSH_EPSILON;
    case 'bottom':
      return rect.y + rect.height >= 1 - EDGE_FLUSH_EPSILON;
  }
}

/**
 * 沿画布外沿的指定方位整体插入新照片：根节点一分为二，
 * 新照片独占该侧的一整行（top/bottom）或一整列（left/right）。
 * 空树 = 新照片直接成为根 leaf；同图已存在则原树不变。
 */
export function insertAdaptiveRoot(
  tree: AdaptiveNode | null,
  direction: AdaptiveInsertDirection,
  newPhotoId: string,
): AdaptiveNode {
  if (!tree) {
    return { type: 'leaf', photoId: newPhotoId };
  }
  if (hasAdaptivePhoto(tree, newPhotoId)) {
    return tree;
  }

  const newLeaf: AdaptiveNode = { type: 'leaf', photoId: newPhotoId };
  const dir = direction === 'left' || direction === 'right' ? 'v' : 'h';
  const newFirst = direction === 'left' || direction === 'top';
  return {
    type: 'split',
    dir,
    children: newFirst ? [newLeaf, tree] : [tree, newLeaf],
  };
}

/** 替换目标照片（中心区拖放）：树形不变，只换 leaf 的 photoId；取景调整针对旧图构图，随替换重置。 */
export function replaceAdaptivePhoto(
  tree: AdaptiveNode | null,
  targetPhotoId: string,
  newPhotoId: string,
): AdaptiveNode | null {
  if (!tree) {
    return null;
  }
  if (newPhotoId === targetPhotoId || hasAdaptivePhoto(tree, newPhotoId)) {
    return tree;
  }

  const walk = (node: AdaptiveNode): AdaptiveNode => {
    if (node.type === 'leaf') {
      return node.photoId === targetPhotoId ? { type: 'leaf', photoId: newPhotoId } : node;
    }
    return {
      type: 'split',
      dir: node.dir,
      children: [walk(node.children[0]), walk(node.children[1])],
    };
  };

  return walk(tree);
}

/**
 * 移除一张照片，父节点自动塌缩：
 * split 少了一个孩子后直接退化为另一个孩子，保证树始终是合法的完整二分。
 */
export function removeAdaptivePhoto(
  tree: AdaptiveNode | null,
  photoId: string,
): AdaptiveNode | null {
  if (!tree) {
    return null;
  }
  if (tree.type === 'leaf') {
    return tree.photoId === photoId ? null : tree;
  }

  const first = removeAdaptivePhoto(tree.children[0], photoId);
  const second = removeAdaptivePhoto(tree.children[1], photoId);
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return { type: 'split', dir: tree.dir, children: [first, second] };
}

/** 清除 photoId 已失效（不在会话中）的叶子，逻辑同移除塌缩。 */
export function pruneAdaptiveTree(
  tree: AdaptiveNode | null,
  isValid: (photoId: string) => boolean,
): AdaptiveNode | null {
  if (!tree) {
    return null;
  }
  if (tree.type === 'leaf') {
    return isValid(tree.photoId) ? tree : null;
  }

  const first = pruneAdaptiveTree(tree.children[0], isValid);
  const second = pruneAdaptiveTree(tree.children[1], isValid);
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return { type: 'split', dir: tree.dir, children: [first, second] };
}

/** 节点的自然比例：leaf = 照片比例；左右分等高相加，上下分等宽按高度倒数相加。 */
function nodeRatio(node: AdaptiveNode, resolve: AdaptiveRatioResolver): number {
  if (node.type === 'leaf') {
    return resolve(node.photoId);
  }

  const first = nodeRatio(node.children[0], resolve);
  const second = nodeRatio(node.children[1], resolve);
  if (node.dir === 'v') {
    return first + second;
  }
  return 1 / (1 / first + 1 / second);
}

/** 画布整体比例 = 根节点比例（跟随内容）；空树按 1:1。 */
export function getAdaptiveRootRatio(
  tree: AdaptiveNode | null,
  resolve: AdaptiveRatioResolver,
): number {
  if (!tree) {
    return 1;
  }
  const ratio = nodeRatio(tree, resolve);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : FALLBACK_PHOTO_RATIO;
}

/** 手动分割比例的取值范围：读写都钳在这里，避免接缝被拖成零宽/零高。 */
const MIN_SPLIT_RATIO = 0.05;
const MAX_SPLIT_RATIO = 0.95;

/**
 * 一个分割节点的占比（children[0] 在分割轴上的份额）：
 * 手动值优先（读取时钳到安全范围），否则按照片宽高比推导——与旧行为完全一致。
 */
function effectiveShare(
  node: Extract<AdaptiveNode, { type: 'split' }>,
  resolve: AdaptiveRatioResolver,
): number {
  if (node.ratio !== undefined) {
    return Math.min(Math.max(node.ratio, MIN_SPLIT_RATIO), MAX_SPLIT_RATIO);
  }
  const first = nodeRatio(node.children[0], resolve);
  const second = nodeRatio(node.children[1], resolve);
  if (node.dir === 'v') {
    return first / (first + second);
  }
  const firstInverse = 1 / first;
  const secondInverse = 1 / second;
  return firstInverse / (firstInverse + secondInverse);
}

/**
 * 按路径写入手动分割比例：`path` 为从根出发的子索引序列，定位到 split 节点；
 * `ratio` 为 null 时移除手动值（恢复按照片比例自动推导）。路径无效时原树不动。
 */
export function setAdaptiveSplitRatio(
  tree: AdaptiveNode | null,
  path: readonly number[],
  ratio: number | null,
): AdaptiveNode | null {
  if (!tree) {
    return null;
  }

  const walk = (node: AdaptiveNode, depth: number): AdaptiveNode => {
    if (node.type === 'leaf') {
      return node;
    }
    if (depth === path.length) {
      if (ratio === null) {
        // 恢复自动：重建节点丢掉 ratio 字段（原地 delete 会破坏不可变约定）
        return node.ratio === undefined
          ? node
          : { type: 'split', dir: node.dir, children: node.children };
      }
      const next = Math.min(Math.max(ratio, MIN_SPLIT_RATIO), MAX_SPLIT_RATIO);
      return node.ratio === next ? node : { ...node, ratio: next };
    }
    const index = path[depth];
    if (index !== 0 && index !== 1) {
      return node;
    }
    const child = walk(node.children[index], depth + 1);
    if (child === node.children[index]) {
      return node;
    }
    const children: [AdaptiveNode, AdaptiveNode] = [...node.children];
    children[index] = child;
    return { ...node, children };
  };

  return walk(tree, 0);
}

/** 格内取景的缩放范围（与 Grid「选中项」一致：1x ~ 3x）。 */
const MIN_FIT_SCALE = 1;
const MAX_FIT_SCALE = 3;

/** 未调整时的默认取景：渲染不加 transform，与旧数据表现完全一致。 */
export const DEFAULT_ADAPTIVE_FIT: AdaptivePhotoFit = { scale: 1, offsetX: 0, offsetY: 0 };

/**
 * 取景位移的可达上限（单位 = 格子尺寸的比例，两轴独立）。
 *
 * 照片经 `object-fit` 渲染进格子后的盈缩比（`ratio`，相对格子宽 / 高）再乘 `scale`，
 * 位移到「照片边缘正好贴住格子边」时的中心偏移量——cover 下保证永远不露背景缝，
 * contain 下保证照片不会被拖出格子；两种模式统一为 `|ratio × scale − 1| / 2`
 * （照片恰好铺满时上限为 0，需要先放大才可平移）。
 */
export function adaptivePhotoFitLimits(
  cellAspect: number,
  photoAspect: number,
  fillMode: 'cover' | 'contain',
  scale: number,
): { x: number; y: number } {
  const cell = Number.isFinite(cellAspect) && cellAspect > 0 ? cellAspect : 1;
  const photo =
    Number.isFinite(photoAspect) && photoAspect > 0 ? photoAspect : FALLBACK_PHOTO_RATIO;
  const cover = fillMode !== 'contain';
  const ratioW = cover ? Math.max(1, photo / cell) : Math.min(1, photo / cell);
  const ratioH = cover ? Math.max(1, cell / photo) : Math.min(1, cell / photo);
  return {
    x: Math.abs(ratioW * scale - 1) / 2,
    y: Math.abs(ratioH * scale - 1) / 2,
  };
}

/**
 * 把取景钳到安全范围：`scale` 1~3，位移不超过 `adaptivePhotoFitLimits` 的可达上限，
 * 非法数值（NaN / Infinity）归到默认。渲染与写入共用，任何来源的值都不会露缝 / 出格。
 */
export function clampAdaptivePhotoFit(
  fit: AdaptivePhotoFit,
  cellAspect: number,
  photoAspect: number,
  fillMode: 'cover' | 'contain',
): AdaptivePhotoFit {
  const scale = clamp(Number.isFinite(fit.scale) ? fit.scale : 1, MIN_FIT_SCALE, MAX_FIT_SCALE);
  const limits = adaptivePhotoFitLimits(cellAspect, photoAspect, fillMode, scale);
  return {
    scale,
    offsetX: clamp(Number.isFinite(fit.offsetX) ? fit.offsetX : 0, -limits.x, limits.x),
    offsetY: clamp(Number.isFinite(fit.offsetY) ? fit.offsetY : 0, -limits.y, limits.y),
  };
}

/**
 * 写入叶子的格内取景（按 photoId 定位——同图在画布只保留一份）。
 * `fit` 为 null 时移除字段恢复默认（双击照片 / 面板重置）；没有该照片则原树不动。
 * `scale` 在此统一钳 1~3；位移需要格子与照片比例才能钳到位，由调用方先钳再传。
 */
export function setAdaptivePhotoFit(
  tree: AdaptiveNode | null,
  photoId: string,
  fit: AdaptivePhotoFit | null,
): AdaptiveNode | null {
  if (!tree) {
    return null;
  }

  const walk = (node: AdaptiveNode): AdaptiveNode => {
    if (node.type === 'leaf') {
      if (node.photoId !== photoId) {
        return node;
      }
      if (fit === null) {
        // 恢复默认：重建节点丢掉 fit 字段（原地 delete 会破坏不可变约定）
        return node.fit === undefined ? node : { type: 'leaf', photoId: node.photoId };
      }
      const scale = clamp(Number.isFinite(fit.scale) ? fit.scale : 1, MIN_FIT_SCALE, MAX_FIT_SCALE);
      const offsetX = Number.isFinite(fit.offsetX) ? fit.offsetX : 0;
      const offsetY = Number.isFinite(fit.offsetY) ? fit.offsetY : 0;
      const current = node.fit;
      if (
        current &&
        current.scale === scale &&
        current.offsetX === offsetX &&
        current.offsetY === offsetY
      ) {
        return node;
      }
      return { ...node, fit: { scale, offsetX, offsetY } };
    }

    const first = walk(node.children[0]);
    const second = walk(node.children[1]);
    if (first === node.children[0] && second === node.children[1]) {
      return node;
    }
    const children: [AdaptiveNode, AdaptiveNode] = [first, second];
    return { ...node, children };
  };

  return walk(tree);
}

/** 自适应布局的完整几何：叶子矩形（渲染照片）+ 分割节点矩形（渲染拖调把手）。 */
export interface AdaptiveGeometry {
  leaves: AdaptiveRect[];
  splits: AdaptiveSplitRect[];
}

/**
 * 递归计算每个叶子的相对矩形（0..1）与每个分割节点的矩形/接缝占比。
 *
 * 左右分：两子树等高，宽度按占比分配；上下分：两子树等宽，高度按占比分配。
 * 占比取 `effectiveShare`：无手动值时自动推导，此时每个 leaf 的矩形比例 == 该照片的
 * 自然比例，拼合无缝、零留白；拖过分割线后按手动值分配，格子比例偏离照片比例。
 */
export function computeAdaptiveGeometry(
  tree: AdaptiveNode | null,
  resolve: AdaptiveRatioResolver,
): AdaptiveGeometry {
  if (!tree) {
    return { leaves: [], splits: [] };
  }

  const leaves: AdaptiveRect[] = [];
  const splits: AdaptiveSplitRect[] = [];
  const walk = (
    node: AdaptiveNode,
    path: number[],
    x: number,
    y: number,
    width: number,
    height: number,
  ): void => {
    if (node.type === 'leaf') {
      leaves.push({
        photoId: node.photoId,
        ...(node.fit ? { fit: node.fit } : {}),
        x,
        y,
        width,
        height,
      });
      return;
    }

    const share = effectiveShare(node, resolve);
    splits.push({ path, dir: node.dir, x, y, width, height, share });
    if (node.dir === 'v') {
      walk(node.children[0], [...path, 0], x, y, width * share, height);
      walk(node.children[1], [...path, 1], x + width * share, y, width * (1 - share), height);
      return;
    }
    walk(node.children[0], [...path, 0], x, y, width, height * share);
    walk(node.children[1], [...path, 1], x, y + height * share, width, height * (1 - share));
  };

  walk(tree, [], 0, 0, 1, 1);
  return { leaves, splits };
}
