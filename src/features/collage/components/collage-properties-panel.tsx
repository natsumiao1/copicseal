import { useEffect, useMemo, useState } from 'react';
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
import type { AdaptivePhotoFit } from '@/features/collage/types';
import { CoPanelSection } from '@/shared/components/co-panel-section';
import { usePhotos } from '@/shared/hooks/use-photos';
import { Input } from '@/shared/ui/input';
import { Slider } from '@/shared/ui/slider';

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

export function CollagePropertiesPanel() {
  const {
    present,
    selectedSlotIndex,
    selectedAdaptivePhotoId,
    updateCanvas,
    updateSlot,
    setAdaptivePhotoFit,
  } = useCollageStore();
  const { photos } = usePhotos();

  const selectedSlot =
    selectedSlotIndex !== null ? (present.slotItems[selectedSlotIndex] ?? null) : null;

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
