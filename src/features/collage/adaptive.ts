import type { AdaptiveInsertDirection, AdaptiveNode, AdaptiveRect } from './types';

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

/** 替换目标照片（中心区拖放）：树形不变，只换 leaf 的 photoId。 */
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

/**
 * 递归计算每张照片的相对矩形（0..1）。
 *
 * 左右分：两子树等高，宽度按比例分配；上下分：两子树等宽，高度按 1/比例 分配。
 * 因此每个 leaf 的矩形比例 == 该照片的自然比例，拼合无缝、零留白。
 */
export function computeAdaptiveRects(
  tree: AdaptiveNode | null,
  resolve: AdaptiveRatioResolver,
): AdaptiveRect[] {
  if (!tree) {
    return [];
  }

  const rects: AdaptiveRect[] = [];
  const walk = (node: AdaptiveNode, x: number, y: number, width: number, height: number): void => {
    if (node.type === 'leaf') {
      rects.push({ photoId: node.photoId, x, y, width, height });
      return;
    }

    const first = nodeRatio(node.children[0], resolve);
    const second = nodeRatio(node.children[1], resolve);
    if (node.dir === 'v') {
      const share = first / (first + second);
      walk(node.children[0], x, y, width * share, height);
      walk(node.children[1], x + width * share, y, width * (1 - share), height);
      return;
    }

    const firstShare = 1 / first;
    const secondShare = 1 / second;
    const share = firstShare / (firstShare + secondShare);
    walk(node.children[0], x, y, width, height * share);
    walk(node.children[1], x, y + height * share, width, height * (1 - share));
  };

  walk(tree, 0, 0, 1, 1);
  return rects;
}
