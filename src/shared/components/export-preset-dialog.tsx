import { type ReactNode, useState } from 'react';
import { openDirectoryDialog } from '@/platform';
import { CoPanelSection } from '@/shared/components/co-panel-section';
import {
  EXPORT_CONFLICT_LABELS,
  EXPORT_DESTINATION_LABELS,
  EXPORT_FIT_AXIS_LABELS,
} from '@/shared/lib/export-preset-profile';
import type {
  ExportConflictStrategy,
  ExportDestination,
  ExportFitAxis,
  ExportFormat,
  ExportPresetProfile,
} from '@/shared/types/export';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { RadioGroup, RadioGroupItem } from '@/shared/ui/radio-group';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';
import { Slider } from '@/shared/ui/slider';
import { Switch } from '@/shared/ui/switch';

/** 把文本框里的整数收敛到区间；空/非法回落到默认值。 */
function clampInt(text: string, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

/** 表单字段：标题在上，控件在下。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
    </div>
  );
}

interface ExportPresetDialogProps {
  /** 要编辑的预设；新建时传刚生成的空预设 */
  profile: ExportPresetProfile;
  onCancel: () => void;
  /** 确认保存（同 id 覆盖） */
  onSave: (profile: ExportPresetProfile) => void;
}

/**
 * 新建 / 编辑导出预设的弹窗：名称 + 存储 / 取消，下面四个可折叠分区——
 * 存储选项、图像格式、图像调整尺寸、元数据。
 *
 * 与 Lightroom 风格的导出预设对话框对齐；分辨率、重采样方法、元数据模板与
 * Content Credentials 属于本期缺口（见 docs/TODO.md），不在弹窗内出现。
 */
