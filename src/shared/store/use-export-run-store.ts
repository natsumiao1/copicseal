import { create } from 'zustand';

/**
 * 进行中的导出任务：全局同时只跑一个。
 *
 * 进度是三方共用的一份数据——顶栏进度胶囊（`CoExportProgressPill`）、导出面板的
 * 所属预设行（`CoExportPresetPanel` 按 `presetId` 挂进度）、以及两页各自的导出
 * 流程（写入方）。导出转到后台后用户可能切到其它页面，状态因此收敛在这里，
 * 而不是散在页面组件的 `useState` 里。
 */
export interface ExportPresetRunState {
  /** 任务所属预设；行内进度与转圈只出现在这一行 */
  presetId: string;
  completed: number;
  total: number;
  /**
   * 调度器创建后回填，取消走它（`cancelExportTask`）。
   * 未接入调度器的任务（拼图单张画布导出）恒为 null。
   */
  taskId: string | null;
}

interface ExportRunStoreState {
  /** 进行中的导出；null 表示空闲 */
  run: ExportPresetRunState | null;
  /** 整体写入：开始导出时回填初始值、结束（含取消）时置 null */
  setRun: (run: ExportPresetRunState | null) => void;
  /** 局部更新：推进进度、回填 taskId；空闲时忽略，避免竞态写入脏状态 */
  patchRun: (patch: Partial<ExportPresetRunState>) => void;
}

export const useExportRunStore = create<ExportRunStoreState>()((set) => ({
  run: null,
  setRun: (run) => set({ run }),
  patchRun: (patch) => set((state) => (state.run ? { run: { ...state.run, ...patch } } : state)),
}));
