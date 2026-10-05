import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { useWindowStyle } from '@/shared/providers/window-style-provider';

interface CoWindowHeaderProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actions?: ReactNode;
}

export function CoWindowHeader({ icon: Icon, title, description, actions }: CoWindowHeaderProps) {
  const { frameMode } = useWindowStyle();

  return (
    <div
      data-tauri-drag-region={frameMode === 'frameless' ? true : undefined}
      className="relative flex items-center gap-3 border-b border-border/80 bg-background/96 px-4 py-2.5 backdrop-blur-sm"
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-3"
        data-tauri-drag-region={frameMode === 'frameless' ? true : undefined}
      >
        <div
          className="pointer-events-none flex size-9 shrink-0 items-center justify-center border border-border/80 bg-card text-primary shadow-sm"
          data-tauri-drag-region={frameMode === 'frameless' ? true : undefined}
        >
          <Icon className="size-4" />
        </div>
        <div
          className="pointer-events-none min-w-0"
          data-tauri-drag-region={frameMode === 'frameless' ? true : undefined}
        >
          <h1
            className="truncate text-sm font-semibold tracking-tight text-foreground"
            data-tauri-drag-region={frameMode === 'frameless' ? true : undefined}
          >
            {title}
          </h1>
          <p
            className="truncate text-[11px] text-muted-foreground"
            data-tauri-drag-region={frameMode === 'frameless' ? true : undefined}
          >
            {description}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2" data-tauri-drag-region="false">
        {actions}
      </div>
    </div>
  );
}
