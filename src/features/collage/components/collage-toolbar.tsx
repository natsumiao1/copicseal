import { Grid2x2, Grid3x3, LayoutGrid, Trash2 } from 'lucide-react';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import { usePhotos } from '@/shared/hooks/use-photos';
import { Button } from '@/shared/ui/button';
import { CollageLayoutPicker } from './collage-layout-picker';

const GRID_PRESETS = [
  { label: '2 宫格', layoutId: 'two-columns', icon: Grid2x2 },
  { label: '3 宫格', layoutId: 'three-columns', icon: Grid3x3 },
  { label: '4 宫格', layoutId: 'four-grid', icon: LayoutGrid },
  { label: '6 宫格', layoutId: 'six-grid', icon: LayoutGrid },
] as const;

function getAutoLayoutId(photoCount: number) {
  if (photoCount >= 6) {
    return 'six-grid';
  }
  if (photoCount === 5) {
    return 'five-top-two-bottom-three';
  }
  if (photoCount === 4) {
    return 'four-grid';
  }
  if (photoCount === 3) {
    return 'three-columns';
  }
  if (photoCount === 2) {
    return 'two-columns';
  }

  return 'solo-full';
}

export function CollageToolbar() {
  const { photos } = usePhotos();
  const { present, setLayout, updateCanvas, clearAdaptiveCanvas } = useCollageStore();

  // 当前布局来自布局库而非上面的快捷预设时，让「布局库」按钮保持按下态
  const libraryActive =
    present.canvas.layoutMode === 'grid' &&
    !GRID_PRESETS.some((preset) => preset.layoutId === present.layoutId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {GRID_PRESETS.map((preset) => {
        const Icon = preset.icon;
        const active = present.canvas.layoutMode === 'grid' && present.layoutId === preset.layoutId;

        return (
          <Button
            key={preset.layoutId}
            variant={active ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              updateCanvas({ layoutMode: 'grid' });
              setLayout(preset.layoutId);
            }}
          >
            <Icon data-icon="inline-start" />
            {preset.label}
          </Button>
        );
      })}

      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          updateCanvas({ layoutMode: 'grid' });
          setLayout(getAutoLayoutId(photos.length));
        }}
      >
        自动排版
      </Button>

      <CollageLayoutPicker active={libraryActive} />

      <Button
        variant={present.canvas.layoutMode === 'free' ? 'default' : 'outline'}
        size="sm"
        onClick={() => updateCanvas({ layoutMode: 'free' })}
      >
        自由布局
      </Button>

      <Button
        variant={present.canvas.layoutMode === 'adaptive' ? 'default' : 'outline'}
        size="sm"
        onClick={() => updateCanvas({ layoutMode: 'adaptive' })}
      >
        自适应
      </Button>

      {/* 只在自适应模式提供清空：grid 有自动填充（清了会被重新填满），free 恒显示全部照片 */}
      {present.canvas.layoutMode === 'adaptive' ? (
        <Button
          variant="outline"
          size="sm"
          disabled={!present.adaptiveTree}
          title="清空画布上的全部照片（只清画布，不删除文件）"
          onClick={clearAdaptiveCanvas}
        >
          <Trash2 data-icon="inline-start" />
          清空画布
        </Button>
      ) : null}
    </div>
  );
}
