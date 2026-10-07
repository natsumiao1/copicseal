import { createExportTask, getExportTaskState } from '@/platform';

export async function runScheduledExports<T>({
  items,
  runner,
  onProgress,
  onTaskCreated,
}: {
  items: T[];
  runner: (item: T, index: number) => Promise<void>;
  onProgress?: (completed: number, total: number) => void;
  /** 任务创建后立刻回调：UI 拿到 taskId 才能在运行中调用 `cancelExportTask` */
  onTaskCreated?: (taskId: string) => void;
}) {
  const taskId = createExportTask(items.length);
  onTaskCreated?.(taskId);

  for (let index = 0; index < items.length; index += 1) {
    const state = getExportTaskState(taskId);
    if (state?.cancelled) {
      break;
    }

    await runner(items[index], index);
    onProgress?.(index + 1, items.length);
  }

  return taskId;
}
