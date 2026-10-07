import { COLLAGE_RATIO_OPTIONS } from '@/features/collage/lib';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import { CoPanelSection } from '@/shared/components/co-panel-section';
import { Input } from '@/shared/ui/input';
import { Slider } from '@/shared/ui/slider';

export function CollagePropertiesPanel() {
  const { present, selectedSlotIndex, updateCanvas, updateSlot } = useCollageStore();

  const selectedSlot =
    selectedSlotIndex !== null ? (present.slotItems[selectedSlotIndex] ?? null) : null;

  const isAdaptive = present.canvas.layoutMode === 'adaptive';

  return (
    <div className="divide-y divide-border/60">
      <CoPanelSection variant="flat" title="布局" description="控制画布布局、间距与背景样式。">
        <div className="space-y-4">
          <div>
            <span className="text-xs font-medium text-foreground">画布比例</span>
            {isAdaptive ? (
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                跟随内容：由照片按布局自动推导，无留白、无裁切。
              </p>
            ) : (
              <div className="mt-2 grid grid-cols-3 gap-2">
                {COLLAGE_RATIO_OPTIONS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => updateCanvas({ aspectPreset: item.label })}
                    className={`border px-3 py-2 text-xs ${
                      present.canvas.aspectPreset === item.label
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-border'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
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

      {isAdaptive ? null : (
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
