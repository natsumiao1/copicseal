import { Grid2x2, Grid3x3, LayoutGrid, Trash2, Type } from 'lucide-react';
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
  // 只订阅用到的原始值：整份 store 会让工具栏在每次画布提交（拖动、滑杆连打）时
  // 都跟着重渲，而它真正关心的只有布局模式与布局 id 两个值。
  const layoutMode = useCollageStore((state) => state.present.canvas.layoutMode);
  const layoutId = useCollageStore((state) => state.present.layoutId);
  const hasAdaptiveTree = useCollageStore((state) => state.present.adaptiveTree !== null);
  const setLayout = useCollageStore((state) => state.setLayout);
  const updateCanvas = useCollageStore((state) => state.updateCanvas);
  const clearAdaptiveCanvas = useCollageStore((state) => state.clearAdaptiveCanvas);
  const addAnnotation = useCollageStore((state) => state.addAnnotation);

  // 当前布局来自布局库而非上面的快捷预设时，让「布局库」按钮保持按下态
  const libraryActive =
    layoutMode === 'grid' && !GRID_PRESETS.some((preset) => preset.layoutId === layoutId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {GRID_PRESETS.map((preset) => {
        const Icon = preset.icon;
        const active = layoutMode === 'grid' && layoutId === preset.layoutId;

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
        variant={layoutMode === 'free' ? 'default' : 'outline'}
        size="sm"
        onClick={() => updateCanvas({ layoutMode: 'free' })}
      >
        自由布局
      </Button>

      <Button
        variant={layoutMode === 'adaptive' ? 'default' : 'outline'}
        size="sm"
        onClick={() => updateCanvas({ layoutMode: 'adaptive' })}
      >
        自适应
      </Button>

      {/* 添加文字标注：新增后自动选中，属性面板切换到「文字」区块编辑；
          空画布（无照片）不渲染预览层，标注无处落脚，先禁用 */}
      <Button
        variant="outline"
        size="sm"
        disabled={photos.length === 0}
        onClick={() => addAnnotation('text')}
      >
        <Type data-icon="inline-start" />
        添加文字
      </Button>

      {/* 只在自适应模式提供清空：grid 有自动填充（清了会被重新填满），free 恒显示全部照片 */}
      {layoutMode === 'adaptive' ? (
        <Button
          variant="outline"
          size="sm"
          disabled={!hasAdaptiveTree}
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
