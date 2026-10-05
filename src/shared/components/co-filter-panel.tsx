import { Check, ChevronDown, ChevronRight, Loader2, Star } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import {
  COLOR_LABEL_TEXT,
  COLOR_LABELS,
  type ColorLabel,
  collectAvailability,
  collectTagCounts,
  type FilterCriteria,
  hasCriteria,
  matchesFilter,
  resolveCriteria,
  STAR_LEVELS,
} from '@/shared/lib/image-filter';
import { cn } from '@/shared/lib/utils';
import { useFileSourceStore } from '@/shared/store/use-file-source-store';
import { type FilterSectionKey, useFilterStore } from '@/shared/store/use-filter-store';

/** 五种颜色标签的色块底色（对应 XMP Label 的标准取值）。 */
const COLOR_LABEL_BG: Record<ColorLabel, string> = {
  red: 'bg-red-500',
  yellow: 'bg-yellow-400',
  green: 'bg-green-500',
  blue: 'bg-blue-500',
  purple: 'bg-purple-500',
};

/** 条件区标题（点击折叠 / 展开）。 */
function SectionHeader({
  title,
  collapsed,
  onToggle,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      className="mb-1.5 flex w-full items-center gap-0.5 rounded text-[10px] font-medium tracking-wide text-muted-foreground transition-colors hover:text-foreground"
      onClick={onToggle}
    >
      {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
      {title}
    </button>
  );
}

/** 统一的条件行：复选框 + 名称 + （数量）。 */
function FilterRow({
  active,
  label,
  count,
  title,
  onToggle,
}: {
  active: boolean;
  label: ReactNode;
  count: ReactNode;
  title?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/60"
      onClick={onToggle}
    >
      <span
        className={cn(
          'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors',
          active ? 'border-primary bg-primary text-primary-foreground' : 'border-border/70',
        )}
      >
        {active ? <Check className="size-2.5" /> : null}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

/** 长宽比标签 `w:h` → 数值（w/h），用于同数量时的排序。 */
function ratioSortValue(label: string): number {
  const [width, height] = label.split(':').map(Number);
  return height ? width / height : Number.POSITIVE_INFINITY;
}

/**
 * 筛选器面板（文件夹栏下方）：按星级（1-5 星）、五种颜色标签、长宽比与
 * 文件类型过滤内容面板的直览列表。条件持久化，标签数据按目录从 XMP 只读获取。
 *
 * 四个条件区都是「复选框 + 名称 + （数量）」的多选行：类型 / 长宽比按当前
 * 目录实际存在的取值罗列，星级 / 标签固定五项、数量取自 XMP；数量一律是目录
 * 总数（不随其它条件变化），标签未就绪时显示 `…`。每个区的标题可点击折叠，
 * 折叠状态持久化。
 *
 * 本栏是停靠布局里的「筛选器」面板，标题与移动由面板 tab 条承担；
 * 命中数与内容面板用同一套 `resolveCriteria` + `matchesFilter`，两边结果一致。
 */
export function CoFilterPanel() {
  const folderPath = useFileSourceStore((state) => state.folderPath);
  const entries = useFileSourceStore((state) => state.entries);
  const entriesStatus = useFileSourceStore((state) => state.entriesStatus);

  const ratings = useFilterStore((state) => state.ratings);
  const labels = useFilterStore((state) => state.labels);
  const types = useFilterStore((state) => state.types);
  const ratios = useFilterStore((state) => state.ratios);
  const collapsedSections = useFilterStore((state) => state.collapsedSections);
  const tags = useFilterStore((state) => state.tags);
  const tagsStatus = useFilterStore((state) => state.tagsStatus);
  const tagsFolder = useFilterStore((state) => state.tagsFolder);
  const toggleRating = useFilterStore((state) => state.toggleRating);
  const toggleLabel = useFilterStore((state) => state.toggleLabel);
  const toggleType = useFilterStore((state) => state.toggleType);
  const toggleRatio = useFilterStore((state) => state.toggleRatio);
  const toggleCollapsedSection = useFilterStore((state) => state.toggleCollapsedSection);
  const clearCriteria = useFilterStore((state) => state.clearCriteria);

  const criteria: FilterCriteria = useMemo(
    () => ({ ratings, labels, types, ratios }),
    [labels, ratings, ratios, types],
  );
  const availability = useMemo(() => collectAvailability(entries), [entries]);
  const tagCounts = useMemo(() => collectTagCounts(entries, tags), [entries, tags]);
  /** 类型行按扩展名排序；长宽比行按数量降序（同数量按比值升序） */
  const typeRows = useMemo(
    () => [...availability.types.entries()].sort(([a], [b]) => a.localeCompare(b)),
    [availability],
  );
  const ratioRows = useMemo(
    () =>
      [...availability.ratios.entries()].sort(
        ([labelA, countA], [labelB, countB]) =>
          countB - countA || ratioSortValue(labelA) - ratioSortValue(labelB),
      ),
    [availability],
  );

  const tagsReady = tagsStatus === 'ready' && tagsFolder === folderPath;
  const tagsPending = tagsStatus === 'loading' && tagsFolder === folderPath;
  /** 星级 / 标签数量已知：目录枚举完成，且标签读完（或目录里没有图片） */
  const tagCountsKnown = entriesStatus === 'ready' && (tagsReady || entries.length === 0);
  /** 星级 / 标签行的数量文本；读取中显示 `…` 占位 */
  const tagCountText = (value: number | undefined): string =>
    tagCountsKnown ? `（${value ?? 0}）` : '（…）';
  const criteriaActive = hasCriteria(criteria);

  const matchCount = useMemo(() => {
    const resolved = resolveCriteria(criteria, availability, tagsReady);
    return entries.filter((entry) => matchesFilter(entry, resolved, tags)).length;
  }, [availability, criteria, entries, tags, tagsReady]);

  const isCollapsed = (section: FilterSectionKey): boolean => collapsedSections.includes(section);

  if (entriesStatus === 'idle' && !folderPath) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1.5 px-4 text-center">
        <p className="text-xs font-medium text-foreground">未选择文件夹</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          在文件夹栏选择目录后，
          <br />
          可按星级、标签、长宽比与文件类型筛选。
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-xs">
      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-3 py-2.5">
        <section>
          <SectionHeader
            title="星级"
            collapsed={isCollapsed('rating')}
            onToggle={() => toggleCollapsedSection('rating')}
          />
          {!isCollapsed('rating') ? (
            <div className="space-y-px">
              {STAR_LEVELS.map((level) => (
                <FilterRow
                  key={level}
                  active={ratings.includes(level)}
                  title={`${level} 星`}
                  count={tagCountText(tagCounts.ratings.get(level))}
                  label={
                    <span className="flex items-center gap-1">
                      <Star className="size-3 shrink-0 fill-current text-amber-500" />
                      {level} 星
                    </span>
                  }
                  onToggle={() => toggleRating(level)}
                />
              ))}
            </div>
          ) : null}
        </section>

        <section>
          <SectionHeader
            title="标签"
            collapsed={isCollapsed('label')}
            onToggle={() => toggleCollapsedSection('label')}
          />
          {!isCollapsed('label') ? (
            <div className="space-y-px">
              {COLOR_LABELS.map((label) => (
                <FilterRow
                  key={label}
                  active={labels.includes(label)}
                  title={COLOR_LABEL_TEXT[label]}
                  count={tagCountText(tagCounts.labels.get(label))}
                  label={
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'size-3 shrink-0 rounded-sm border border-border/50',
                          COLOR_LABEL_BG[label],
                        )}
                      />
                      {COLOR_LABEL_TEXT[label]}
                    </span>
                  }
                  onToggle={() => toggleLabel(label)}
                />
              ))}
            </div>
          ) : null}
        </section>

        <section>
          <SectionHeader
            title="长宽比"
            collapsed={isCollapsed('ratio')}
            onToggle={() => toggleCollapsedSection('ratio')}
          />
          {!isCollapsed('ratio') ? (
            ratioRows.length === 0 ? (
              <p className="px-1 text-[11px] text-muted-foreground">
                {entriesStatus === 'ready'
                  ? entries.length > 0
                    ? '照片长宽未知'
                    : '当前文件夹没有图片'
                  : '正在读取文件夹…'}
              </p>
            ) : (
              <div className="space-y-px">
                {ratioRows.map(([ratio, count]) => (
                  <FilterRow
                    key={ratio}
                    active={ratios.includes(ratio)}
                    count={`（${count}）`}
                    label={ratio}
                    onToggle={() => toggleRatio(ratio)}
                  />
                ))}
              </div>
            )
          ) : null}
        </section>

        <section>
          <SectionHeader
            title="文件类型"
            collapsed={isCollapsed('type')}
            onToggle={() => toggleCollapsedSection('type')}
          />
          {!isCollapsed('type') ? (
            typeRows.length === 0 ? (
              <p className="px-1 text-[11px] text-muted-foreground">
                {entriesStatus === 'ready' ? '当前文件夹没有图片' : '正在读取文件夹…'}
              </p>
            ) : (
              <div className="space-y-px">
                {typeRows.map(([type, count]) => (
                  <FilterRow
                    key={type}
                    active={types.includes(type)}
                    count={`（${count}）`}
                    label={<span className="uppercase">{type}</span>}
                    onToggle={() => toggleType(type)}
                  />
                ))}
              </div>
            )
          ) : null}
        </section>
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-border/80 px-3 py-2">
        {tagsPending ? (
          <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            正在读取标签…
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[10px] tabular-nums text-muted-foreground">
            {entriesStatus === 'ready'
              ? criteriaActive
                ? `命中 ${matchCount} / ${entries.length}`
                : `${entries.length} 张图片`
              : '—'}
          </p>
          <button
            type="button"
            disabled={!criteriaActive}
            className="shrink-0 rounded border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            onClick={clearCriteria}
          >
            清除筛选
          </button>
        </div>
      </div>
    </div>
  );
}
