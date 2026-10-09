import type { RefObject } from 'react';
import type { TemplateBackground } from '@/features/template/background';
import { TemplateRuntime } from '@/features/template/runtime';
import type { ExifData } from '@/platform';
import { TemplateBackgroundFrame } from './template-background-frame';

/**
 * 一次后台导出的渲染任务。
 *
 * 配置是启动导出时的快照：任务跑在后台，用户随时可能继续改模板 / 参数 / 背景，
 * 导出必须严格按启动那一刻的配置渲染（见 `docs/features.md` §3.7）。
 */
export interface ExportRenderJob {
  /** 任务标识，写进 DOM 供就绪轮询匹配，避免抓到上一任务的旧布局 */
  id: string;
  photoUrl: string;
  exif: ExifData | null;
  /** 启动导出时的配置快照，不随后续编辑变化 */
  config: {
    templateId: string;
    params: Record<string, unknown>;
    background: TemplateBackground;
  };
}

interface ExportRenderNodeProps {
  job: ExportRenderJob | null;
  nodeRef: RefObject<HTMLDivElement | null>;
}

/**
 * 离屏导出渲染节点。
 *
 * 与预览用同一套 `TemplateBackgroundFrame` + `TemplateRuntime`，只换宿主：
 * 固定定位到视口外渲染，导出尺寸解算与抓图都发生在这里，预览区 DOM 全程
 * 不被改写——预览不跳变，用户可以继续操作。
 *
 * 两个关键点：
 * - `visibility: visible` 显式覆盖隐藏页（`app.tsx` 切走的页面是 `invisible`）的
 *   继承值，否则切页后这个节点会随页面一起不可见，抓到空图；
 * - 挂载时机由外层控制：`job` 为 null 时整体卸载，下一任务重新挂载，
 *   配合 `data-co-export-job` 轮询确认新布局已提交再抓图。
 */
export function ExportRenderNode({ job, nodeRef }: ExportRenderNodeProps) {
  if (!job) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: '-100000px',
        visibility: 'visible',
        pointerEvents: 'none',
      }}
    >
      <div ref={nodeRef} data-co-export-job={job.id}>
        <TemplateBackgroundFrame background={job.config.background} photoUrl={job.photoUrl}>
          <TemplateRuntime
            templateId={job.config.templateId}
            photoUrl={job.photoUrl}
            exif={job.exif}
            params={job.config.params}
          />
        </TemplateBackgroundFrame>
      </div>
    </div>
  );
}

/**
 * 等待离屏节点提交到目标任务的布局。
 *
 * 状态回写到 DOM 是异步的，`waitForImages` / 探针必须在新任务的节点上执行，
 * 否则会量到上一任务残留的旧尺寸。就绪判定按 `data-co-export-job` 匹配任务 id，
 * 并要求节点已连接；超时抛错交给上层按单张失败跳过。
 */
export async function waitForExportNode(
  nodeRef: RefObject<HTMLDivElement | null>,
  jobId: string,
  timeoutMs = 10_000,
): Promise<HTMLElement> {
  const deadline = performance.now() + timeoutMs;

  for (;;) {
    const element = nodeRef.current;
    if (element?.isConnected && element.dataset.coExportJob === jobId) {
      return element;
    }
    if (performance.now() > deadline) {
      throw new Error('导出渲染节点未就绪，已跳过该照片');
    }
    // 定时轮询而非 rAF：窗口被遮挡时 rAF 会节流，后台导出不能因此卡住
    await new Promise((resolve) => {
      setTimeout(resolve, 16);
    });
  }
}
