import { LayoutGrid } from 'lucide-react';
import { useState } from 'react';
import { COLLAGE_LAYOUT_COUNT, COLLAGE_LAYOUT_GROUPS } from '@/features/collage/layouts';
import { COLLAGE_GRID_UNITS } from '@/features/collage/lib';
import { useCollageStore } from '@/features/collage/store/use-collage-store';
import type { CollageLayoutSlot } from '@/features/collage/types';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { ScrollArea } from '@/shared/ui/scroll-area';

interface LayoutThumbnailProps {
  slots: CollageLayoutSlot[];
  className?: string;
}

/**
 * 布局缩略图：把 12×12 槽位表按比例画进小方框。
 *
 * 槽位用绝对定位的百分比坐标（x/12、w/12），与画布同一套单位，
 * 因此缩略图和真实排布永远一致；边框画在盒子内部（border-box），
 * 相邻槽位自然留出细缝，不会糊成一块。
 */
function LayoutThumbnail({ slots, className }: LayoutThumbnailProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('relative h-10 w-full overflow-hidden rounded-[3px] bg-muted/40', className)}
    >
      {/* 槽位坐标在每个布局内唯一（已验证 54 个布局无重复），直接用坐标作 key */}
      {slots.map((slot) => (
        <span
          key={`${slot.x}-${slot.y}`}
          className="absolute border border-background bg-foreground/25"
          style={{
            left: `${(slot.x / COLLAGE_GRID_UNITS) * 100}%`,
            top: `${(slot.y / COLLAGE_GRID_UNITS) * 100}%`,
            width: `${(slot.w / COLLAGE_GRID_UNITS) * 100}%`,
            height: `${(slot.h / COLLAGE_GRID_UNITS) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

interface CollageLayoutPickerProps {
  /** 当前布局不在工具栏快捷预设里时，让触发按钮保持按下态，提示「选的是库里的布局」。 */
  active?: boolean;
}

/**
 * 布局库：把 layouts.ts 里的全部预设按「可容纳图片数」分组展示，
 * 每项带缩略图，点选后画布切到该布局并关闭弹窗。
 *
 * 工具栏只保留 2/3/4/6 宫格快捷键，其余布局从这里进，
 * 避免 50+ 个选项把工具栏挤爆。
 */
export function CollageLayoutPicker({ active = false }: CollageLayoutPickerProps) {
  const [open, setOpen] = useState(false);
  // 与工具栏同理：只订阅两个原始值，画布每次提交（拖动 / 滑杆）都不必重渲整个弹层
  const layoutMode = useCollageStore((state) => state.present.canvas.layoutMode);
  const currentLayoutId = useCollageStore((state) => state.present.layoutId);
  const setLayout = useCollageStore((state) => state.setLayout);
  const updateCanvas = useCollageStore((state) => state.updateCanvas);

  const handlePick = (layoutId: string) => {
    // 与工具栏快捷预设同一套动作：先回 grid 模式再换布局
    updateCanvas({ layoutMode: 'grid' });
    setLayout(layoutId);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={active ? 'default' : 'outline'} size="sm" aria-haspopup="dialog">
          <LayoutGrid data-icon="inline-start" />
          布局库
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>布局库</DialogTitle>
          <DialogDescription>
            共 {COLLAGE_LAYOUT_COUNT} 种预设，按可容纳的图片数量分组；选中后画布切换到该布局。
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-[420px] max-h-[60vh]">
          <div className="space-y-5 pe-3">
            {COLLAGE_LAYOUT_GROUPS.map(({ group, layouts }) => (
              <section key={group}>
                <h3 className="text-xs font-semibold text-muted-foreground">{group}</h3>
                <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {layouts.map((layout) => {
                    const selected = layoutMode === 'grid' && currentLayoutId === layout.id;

                    return (
                      <button
                        key={layout.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => handlePick(layout.id)}
                        className={cn(
                          'flex flex-col items-center gap-1.5 border px-2 py-2 transition-colors outline-none',
                          selected
                            ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                            : 'border-border hover:border-primary/40 focus-visible:border-primary/40',
                        )}
                      >
                        <LayoutThumbnail slots={layout.slots} className="w-full" />
                        <span
                          className={cn(
                            'text-[10px] leading-4',
                            selected ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {layout.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
