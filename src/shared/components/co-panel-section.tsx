import { ChevronDown, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/shared/ui/tooltip';

interface CoPanelSectionProps {
  /** 分区标题；`card` 变体下标题所在区域整块都是折叠触发区。 */
  title: string;
  /** 分区说明。不占版面，挂在标题右侧的 info 图标上，悬浮或聚焦时显示。 */
  description?: string;
  /** 默认是否展开（仅 `card` 有效）；折叠时只留头部。`flat` 常驻展开。 */
  defaultOpen?: boolean;
  /** 头部右侧的附加操作：`card` 排在折叠箭头左边，`flat` 排在标题行右端；均不参与折叠触发。 */
  actions?: ReactNode;
  /**
   * 外观：
   * - `card`（默认）：可折叠卡片，字段多的时候逐片收起，避免一路滚到底；
   * - `flat`：无边框平铺分区，内容常驻展开，由父容器 `divide-y` 用横线分隔——调整面板使用。
   */
  variant?: 'card' | 'flat';
  children: ReactNode;
}

/**
 * 侧边属性面板里的一片子面板，共用标题与 info 气泡。
 *
 * 说明文字不铺在版面上，收进标题后的 info 图标里；同时留一份 `sr-only`
 * 副本，保证读屏仍能读到（气泡只在悬浮/聚焦时挂载）。
 *
 * - `card`：带边框卡片与折叠箭头（导出预设弹窗等沿用）；
 * - `flat`：调整面板的分区形态——去掉卡片壳，标题与内容平铺在面板里，
 *   分区之间由父容器的横线（`divide-y`）分割。
 */
export function CoPanelSection({
  title,
  description,
  defaultOpen = true,
  actions,
  variant = 'card',
  children,
}: CoPanelSectionProps) {
  const info = description ? (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0 items-center text-muted-foreground transition-colors hover:text-foreground">
            <Info aria-hidden="true" className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-56">
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : null;
  const srOnly = description ? <span className="sr-only">{description}</span> : null;

  if (variant === 'flat') {
    return (
      <section className="px-3 py-3">
        <div className="flex items-start gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="text-sm font-semibold">{title}</span>
            {info}
          </span>
          {srOnly}
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>
        <div className="pt-2">{children}</div>
      </section>
    );
  }

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="group/panel border border-border/80 bg-background/70 shadow-sm"
    >
      <div className="flex items-start gap-2 px-4 py-4">
        <CollapsibleTrigger className="flex min-w-0 flex-1 flex-col items-start text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="text-sm font-semibold">{title}</span>
            {info}
          </span>
          {srOnly}
        </CollapsibleTrigger>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        <ChevronDown
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/panel:rotate-180"
        />
      </div>
      <CollapsibleContent>
        <div className="px-4 pb-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
