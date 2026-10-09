import { Loader2, X } from 'lucide-react';
import { cancelExportTask } from '@/platform';
import { useExportRunStore } from '@/shared/store/use-export-run-store';

/**
 * 顶栏导出进度胶囊：挂在视图菜单左侧，任何页面都能看到当前导出进度。
 *
 * 与预设行内进度共用 `useExportRunStore` 的同一份任务状态——行内那份属于
 * 所属预设，这份是全局视角：导出转后台后用户可以切页 / 编辑，进度不该只
 * 留在导出面板里。空闲时不渲染任何节点，不占顶栏位置。
 */
export function CoExportProgressPill() {
  const run = useExportRunStore((state) => state.run);

  if (run === null) {
    return null;
  }

  const percent = run.total > 0 ? (run.completed / run.total) * 100 : 0;
  const { taskId } = run;
  const canCancel = taskId !== null && run.total > 1;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={run.total}
      aria-valuenow={run.completed}
      aria-label="导出进度"
      className="flex h-9 items-center gap-2 rounded-xl border border-primary/30 bg-card px-3 text-xs shadow-sm"
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
      <div className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-border/60">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="tabular-nums text-muted-foreground">
        {run.completed} / {run.total}
      </span>
      {canCancel && taskId !== null ? (
        <button
          type="button"
          aria-label="取消导出"
          className="flex size-5 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          onClick={() => void cancelExportTask(taskId)}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
