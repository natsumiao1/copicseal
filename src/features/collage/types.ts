export type CollageAspectPreset = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '16:10' | 'custom';
export type CollageLayoutMode = 'grid' | 'free' | 'adaptive';

/** 自适应布局的插入方位：新照片落在目标照片的哪一侧。 */
export type AdaptiveInsertDirection = 'left' | 'right' | 'top' | 'bottom';

/**
 * 自适应叶子的格内取景调整：
 * `scale` = 相对 object-fit 原始框的放大倍数（1 ~ 3）；`offsetX/offsetY` = 位移，
 * 以**格子尺寸的比例**计量（0.25 = 格宽的 1/4）——随格子缩放同比例保持，视口变化不漂移。
 * 缺省（字段不存在）= 未调整，存量数据行为与从前一致。
 */
export interface AdaptivePhotoFit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * 自适应布局树：叶子 = 一张照片；split = 把父矩形按方向二分。
 * `dir: 'v'` 左右分两列（children[0] 在左），`'h'` 上下分两行（children[0] 在上）。
 * `ratio` = 手动分割比例（children[0] 占分割轴的比例）；缺省则按两侧照片宽高比自动推导，
 * 存量数据无此字段，行为与从前一致。
 */
export type AdaptiveNode =
  | { type: 'leaf'; photoId: string; fit?: AdaptivePhotoFit }
  | { type: 'split'; dir: 'h' | 'v'; children: [AdaptiveNode, AdaptiveNode]; ratio?: number };

/** 自适应布局中一张照片的画布矩形（相对坐标，0..1）。 */
export interface AdaptiveRect {
  photoId: string;
  /** 格内取景（未调整时缺省）：几何计算时从叶子带出，渲染与拖拽共用钳后值 */
  fit?: AdaptivePhotoFit;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 自适应布局中一个分割节点的矩形与接缝位置：把手按它叠在分割线上拖调比例。 */
export interface AdaptiveSplitRect {
  /** 从根出发的子索引序列，定位该 split 节点（根节点为空数组） */
  path: number[];
  dir: 'h' | 'v';
  x: number;
  y: number;
  width: number;
  height: number;
  /** children[0] 在分割轴上的有效占比（含手动覆盖），接缝位置 = 起点 + 边长 × share */
  share: number;
}

export type CollageAnnotationType = 'text' | 'arrow' | 'rect' | 'circle';

export interface CollageLayoutSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CollageLayout {
  id: string;
  name: string;
  count: number;
  group: string;
  slots: CollageLayoutSlot[];
}

export interface CollageSlotState {
  photoId: string | null;
  scale: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
  borderRadius: number | null;
}

export interface CollageCanvasState {
  layoutMode: CollageLayoutMode;
  aspectPreset: CollageAspectPreset;
  customRatioWidth: number;
  customRatioHeight: number;
  backgroundColor: string;
  backgroundImage: string | null;
  gap: number;
  padding: number;
  borderRadius: number;
  shadow: number;
  /**
   * 照片填充方式（画布级，全布局共用）：
   * `cover` 裁切填满格子，`contain` 完整显示、留白透出画布背景。
   * 旧持久化数据缺字段，读取处按 `cover` 兜底；自动比例下自适应布局两种模式渲染一致，
   * 拖过分割线（格子偏离照片比例）后生效。
   */
  fillMode: 'cover' | 'contain';
  /**
   * 自适应模式的画布比例策略：
   * `true`（默认）跟随内容 = 画布 = 根节点自然比例、照片树整框铺满；
   * `false` 固定为 `aspectPreset` 比例——画布套内容，照片树按自然比例整体居中，
   * 余量透出画布背景（照片零裁切）。仅自适应模式读取；
   * 旧持久化数据缺字段，读取处按 `true` 兜底。
   */
  adaptiveFollowContent: boolean;
}

export interface CollageTextAnnotation {
  id: string;
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color: string;
  text: string;
  fontSize: number;
}

export interface CollageArrowAnnotation {
  id: string;
  type: 'arrow';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color: string;
  strokeWidth: number;
}

export interface CollageShapeAnnotation {
  id: string;
  type: 'rect' | 'circle';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color: string;
  strokeWidth: number;
}

export type CollageAnnotation =
  | CollageTextAnnotation
  | CollageArrowAnnotation
  | CollageShapeAnnotation;

export interface CollagePresentState {
  layoutId: string;
  canvas: CollageCanvasState;
  slotItems: CollageSlotState[];
  annotations: CollageAnnotation[];
  /** 自适应布局树；仅 layoutMode === 'adaptive' 时有意义，null = 画布为空 */
  adaptiveTree: AdaptiveNode | null;
}
