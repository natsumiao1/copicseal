import { Copy, Layers, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { type DragEvent, useState } from 'react';
import { ExportPresetDialog } from '@/shared/components/export-preset-dialog';
import { BusinessWorkbenchPropertiesPane } from '@/shared/layouts/business-workbench';
import {
  createExportPresetProfile,
  describeExportPreset,
  nextExportPresetName,
} from '@/shared/lib/export-preset-profile';
import { cn } from '@/shared/lib/utils';
import { useExportPresetStore } from '@/shared/store/use-export-preset-store';
import type { ExportPresetProfile } from '@/shared/types/export';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/shared/ui/tooltip';

/** 触发导出的来源：素材区拖入的照片 / 行内主按钮 / 行内「导出全部」。 */
export type ExportPresetTrigger =
  | { kind: 'photo'; path: string }
  | { kind: 'single' }
  | { kind: 'all' };

/** 进行中的导出任务：挂在对应预设行上显示进度与取消。 */
export interface ExportPresetRunState {
  /** 任务所属预设；进度与转圈只出现在这一行 */
  presetId: string;
  completed: number;
  total: number;
  /** 调度器创建后回填，取消走它 */
  taskId: string | null;
}

interface CoExportPresetPanelProps {
  /** 触发一次导出；照片拖拽的语义由页面解释（水印页导那张照片，拼图页导画布） */
  onExport: (profile: ExportPresetProfile, trigger: ExportPresetTrigger) => void;
  /** 取消进行中的导出（多张之间生效） */
  onCancel: () => void;
  /** 进行中的任务；null 表示空闲 */
  run: ExportPresetRunState | null;
  /** 行内是否提供「导出全部照片」；拼图画布没有批量语义时传 false */
  showExportAll?: boolean;
  /** 行内主按钮提示：边框水印「导出当前照片」、拼图「导出画布」 */
  singleLabel?: string;
  /** 未选中照片时禁用导出类动作（导出当前 / 导出全部）；编辑 / 复制 / 删除不受影响 */
  disabled?: boolean;
}

/** 拖拽源（素材区缩略图）写入的自定义 MIME 类型，值为文件路径。 */
const PHOTO_DRAG_TYPE = 'text/copicseal-photo-id';

interface PresetRowProps {
  profile: ExportPresetProfile;
  run: CoExportPresetPanelProps['run'];
  busy: boolean;
  /** 未选中照片：只禁用导出类动作，编辑 / 复制 / 删除不受影响 */
  disabled: boolean;
  showExportAll: boolean;
  singleLabel: string;
  onExport: CoExportPresetPanelProps['onExport'];
  onCancel: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

/** 一行预设：名字 + 参数摘要 + 拖放目标；操作按钮常显在第二行，进行中换成进度。 */
function PresetRow({
  profile,
  run,
  busy,
  disabled,
  showExportAll,
  singleLabel,
  onExport,
  onCancel,
  onEdit,
  onDuplicate,
  onRemove,
}: PresetRowProps) {
  const [dragOver, setDragOver] = useState(false);
  const running = run?.presetId === profile.id ? run : null;
  const locked = busy && !running;
  /** 导出类动作要求选中照片；编辑 / 复制 / 删除只受全局进行中约束 */
  const exportDisabled = disabled || locked;
  const manageDisabled = locked;

  const acceptsDrag = (event: DragEvent) => event.dataTransfer.types.includes(PHOTO_DRAG_TYPE);

  const iconButton =
    'size-7 data-[icon=inline-start]:size-3.5 text-muted-foreground hover:text-foreground';

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 整行是照片拖放目标，操作按钮在内层
    <div
      className={cn(
        'px-3 py-2.5 transition-colors',
        // 拍平后没有卡片边框，拖入反馈改用底色 + 内嵌描边
        dragOver && 'bg-primary/5 ring-1 ring-inset ring-primary/50',
      )}
      onDragOver={(event) => {
        if (!acceptsDrag(event)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        const path = event.dataTransfer.getData(PHOTO_DRAG_TYPE);
        setDragOver(false);
        if (!path) {
          return;
        }
        event.preventDefault();
        onExport(profile, { kind: 'photo', path });
      }}
    >
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-foreground">{profile.name}</div>
        <div className="truncate text-[10px] leading-4 text-muted-foreground">
          {describeExportPreset(profile)}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        {running ? (
          <>
            <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
            <span className="min-w-0 flex-1 truncate text-[10px] tabular-nums text-muted-foreground">
              已导出 {running.completed} / {running.total}
            </span>
            {running.total > 1 ? (
              <button
                type="button"
                className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] transition-colors hover:border-border hover:text-foreground"
                onClick={onCancel}
              >
                取消
              </button>
            ) : null}
          </>
        ) : (
          <TooltipProvider>
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={iconButton}
                    disabled={exportDisabled}
                    onClick={() => onExport(profile, { kind: 'single' })}
                  >
                    <Play data-icon="inline-start" />
                    <span className="sr-only">{singleLabel}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{singleLabel}</TooltipContent>
              </Tooltip>

              {showExportAll ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className={iconButton}
                      disabled={exportDisabled}
                      onClick={() => onExport(profile, { kind: 'all' })}
                    >
                      <Layers data-icon="inline-start" />
                      <span className="sr-only">导出全部照片</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">导出全部照片</TooltipContent>
                </Tooltip>
              ) : null}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={iconButton}
                    disabled={manageDisabled}
                    onClick={onEdit}
                  >
                    <Pencil data-icon="inline-start" />
                    <span className="sr-only">编辑预设</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">编辑预设</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={iconButton}
                    disabled={manageDisabled}
                    onClick={onDuplicate}
                  >
                    <Copy data-icon="inline-start" />
                    <span className="sr-only">复制预设</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">复制预设</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn(iconButton, 'hover:text-destructive')}
                    disabled={manageDisabled}
                    onClick={onRemove}
                  >
                    <Trash2 data-icon="inline-start" />
                    <span className="sr-only">删除预设</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">删除预设</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}

/**
 * 导出面板的主体：命名预设列表。
 *
 * 「新建预设」是列表首行，其下是已有预设。行是拖放目标——素材区的照片拖到
 * 行上即按该预设导出；操作按钮常显在行内第二行左侧：导出当前 / 导出全部
 * 要求选中照片，编辑 / 复制 / 删除随时可用（仅受全局进行中约束）。
 * 进行中的任务显示在所属行内，全局同时只跑一个。
 */
export function CoExportPresetPanel({
  onExport,
  onCancel,
  run,
  showExportAll = true,
  singleLabel = '导出当前',
  disabled = false,
}: CoExportPresetPanelProps) {
  const presets = useExportPresetStore((state) => state.presets);
  const upsertPreset = useExportPresetStore((state) => state.upsertPreset);
  const removePreset = useExportPresetStore((state) => state.removePreset);
  const duplicatePreset = useExportPresetStore((state) => state.duplicatePreset);
  /** 非 null 表示新建 / 编辑弹窗开着；新建时是刚生成的空预设 */
  const [editing, setEditing] = useState<ExportPresetProfile | null>(null);

  const busy = run !== null;

  const handleRemove = (profile: ExportPresetProfile) => {
    if (window.confirm(`删除预设「${profile.name}」？`)) {
      removePreset(profile.id);
    }
  };

  return (
    <BusinessWorkbenchPropertiesPane>
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y divide-border/60">
          <div className="px-3 py-3">
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start border-dashed text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={() =>
                setEditing({
                  ...createExportPresetProfile(),
                  name: nextExportPresetName(presets),
                })
              }
            >
              <Plus data-icon="inline-start" />
              新建预设
            </Button>
          </div>

          {presets.length === 0 ? (
            <p className="px-3 py-3 text-xs leading-6 text-muted-foreground">
              还没有预设。点「新建预设」配置一套导出参数，之后把照片拖到预设上即可导出。
            </p>
          ) : (
            presets.map((profile) => (
              <PresetRow
                key={profile.id}
                profile={profile}
                run={run}
                busy={busy}
                disabled={disabled}
                showExportAll={showExportAll}
                singleLabel={singleLabel}
                onExport={onExport}
                onCancel={onCancel}
                onEdit={() => setEditing(profile)}
                onDuplicate={() => duplicatePreset(profile.id)}
                onRemove={() => handleRemove(profile)}
              />
            ))
          )}

          {presets.length > 0 ? (
            <p className="px-3 py-2.5 text-[11px] leading-5 text-muted-foreground">
              把素材区的照片拖到预设上，即可按该预设导出当前页的内容。
            </p>
          ) : null}
        </div>
      </ScrollArea>

      {editing ? (
        <ExportPresetDialog
          profile={editing}
          onCancel={() => setEditing(null)}
          onSave={(next) => {
            upsertPreset(next);
            setEditing(null);
          }}
        />
      ) : null}
    </BusinessWorkbenchPropertiesPane>
  );
}
