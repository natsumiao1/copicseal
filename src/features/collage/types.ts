export type CollageAspectPreset = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '16:10' | 'custom';
export type CollageLayoutMode = 'grid' | 'free' | 'adaptive';

/** 自适应布局的插入方位：新照片落在目标照片的哪一侧。 */
export type AdaptiveInsertDirection = 'left' | 'right' | 'top' | 'bottom';

/**
 * 自适应布局树：叶子 = 一张照片；split = 把父矩形按方向二分。
 * `dir: 'v'` 左右分两列（children[0] 在左），`'h'` 上下分两行（children[0] 在上）。
 * `ratio` = 手动分割比例（children[0] 占分割轴的比例）；缺省则按两侧照片宽高比自动推导，
 * 存量数据无此字段，行为与从前一致。
 */
export type AdaptiveNode =
  | { type: 'leaf'; photoId: string }
  | { type: 'split'; dir: 'h' | 'v'; children: [AdaptiveNode, AdaptiveNode]; ratio?: number };

/** 自适应布局中一张照片的画布矩形（相对坐标，0..1）。 */
export interface AdaptiveRect {
  photoId: string;
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
