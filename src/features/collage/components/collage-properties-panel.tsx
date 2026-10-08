import { useEffect, useMemo, useRef, useState } from 'react';
import {
  adaptivePhotoFitLimits,
  clampAdaptivePhotoFit,
  computeAdaptiveGeometry,
  DEFAULT_ADAPTIVE_FIT,
  FALLBACK_PHOTO_RATIO,
  getAdaptiveRootRatio,
  photoRatio,
} from '@/features/collage/adaptive';
import {
  COLLAGE_RATIO_OPTIONS,
  clamp,
  MAX_CANVAS_RATIO,
  MIN_CANVAS_RATIO,
} from '@/features/collage/lib';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import { useFontPreviewStore } from '@/features/collage/store/use-font-preview-store';
import type { AdaptivePhotoFit, CollageTextAnnotation } from '@/features/collage/types';
import { CoPanelSection } from '@/shared/components/co-panel-section';
import { usePhotos } from '@/shared/hooks/use-photos';
import { useSystemFonts } from '@/shared/hooks/use-system-fonts';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';
import { Slider } from '@/shared/ui/slider';
import { Textarea } from '@/shared/ui/textarea';

/**
 * 字体下拉里「默认字体」的哨兵值：Radix Select 禁止空字符串 Item，
 * 以哨兵表达「不指定 fontFamily，沿用应用默认字体栈」。
 */
const FONT_DEFAULT_SENTINEL = '__default__';

interface RatioInputProps {
  value: number;
  onCommit: (value: number) => void;
}

/**
 * 自由比例的单侧数字输入：输入过程只改本地文本，失焦 / 回车才提交；
 * 提交值经父级钳制到安全比例（1:5 ~ 5:1）后回写，非法内容失焦还原。
 */
function RatioInput({ value, onCommit }: RatioInputProps) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 999) {
      setText(String(parsed));
      onCommit(parsed);
      return;
    }
    setText(String(value));
  };

  return (
    <Input
      type="number"
      min={1}
      max={999}
      inputMode="decimal"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
      }}
      className="h-7 w-16 text-right"
    />
  );
}

interface AnnotationTextEditorProps {
  annotation: CollageTextAnnotation;
}

/**
 * 「文字」调整区块：文案多行输入 + 字号 / 颜色 / 旋转 / 宽高 + 删除。
 *
 * 文案输入走 transient 手势：聚焦开基线、失焦收拢为一步历史（逐键提交会把
 * 撤销退化成按字符撤销）。组件在聚焦中被卸载时 React 不会触发 blur，
 * 卸载清理兜底收拢，避免 `transientBase` 泄漏导致后续改动不进历史。
 */