export function ExportPresetDialog({ profile, onCancel, onSave }: ExportPresetDialogProps) {
  const [draft, setDraft] = useState<ExportPresetProfile>(profile);

  // 尺寸意图的三种形态各自独立存文本，保存时才收敛成数字：
  // 输入框的中间态（空串、半个数字）不该把草稿弄成非法值
  const [mode, setMode] = useState<'scale' | 'fit'>(profile.sizing.mode);
  const [percentText, setPercentText] = useState(
    String(profile.sizing.mode === 'scale' ? profile.sizing.percent : 100),
  );
  const [fitAxis, setFitAxis] = useState<ExportFitAxis>(
    profile.sizing.mode === 'fit' ? profile.sizing.axis : 'long',
  );
  const [pxText, setPxText] = useState(
    String(profile.sizing.mode === 'fit' ? profile.sizing.px : 2000),
  );
  const [noUpscale, setNoUpscale] = useState(
    profile.sizing.mode === 'fit' ? profile.sizing.noUpscale : false,
  );

  const [subfolderOn, setSubfolderOn] = useState(Boolean(profile.subfolder));
  const [subfolderText, setSubfolderText] = useState(profile.subfolder ?? '');

  /** 选「自定义…」立刻打开目录选择器；取消时受控值没变，下拉自动回退。 */
  const handleDestinationChange = (value: string) => {
    if (value === 'custom') {
      void openDirectoryDialog().then((path) => {
        if (path) {
          setDraft((prev) => ({ ...prev, destination: 'custom', customPath: path }));
        }
      });
      return;
    }
    setDraft((prev) => ({ ...prev, destination: value as ExportDestination }));
  };

  const handleBrowse = () => {
    void openDirectoryDialog().then((path) => {
      if (path) {
        setDraft((prev) => ({ ...prev, customPath: path }));
      }
    });
  };

  const handleSave = () => {
    onSave({
      ...draft,
      name: draft.name.trim() || '未命名预设',
      quality: clampInt(String(draft.quality), 1, 100, 90),
      subfolder: subfolderOn ? subfolderText.trim() || null : null,
      sizing:
        mode === 'scale'
          ? { mode: 'scale', percent: clampInt(percentText, 1, 1000, 100) }
          : {
              mode: 'fit',
              axis: fitAxis,
              px: clampInt(pxText, 16, 60000, 2000),
              noUpscale,
            },
      // 关掉「包含原始元数据」时位置信息无处可剥，顺手清掉避免下次打开看着矛盾
      stripGps: draft.includeExif && draft.stripGps,
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent className="max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">导出预设</DialogTitle>

        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">预设</span>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              取消
            </Button>
            <Button type="button" size="sm" onClick={handleSave}>
              存储
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="co-export-preset-name" className="shrink-0 text-xs text-muted-foreground">
            名称
          </label>
          <Input
            id="co-export-preset-name"
            value={draft.name}
            placeholder="预设名称"
            onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
          />
        </div>

        <ScrollArea className="max-h-[55vh]">
          <div className="space-y-3 pb-1">
            <CoPanelSection title="存储选项">
              <div className="space-y-3">
                <Field label="存储至">
                  <Select value={draft.destination} onValueChange={handleDestinationChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="app-dir">
                        {EXPORT_DESTINATION_LABELS['app-dir']}
                      </SelectItem>
                      <SelectItem value="source-dir">
                        {EXPORT_DESTINATION_LABELS['source-dir']}
                      </SelectItem>
                      {/* 始终保留该项让已选中的自定义值有文案可显示；选它会重新打开目录选择器 */}
                      <SelectItem value="custom">自定义…</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                {draft.destination === 'custom' ? (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                      {draft.customPath ?? '尚未选择目录'}
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={handleBrowse}>
                      浏览…
                    </Button>
                  </div>
                ) : null}

                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">存储到子文件夹</span>
                  <Switch checked={subfolderOn} onCheckedChange={setSubfolderOn} />
                </div>
                <Input
                  value={subfolderText}
                  disabled={!subfolderOn}
                  placeholder="子文件夹名"
                  onChange={(event) => setSubfolderText(event.target.value)}
                />

                <Field label="管理冲突">
                  <Select
                    value={draft.conflict}
                    onValueChange={(value) =>
                      setDraft((prev) => ({
                        ...prev,
                        conflict: value as ExportConflictStrategy,
                      }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unique-name">
                        {EXPORT_CONFLICT_LABELS['unique-name']}
                      </SelectItem>
                      <SelectItem value="overwrite">{EXPORT_CONFLICT_LABELS.overwrite}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </CoPanelSection>

            <CoPanelSection title="图像格式">
              <div className="space-y-3">
                <Field label="格式">
                  <Select
                    value={draft.format}
                    onValueChange={(value) =>
                      setDraft((prev) => ({ ...prev, format: value as ExportFormat }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="jpeg">JPEG（.jpg）</SelectItem>
                      <SelectItem value="png">PNG（.png）</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                {draft.format === 'jpeg' ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-foreground">图像品质</span>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {draft.quality}
                      </span>
                    </div>
                    <Slider
                      value={[draft.quality]}
                      onValueChange={([value]) => setDraft((prev) => ({ ...prev, quality: value }))}
                      min={1}
                      max={100}
                      step={1}
                    />
                  </div>
                ) : null}
              </div>
            </CoPanelSection>

            <CoPanelSection title="图像调整尺寸">
              <RadioGroup
                value={mode}
                onValueChange={(value) => setMode(value as 'scale' | 'fit')}
                className="space-y-2"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="scale" id="co-sizing-scale" />
                  <label htmlFor="co-sizing-scale" className="text-xs text-foreground">
                    缩放图像
                  </label>
                  <Input
                    type="number"
                    className="ml-auto w-24 text-right"
                    value={percentText}
                    disabled={mode !== 'scale'}
                    onChange={(event) => setPercentText(event.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="fit" id="co-sizing-fit" />
                    <label htmlFor="co-sizing-fit" className="text-xs text-foreground">
                      调整大小至
                    </label>
                  </div>
                  <div className="flex items-center gap-2 pl-6">
                    <Select
                      value={fitAxis}
                      onValueChange={(value) => setFitAxis(value as ExportFitAxis)}
                    >
                      <SelectTrigger size="sm" className="w-24" disabled={mode !== 'fit'}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(EXPORT_FIT_AXIS_LABELS) as ExportFitAxis[]).map((axis) => (
                          <SelectItem key={axis} value={axis}>
                            {EXPORT_FIT_AXIS_LABELS[axis]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      className="w-24 text-right"
                      value={pxText}
                      disabled={mode !== 'fit'}
                      onChange={(event) => setPxText(event.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">像素</span>
                  </div>
                  <div className="flex items-center gap-2 pl-6">
                    <Switch
                      checked={noUpscale}
                      disabled={mode !== 'fit'}
                      onCheckedChange={setNoUpscale}
                    />
                    <span className="text-xs text-foreground">不放大</span>
                    <span className="text-[10px] text-muted-foreground">不超出照片原始像素</span>
                  </div>
                </div>
              </RadioGroup>
            </CoPanelSection>

            <CoPanelSection title="元数据">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground">包含原始元数据</div>
                    <div className="text-[10px] text-muted-foreground">保留相机与拍摄参数</div>
                  </div>
                  <Switch
                    checked={draft.includeExif}
                    onCheckedChange={(checked) =>
                      setDraft((prev) => ({ ...prev, includeExif: checked }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground">删除位置信息</div>
                    <div className="text-[10px] text-muted-foreground">抹掉 EXIF 里的 GPS</div>
                  </div>
                  <Switch
                    checked={draft.stripGps}
                    disabled={!draft.includeExif}
                    onCheckedChange={(checked) =>
                      setDraft((prev) => ({ ...prev, stripGps: checked }))
                    }
                  />
                </div>
              </div>
            </CoPanelSection>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