function CollageAnnotationTextEditor({ annotation }: AnnotationTextEditorProps) {
  const { updateAnnotation, removeAnnotation, beginTransient, endTransient } = useCollageStore();
  // 预览独立成店且这里只取 action（引用恒定）：悬浮写入不得重渲染编辑器，
  // 否则字体下拉随之重渲染、Radix 重跑 position()，触控板滚动会被拉回顶部
  const setFontPreview = useFontPreviewStore((state) => state.setFontPreview);
  const { fonts: systemFonts, loading: fontsLoading } = useSystemFonts();
  const focusedRef = useRef(false);

  /** 悬浮 / 键盘高亮选项时，让画布先预览该字体（不写入标注数据） */
  const previewFont = (family: string | undefined) =>
    setFontPreview({ id: annotation.id, fontFamily: family });
  const clearFontPreview = () => setFontPreview(null);

  // 选中值指向的字体可能已被系统卸载：补一个选项，保证下拉显示其名称而非占位
  const fonts = useMemo(() => {
    if (
      !annotation.fontFamily ||
      systemFonts.some((font) => font.family === annotation.fontFamily)
    ) {
      return systemFonts;
    }
    return [{ family: annotation.fontFamily, postscript_name: null }, ...systemFonts];
  }, [systemFonts, annotation.fontFamily]);

  useEffect(
    () => () => {
      if (focusedRef.current) {
        focusedRef.current = false;
        endTransient();
      }
      // 卸载兜底：下拉开着时切换选中 / 删除标注，预览不能残留
      setFontPreview(null);
    },
    [endTransient, setFontPreview],
  );

  return (
    <CoPanelSection
      variant="flat"
      title="文字"
      description="画布上直接拖动文字调整位置；字号按画布渲染尺寸计，随导出等比放大。"
    >
      <div className="space-y-4">
        <label htmlFor={`collage-annotation-text-${annotation.id}`} className="block space-y-1.5">
          <span className="text-xs font-medium text-foreground">文案</span>
          <Textarea
            id={`collage-annotation-text-${annotation.id}`}
            value={annotation.text}
            placeholder="输入文字…"
            rows={3}
            onFocus={() => {
              focusedRef.current = true;
              beginTransient();
            }}
            onChange={(event) => updateAnnotation(annotation.id, { text: event.target.value })}
            // 整段输入合并为一步历史：失焦时基线与当前值比对，未改动则不产生记录
            onBlur={() => {
              focusedRef.current = false;
              endTransient();
            }}
          />
        </label>

        <div>
          <span className="text-xs font-medium text-foreground">排列</span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => updateAnnotation(annotation.id, { vertical: false })}
              className={`border px-3 py-2 text-xs ${
                annotation.vertical
                  ? 'border-border'
                  : 'border-primary bg-primary/5 text-foreground'
              }`}
            >
              横排
            </button>
            <button
              type="button"
              onClick={() => updateAnnotation(annotation.id, { vertical: true })}
              className={`border px-3 py-2 text-xs ${
                annotation.vertical
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border'
              }`}
            >
              竖排
            </button>
          </div>
        </div>

        <div>
          <span className="text-xs font-medium text-foreground">字体</span>
          <Select
            value={annotation.fontFamily ?? FONT_DEFAULT_SENTINEL}
            onValueChange={(value) => {
              // 提交即落数据，同时收掉预览（画布回落到真实值，视觉无跳变）
              clearFontPreview();
              updateAnnotation(annotation.id, {
                fontFamily: value === FONT_DEFAULT_SENTINEL ? undefined : value,
              });
            }}
            onOpenChange={(open) => {
              // Esc / 点击外部关闭：没有提交，预览必须还原
              if (!open) clearFontPreview();
            }}
          >
            <SelectTrigger className="mt-2 w-full" disabled={fontsLoading}>
              <SelectValue placeholder={fontsLoading ? '字体加载中…' : '默认字体'} />
            </SelectTrigger>
            {/* 悬浮 / 键盘高亮即预览，离开选项区还原；数据只在真正选中时写入 */}
            <SelectContent onMouseLeave={clearFontPreview}>
              <SelectItem
                value={FONT_DEFAULT_SENTINEL}
                onMouseEnter={() => previewFont(undefined)}
                onFocus={() => previewFont(undefined)}
              >
                默认字体
              </SelectItem>
              {fonts.map((font) => (
                <SelectItem
                  key={font.family}
                  value={font.family}
                  onMouseEnter={() => previewFont(font.family)}
                  onFocus={() => previewFont(font.family)}
                >
                  {font.family}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>字号</span>
            <span>{Math.round(annotation.fontSize)}px</span>
          </div>
          <Slider
            value={[annotation.fontSize]}
            onValueChange={([value]) => updateAnnotation(annotation.id, { fontSize: value })}
            min={8}
            max={96}
            step={1}
          />
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-foreground">颜色</span>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={annotation.color}
              onChange={(event) => updateAnnotation(annotation.id, { color: event.target.value })}
              className="h-9 w-12 border border-border bg-background p-1"
            />
            <Input
              value={annotation.color}
              onChange={(event) => updateAnnotation(annotation.id, { color: event.target.value })}
            />
          </div>
        </label>

        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>旋转</span>
            <span>{Math.round(annotation.rotation)}deg</span>
          </div>
          <Slider
            value={[annotation.rotation]}
            onValueChange={([value]) => updateAnnotation(annotation.id, { rotation: value })}
            min={-180}
            max={180}
            step={1}
          />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>宽度</span>
            <span>{Math.round(annotation.width * 100)}%</span>
          </div>
          <Slider
            value={[annotation.width]}
            onValueChange={([value]) =>
              updateAnnotation(annotation.id, {
                width: value,
                // 变宽时右缘不得越出画布，同步回收 x
                x: Math.min(annotation.x, 1 - value),
              })
            }
            min={0.05}
            max={1}
            step={0.01}
          />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>高度</span>
            <span>{Math.round(annotation.height * 100)}%</span>
          </div>
          <Slider
            value={[annotation.height]}
            onValueChange={([value]) =>
              updateAnnotation(annotation.id, {
                height: value,
                y: Math.min(annotation.y, 1 - value),
              })
            }
            min={0.04}
            max={1}
            step={0.01}
          />
        </div>

        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => removeAnnotation(annotation.id)}
        >
          删除文字
        </Button>
      </div>
    </CoPanelSection>
  );
}

export function CollagePropertiesPanel() {
  const {
    present,
    selectedSlotIndex,
    selectedAdaptivePhotoId,
    selectedAnnotationId,
    updateCanvas,
    updateSlot,
    setAdaptivePhotoFit,
  } = useCollageStore();
  const { photos } = usePhotos();

  const selectedSlot =
    selectedSlotIndex !== null ? (present.slotItems[selectedSlotIndex] ?? null) : null;
  /** 选中的文字标注（选择与槽位/自适应照片互斥，非 text 类型当前不产生 UI 入口） */
  const selectedText =
    selectedAnnotationId !== null
      ? ((present.annotations.find(
          (item) => item.id === selectedAnnotationId && item.type === 'text',
        ) as CollageTextAnnotation | undefined) ?? null)
      : null;

  const isAdaptive = present.canvas.layoutMode === 'adaptive';
  /** 自适应画布比例：默认跟随内容（画布 = 根节点比例），可切固定比例（套内容、居中留白） */
  const adaptiveFollow = present.canvas.adaptiveFollowContent !== false;
  /** 自定义宽:高输入仅在「自定义比例」生效时显示（自适应跟随内容期间隐藏） */
  const showCustomRatioInputs =
    present.canvas.aspectPreset === 'custom' && (!isAdaptive || !adaptiveFollow);

  /**
   * 自适应格内取景：选中叶子的钳后取景与可达上限（仅自适应选中时有值）。
   * 格子比例按当前树现算——rect 相对内容框，内容框恒等比 == 照片树自然比例。
   */
  const adaptiveSelection = useMemo(() => {
    if (!isAdaptive || selectedAdaptivePhotoId === null) {
      return null;
    }
    const photoById = new Map(photos.map((photo) => [photo.id, photo]));
    const photo = photoById.get(selectedAdaptivePhotoId);
    const tree = present.adaptiveTree;
    if (!photo || !tree) {
      return null;
    }
    const resolveRatio = (photoId: string) => {
      const item = photoById.get(photoId);
      return item ? photoRatio(item) : FALLBACK_PHOTO_RATIO;
    };
    const rect = computeAdaptiveGeometry(tree, resolveRatio).leaves.find(
      (leaf) => leaf.photoId === selectedAdaptivePhotoId,
    );
    if (!rect) {
      return null;
    }
    const cellAspect =
      (rect.width / Math.max(rect.height, 1e-6)) * getAdaptiveRootRatio(tree, resolveRatio);
    const photoAspect = photoRatio(photo);
    const fillMode: 'cover' | 'contain' =
      present.canvas.fillMode === 'contain' ? 'contain' : 'cover';
    const fit = clampAdaptivePhotoFit(
      rect.fit ?? DEFAULT_ADAPTIVE_FIT,
      cellAspect,
      photoAspect,
      fillMode,
    );
    const limits = adaptivePhotoFitLimits(cellAspect, photoAspect, fillMode, fit.scale);
    return { photoId: selectedAdaptivePhotoId, fit, limits, cellAspect, photoAspect, fillMode };
  }, [isAdaptive, photos, present.adaptiveTree, present.canvas.fillMode, selectedAdaptivePhotoId]);

  /** 取景写入：以面板显示的钳后值为底、合入增量再整体钳一次（缩放变化会同步收紧位移） */
  const applyAdaptiveFit = (patch: Partial<AdaptivePhotoFit>) => {
    if (!adaptiveSelection) {
      return;
    }
    setAdaptivePhotoFit(
      adaptiveSelection.photoId,
      clampAdaptivePhotoFit(
        { ...adaptiveSelection.fit, ...patch },
        adaptiveSelection.cellAspect,
        adaptiveSelection.photoAspect,
        adaptiveSelection.fillMode,
      ),
    );
  };

  return (
    <div className="divide-y divide-border/60">
      <CoPanelSection variant="flat" title="布局" description="控制画布布局、间距与背景样式。">
        <div className="space-y-4">
          <div>
            <span className="text-xs font-medium text-foreground">画布比例</span>
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-3 gap-2">
                {isAdaptive ? (
                  <button
                    type="button"
                    onClick={() => updateCanvas({ adaptiveFollowContent: true })}
                    className={`border px-3 py-2 text-xs ${
                      adaptiveFollow
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-border'
                    }`}
                  >
                    跟随内容
                  </button>
                ) : null}
                {COLLAGE_RATIO_OPTIONS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() =>
                      updateCanvas({
                        aspectPreset: item.label,
                        ...(isAdaptive ? { adaptiveFollowContent: false } : {}),
                      })
                    }
                    className={`border px-3 py-2 text-xs ${
                      (!isAdaptive || !adaptiveFollow) && present.canvas.aspectPreset === item.label
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-border'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    updateCanvas({
                      aspectPreset: 'custom',
                      ...(isAdaptive ? { adaptiveFollowContent: false } : {}),
                    })
                  }
                  className={`border px-3 py-2 text-xs ${
                    (!isAdaptive || !adaptiveFollow) && present.canvas.aspectPreset === 'custom'
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-border'
                  }`}
                >
                  自定义
                </button>
              </div>
              {showCustomRatioInputs ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>宽</span>
                  <RatioInput
                    value={present.canvas.customRatioWidth}
                    onCommit={(value) =>
                      updateCanvas({
                        customRatioWidth: clamp(
                          value,
                          Math.max(1, present.canvas.customRatioHeight * MIN_CANVAS_RATIO),
                          present.canvas.customRatioHeight * MAX_CANVAS_RATIO,
                        ),
                      })
                    }
                  />
                  <span>:</span>
                  <span>高</span>
                  <RatioInput
                    value={present.canvas.customRatioHeight}
                    onCommit={(value) =>
                      updateCanvas({
                        customRatioHeight: clamp(
                          value,
                          Math.max(1, present.canvas.customRatioWidth * MIN_CANVAS_RATIO),
                          present.canvas.customRatioWidth * MAX_CANVAS_RATIO,
                        ),
                      })
                    }
                  />
                </div>
              ) : null}
              {isAdaptive ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  {adaptiveFollow
                    ? '画布比例由照片按布局自动推导；拖动分割线微调占比，或拖画布边角把手接管为固定比例。'
                    : '画布固定为所选比例，照片树按自然比例居中，余量透出画布背景，照片不裁切。'}
                </p>
              ) : null}
            </div>
          </div>

          <div>
            <span className="text-xs font-medium text-foreground">照片填充</span>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => updateCanvas({ fillMode: 'cover' })}
                className={`border px-3 py-2 text-xs ${
                  present.canvas.fillMode !== 'contain'
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border'
                }`}
              >
                裁切填满
              </button>
              <button
                type="button"
                onClick={() => updateCanvas({ fillMode: 'contain' })}
                className={`border px-3 py-2 text-xs ${
                  present.canvas.fillMode === 'contain'
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border'
                }`}
              >
                完整显示（留白）
              </button>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>间距</span>
              <span>{present.canvas.gap}px</span>
            </div>
            <Slider
              value={[present.canvas.gap]}
              onValueChange={([value]) => updateCanvas({ gap: value })}
              min={0}
              max={48}
              step={1}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>边距</span>
              <span>{present.canvas.padding}px</span>
            </div>
            <Slider
              value={[present.canvas.padding]}
              onValueChange={([value]) => updateCanvas({ padding: value })}
              min={0}
              max={80}
              step={1}
            />
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">背景色</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={present.canvas.backgroundColor}
                onChange={(event) => updateCanvas({ backgroundColor: event.target.value })}
                className="h-9 w-12 border border-border bg-background p-1"
              />
              <Input
                value={present.canvas.backgroundColor}
                onChange={(event) => updateCanvas({ backgroundColor: event.target.value })}
              />
            </div>
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>圆角</span>
              <span>{present.canvas.borderRadius}px</span>
            </div>
            <Slider
              value={[present.canvas.borderRadius]}
              onValueChange={([value]) => updateCanvas({ borderRadius: value })}
              min={0}
              max={48}
              step={1}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>阴影</span>
              <span>{present.canvas.shadow}</span>
            </div>
            <Slider
              value={[present.canvas.shadow]}
              onValueChange={([value]) => updateCanvas({ shadow: value })}
              min={0}
              max={40}
              step={1}
            />
          </div>
        </div>
      </CoPanelSection>

      {selectedText ? <CollageAnnotationTextEditor annotation={selectedText} /> : null}

      {isAdaptive ? (
        <CoPanelSection
          variant="flat"
          title="选中项"
          description={
            adaptiveSelection
              ? '在画布上直接拖动照片调整取景，双击照片重置；缩放越大，可平移的范围越大。'
              : '单击画布里的照片，可以单独调整它在格子里的取景。'
          }
        >
          {adaptiveSelection ? (
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>缩放</span>
                  <span>{adaptiveSelection.fit.scale.toFixed(2)}x</span>
                </div>
                <Slider
                  value={[adaptiveSelection.fit.scale]}
                  onValueChange={([value]) => applyAdaptiveFit({ scale: value })}
                  min={1}
                  max={3}
                  step={0.01}
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>水平位置</span>
                  <span>{Math.round(adaptiveSelection.fit.offsetX * 100)}%</span>
                </div>
                <Slider
                  value={[adaptiveSelection.fit.offsetX]}
                  onValueChange={([value]) => applyAdaptiveFit({ offsetX: value })}
                  min={-Math.max(adaptiveSelection.limits.x, 0.01)}
                  max={Math.max(adaptiveSelection.limits.x, 0.01)}
                  step={0.01}
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>垂直位置</span>
                  <span>{Math.round(adaptiveSelection.fit.offsetY * 100)}%</span>
                </div>
                <Slider
                  value={[adaptiveSelection.fit.offsetY]}
                  onValueChange={([value]) => applyAdaptiveFit({ offsetY: value })}
                  min={-Math.max(adaptiveSelection.limits.y, 0.01)}
                  max={Math.max(adaptiveSelection.limits.y, 0.01)}
                  step={0.01}
                />
              </div>
            </div>
          ) : null}
        </CoPanelSection>
      ) : (
        <CoPanelSection
          variant="flat"
          title="选中项"
          description={
            selectedSlotIndex === null
              ? '点击画布里的图片，可以单独调整它的大小和位置。'
              : `正在单独调整第 ${selectedSlotIndex + 1} 张图。`
          }
        >
          {selectedSlot && selectedSlotIndex !== null ? (
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>缩放</span>
                  <span>{selectedSlot.scale.toFixed(2)}x</span>
                </div>
                <Slider
                  value={[selectedSlot.scale]}
                  onValueChange={([value]) => updateSlot(selectedSlotIndex, { scale: value })}
                  min={1}
                  max={3}
                  step={0.01}
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>水平位置</span>
                  <span>{Math.round(selectedSlot.offsetX)}px</span>
                </div>
                <Slider
                  value={[selectedSlot.offsetX]}
                  onValueChange={([value]) => updateSlot(selectedSlotIndex, { offsetX: value })}
                  min={-180}
                  max={180}
                  step={1}
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>垂直位置</span>
                  <span>{Math.round(selectedSlot.offsetY)}px</span>
                </div>
                <Slider
                  value={[selectedSlot.offsetY]}
                  onValueChange={([value]) => updateSlot(selectedSlotIndex, { offsetY: value })}
                  min={-180}
                  max={180}
                  step={1}
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>旋转</span>
                  <span>{Math.round(selectedSlot.rotation)}deg</span>
                </div>
                <Slider
                  value={[selectedSlot.rotation]}
                  onValueChange={([value]) => updateSlot(selectedSlotIndex, { rotation: value })}
                  min={-45}
                  max={45}
                  step={1}
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>圆角</span>
                  <span>{selectedSlot.borderRadius ?? present.canvas.borderRadius}px</span>
                </div>
                <Slider
                  value={[selectedSlot.borderRadius ?? present.canvas.borderRadius]}
                  onValueChange={([value]) =>
                    updateSlot(selectedSlotIndex, { borderRadius: value })
                  }
                  min={0}
                  max={48}
                  step={1}
                />
              </div>
            </div>
          ) : null}
        </CoPanelSection>
      )}
    </div>
  );
}
